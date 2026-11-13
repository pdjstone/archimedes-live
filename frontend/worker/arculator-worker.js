onerror = (message, filename, lineno, colno, error) => {
  console.log('arculator worker', message);
  throw new Error(message + " (" + filename + ":" + lineno + ")");
 }


import { default as ArculatorWasm } from './arculator.js';
import { presetMachines, recommendMachinePreset, OS_NAMES, JSCLI_SUPPORT_MODULES } from '../shared/machines.js'
import { getAutobootScript, putConfigFile, putCmosFile, loadRoms, putExtnRom } from './machine-setup.js'
import { loadSoftware, loadSoftwareFromUrl, loadFromSoftwareCatalogue, requireCatalogue, createHostfsBootFile, FILETYPE_DESKTOP, FILETYPE_COMMAND } from './hostfs.js'
import { putDataAtPath, emptyDir } from './fsutil.js'
import { emulator, ready, requireReady, setEmulator, setReady } from './emulator.js'
import { expose, emit, serve, transfer } from '../shared/rpc.js'
import { Notice } from '../shared/notices.js'
import { MOUSE_CAPTURE_MODES } from '../shared/input.js'
import './jscli-worker.js'
import './swi-hook.js'
import { clearMusicInfo } from './qtm-info.js'
import { arc_fast_forward } from './fast-forward.js'


console.log('in arculator worker');
let canvas = null;


let machinePreset = null;
// The JSCLI modules go in every machine's support ROM (#jscli in the page's URL)
let jscliModules = false;





// Errors in async code would otherwise go unseen
onunhandledrejection = (event) => { console.error('arculator worker: unhandled rejection', event.reason); }

onmessageerror = (event) => { console.log('worker message error', event); }

// Paused from the page (pauseEmulator in ui.js)
let userPaused = false;
// The OS of the machine last configured (OS_NAMES in machines.js)
let currentOs = null;

/*Tell the page about a failure it should show (a NoticeError, see
  shared/notices.js), or log one it shouldn't*/
function reportFailure(e) {
  if (e?.notice) {
    console.warn(e.message);
    emit('notice', e.notice);
  } else {
    console.error(e);
  }
}
// The page can't be seen, so the emulator doesn't draw (sendPageHidden in ui.js)
let pageHidden = false;

expose({
  // From ui.js at startup
  init: async ({ canvas, pageBootParams }) => {
    jscliModules = !!pageBootParams.jscli;
    await ArculatorWasm({
      canvas: canvas,
      noInitialRun: true,
      onRuntimeInitialized: function() {
          console.log('runtime initialised');
      
          loadMachineConfig(pageBootParams).then(machineConfig => {
          let configName = machineConfig.getMachineType();
          let fps = 0; // do we want fixed FPS in worker?
          console.log('calling main...(' + fps + ',' + configName + ')');
          this.callMain([fps.toString(), configName]);
          console.log('calling main done');
          arc_set_page_hidden(pageHidden);
          if (machineConfig.fastForward) {
              arc_fast_forward(machineConfig.fastForward);
          }
          if (machineConfig.dumpAudio) {
              arc_dump_audio(machineConfig.dumpAudio.delay, machineConfig.dumpAudio.duration);
          }
          }).catch(reportFailure);
      },
      preRun: [function(module) {
          console.log('preRun');
          setEmulator(module);
      }],
      //logReadFiles: true,
      print: (function() { 
        return function(text) {
          if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
          console.log('worker print', text);
        };
      })(),
    });
    setReady();
  },

  // From pauseEmulator and resumeEmulator in ui.js
  setPaused: paused => {
    if (!ready) return;
    userPaused = paused;
    emulator.ccall(paused ? 'arc_pause_main_thread' : 'arc_resume_main_thread', null, []);
  },
  setPageHidden: hidden => {
    pageHidden = hidden;
    if (ready)
      arc_set_page_hidden(pageHidden);
  },
  fastForward: ms => {
    requireReady();
    arc_fast_forward(Number(arc_get_emulation_ms()) + ms);
  },

  // From the machine picker, software browser and BASIC editor
  changeMachine: opts => whilePaused(async () => {
    let machineConfig = await loadMachineConfig(opts);
    arc_load_config_and_reset(machineConfig.getMachineType());
    if (machineConfig.fastForward) {
      arc_fast_forward(machineConfig.fastForward); // the reset restarted emulation time
    }
  }),
  loadSoftware: softwareId => whilePaused(() => loadFromSoftwareCatalogue(softwareId)),
  // A File from the software browser's upload button or drag and drop.
  // Resolves with the notices to show (shared/notices.js)
  loadFile: file => whilePaused(async () => {
    let { notice, hostfs } = await loadSoftware(file.name, file);
    let notices = [notice];
    if (hostfs && !currentOs?.startsWith('riscos3')) {
      notices.push({id: Notice.HOSTFS_NEEDS_RISC_OS_3, params: {file: file.name, os: OS_NAMES[currentOs] ?? currentOs}});
    }
    return notices;
  }),

  fsRead: path => {
    let bytes = fsCall(path, () => emulator.FS.readFile(path, { encoding: 'binary' }));
    return transfer(bytes, [bytes.buffer]);
  },
  fsWrite: (path, data) => fsCall(path, () => putDataAtPath(data, path)),
  fsList: path => fsCall(path, () => emulator.FS.readdir(path).filter(f => f != '.' && f != '..')),
  fsUnlink: path => fsCall(path, () => emulator.FS.unlink(path)),

  screenshot,
});
serve();

/**
 * Pause the emulator while loading software. The emulator loop shares this
 * worker's event loop, so otherwise it runs a frame at every await in the
 * fetch and unzip, and unpacking an archive takes many seconds
 */
async function whilePaused(fn) {
  if (!ready)
    return fn();   // nothing is running yet
  emulator.ccall('arc_pause_main_thread', null, []);
  try {
    return await fn();
  } finally {
    if (!userPaused)
      emulator.ccall('arc_resume_main_thread', null, []);
  }
}

/**
 * Access to the Emscripten FS (and so HostFS, under /hostfs) from the page,
 * which doesn't have FS itself: the window.arcFS hooks in ui.js. HostFS keeps
 * open files in stdio buffers, so a file RISC OS is still writing may be
 * incomplete until it's closed. Errors say which path, as FS's don't.
 */
function fsCall(path, fn) {
  if (!emulator)
    throw new Error("The emulator's FS doesn't exist yet");
  try {
    return fn();
  } catch (e) {
    throw new Error(e && e.code ? `${e.code} ${path}` : String(e));
  }
}

/**
 * Screenshot of the next frame the emulator presents, as a PNG Blob, for the
 * window.arcScreenshot hook in ui.js. The frame comes straight from the
 * emulator's WebGL canvas (render in js/video.js), so it's at the size the
 * canvas shows, without anything the page draws over it. Frames aren't
 * presented while fast-forwarding, so this waits until that ends. They aren't
 * while the page is hidden either, so one is drawn for this.
 */
function screenshot() {
  if (!ready || !emulator.renderer)
    throw new Error('The emulator display isn\'t running yet');
  if (pageHidden)
    arc_set_page_hidden(false);
  return new Promise((resolve, reject) => {
    (emulator.screenshotRequests ??= []).push(png => {
      arc_set_page_hidden(pageHidden);
      Promise.resolve(png).then(resolve, reject);
    });
  });
}

/**
 * This is called both at page load and when we change machine from the UI
 * @returns
 */
async function loadMachineConfig(_opts=null) {
  let opts = {
    pageBoot: false, // did these options come from the URL hash?
    autoboot: false,
    disc: null,
    preset: 'a3000',
    fastForward: 0,
    basic: null,
    soundFilter: -1,
    basic: false,
    mouseCapture: null,
    dumpAudio: null
  }
  if (_opts) {
    Object.assign(opts, _opts);
  }

  let discFile = ''; // if a floppy image is specifed this will be set
  let autoboot = '';
  let softwareMeta = null;

  try {
    emulator.FS.mkdir('/hostfs');
  } catch (e) {
    console.log('hostfs dir already exists');
  }
  
  // If the disc can't be loaded, say why and boot without it
  if (opts.disc) {
    try {
      if (opts.disc.includes('/')) { // it's a URL
        console.log(`UI: Loading disc URL ${opts.disc}`);
        discFile = (await loadSoftwareFromUrl(opts.disc, false)).disc;
      } else { // assume it's an ID from the software catalog
        console.log(`UI: Load software ID ${opts.disc}`);
        if (opts.autoboot === true) {
          // Launch it on an empty HostFS, as a fresh page load does. Apps left
          // from an earlier title would otherwise be booted by the Filer when
          // the boot commands open HostFS:$, slowing the boot (NewLook's
          // !Boot can outlast the title's fast-forward)
          emptyDir('/hostfs');
        }
        discFile = await loadFromSoftwareCatalogue(opts.disc, false);
        softwareMeta = (await requireCatalogue())[opts.disc];
        let recommendedPreset = recommendMachinePreset(softwareMeta);
        console.log(`UI: Recommended machine for ${opts.disc} is ${recommendedPreset}`);
        if ('preset' in _opts) {
          console.warn("Ignoring recommended machine preset and using ", _opts.preset);
        } else {
          machinePreset = recommendedPreset;
          opts.preset = machinePreset;
        }
      }
    } catch (e) {
      reportFailure(e);
      discFile = '';
      softwareMeta = null;
    }
  }
  if (opts.preset) {
    machinePreset = opts.preset;
  }

  if (opts.autoboot === true) {
    // The catalogue title's own boot commands
    if (softwareMeta) {
   
      if (!opts.pageBoot) { 
        emit('changeLocationHash', `#disc=${softwareMeta.id}&autoboot`);
      }
      emit('currentSoftware', softwareMeta);
     
      autoboot = getAutobootScript(softwareMeta, await requireCatalogue());
      if (!autoboot) {
        emit('notice', {id: Notice.AUTOBOOT_NO_COMMANDS, params: {title: softwareMeta.title}});
      }
      if ('ff-ms' in softwareMeta && opts.fastForward == 0) {
        let ff = softwareMeta['ff-ms'];
        console.log(`${softwareMeta.id} specified a fast-forward of ${ff}ms`);
        opts.fastForward = ff;
      }
      if ('sound-filter' in softwareMeta && opts.soundFilter == -1) {
        opts.soundFilter = softwareMeta['sound-filter'];
      }
      if ('mouse-capture' in softwareMeta && opts.mouseCapture == null) {
        opts.mouseCapture = softwareMeta['mouse-capture'];
      }
    } else if (!opts.basic) {
      console.warn(`Empty autoboot URL specified`);
    }
  } else if (opts.autoboot) {
    autoboot = opts.autoboot + '\n';
  }
  console.log('Loading preset machine: ' + opts.preset);
  let builder = presetMachines[opts.preset]();

  if (discFile) {
    console.log('UI: configure machine with disc', discFile);
    builder.disc(discFile);
  }
  if (autoboot || opts.autoboot === true) { // autoboot URL parameter was specified
    builder.autoboot();
  }
  if (opts.fastForward) {
    builder.fastForward(opts.fastForward);
  }
  if (opts.soundFilter >= 0 && opts.soundFilter <= 2) {
    builder.soundFilter(opts.soundFilter);
  }
  if (opts.dumpAudio) {
    builder.dumpAudio(opts.dumpAudio);
  }
  if (opts.mouseCapture) {
    if (Object.hasOwn(MOUSE_CAPTURE_MODES, opts.mouseCapture)) {
      emit('mouseCapture', opts.mouseCapture);
    } else {
      console.warn(`Invalid mouse-capture '${opts.mouseCapture}': it must be one of ${Object.keys(MOUSE_CAPTURE_MODES).join(', ')}`);
    }
  }
  if (jscliModules) {
    builder.supportModules(...JSCLI_SUPPORT_MODULES);
  }
  emit('bootedToBasic', opts.basic);

  let machineConfig = builder.build();
  currentOs = machineConfig.getOs();
  emit('updateConfigUI', machineConfig.getUIInfo());
  emit('currentMachine', {
    preset: machinePreset,
    softwareId: softwareMeta ? softwareMeta.id : null,
    softwareTitle: softwareMeta ? softwareMeta.title : null,
    os: machineConfig.getOs(),
    cpu: machineConfig.getCpuName(),
    memory: machineConfig.getMemory()
  });
  putConfigFile(machineConfig);
  putCmosFile(machineConfig);
  await loadRoms(machineConfig);
  await putExtnRom(machineConfig);
  
  if (opts.basic && opts.basicBoot) {
    console.log('UI: create BASIC !boot');
    createHostfsBootFile(opts.basicBoot, FILETYPE_COMMAND);
  } else if (autoboot && !opts.basic) {
    console.log('UI: create !boot:' + autoboot);
    createHostfsBootFile(autoboot, FILETYPE_DESKTOP);
  }
  //window.currentMachineConfig = machineConfig;
  return machineConfig;
}

function arc_set_display_mode(display_mode) {
  if (typeof display_mode != "number" || display_mode > 2 || display_mode < 0)
    throw "display_mode must be 0, 1 or 2";
  console.log(`arc_set_display_mode: ${DISPLAY_MODES[display_mode]}`);
  emulator.ccall('arc_set_display_mode', null, ['number'], [display_mode]);
}

function arc_set_dblscan(dbl_scan) {
  emulator.ccall('arc_set_dblscan', null, ['number'], [dbl_scan]);
}


function arc_renderer_reset() {
  emulator.ccall('arc_renderer_reset', null, []);
}

function arc_do_reset() {
  emulator.ccall('arc_do_reset', null, []);
  clearMusicInfo();
}

function arc_load_config_and_reset(configName) {
  console.log(`arc_load_config_and_reset ${configName}`);
  emulator.ccall('arc_load_config_and_reset', null, ['string'], [configName]);
  clearMusicInfo();
}

function arc_set_sound_filter(filter) {
  emulator.ccall('arc_set_sound_filter', null, ['number'], [filter]);
}

function arc_set_page_hidden(hidden) {
  emulator.ccall('arc_set_page_hidden', null, ['number'], [hidden ? 1 : 0]);
}

function arc_get_emulation_ms() {
  return emulator.ccall('arc_get_emulation_ms', 'int', []);
}

function arc_enable_sound(enable) {
  emulator.ccall('arc_enable_sound', null, ['int'], [enable ? 1 : 0]);
}

function arc_dump_audio(delay, duration) {
  console.log(`Dumping ${duration}s of audio after ${delay}s delay`);
  emulator.ccall('arc_dump_audio', null, ['number', 'number'], [delay, duration]);
}
