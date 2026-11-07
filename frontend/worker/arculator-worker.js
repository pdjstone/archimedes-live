onerror = (message, filename, lineno, colno, error) => {
  console.log('arculator worker', message);
  throw new Error(message + " (" + filename + ":" + lineno + ")");
 }


import { default as ArculatorWasm } from './arculator.js';
import { presetMachines, recommendMachinePreset } from '../shared/machines.js'
import { fetchSoftwareCatalogue } from '../shared/software-catalogue.js'
import { getAutobootScript, putConfigFile, putCmosFile, loadRoms } from './machine-setup.js'
import { loadSoftware, loadSoftwareFromUrl, loadFromSoftwareCatalogue, createHostfsBootFile, FILETYPE_DESKTOP, FILETYPE_COMMAND } from './hostfs.js'
import { putDataAtPath } from './fsutil.js'
import { emulator, ready, requireReady, setEmulator, setReady } from './emulator.js'
import { expose, emit, serve, transfer } from '../shared/rpc.js'
import './jscli-worker.js'
import './swi-hook.js'
import { clearMusicInfo } from './qtm-info.js'


console.log('in arculator worker');
let canvas = null;


let machinePreset = null;

const MOUSE_CAPTURE_MODES = Object.freeze(['auto', 'force', 'never']);




// Errors in async code would otherwise go unseen
onunhandledrejection = (event) => { console.error('arculator worker: unhandled rejection', event.reason); }

onmessageerror = (event) => { console.log('worker message error', event); }

// Paused from the page (pauseEmulator in ui.js)
let userPaused = false;
// The page can't be seen, so the emulator doesn't draw (sendPageHidden in ui.js)
let pageHidden = false;

expose({
  // From ui.js at startup
  init: async ({ canvas, pageBootParams }) => {
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
          })
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
  // A File from the software browser's upload button or drag and drop
  loadFile: file => whilePaused(() => loadSoftware(file.name, file)),

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
    await fn();
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
  
  if (opts.disc) {
    if (opts.disc.includes('/')) { // it's a URL
        console.log(`UI: Loading disc URL ${opts.disc}`);
        discFile = await loadSoftwareFromUrl(opts.disc, false);
    } else { // assume it's an ID from the software catalog
      console.log(`UI: Load software ID ${opts.disc}`);
      discFile = await loadFromSoftwareCatalogue(opts.disc, false);
      softwareMeta = (await fetchSoftwareCatalogue())[opts.disc];
      let recommendedPreset = recommendMachinePreset(softwareMeta);
      console.log(`UI: Recommended machine for ${opts.disc} is ${recommendedPreset}`);
      if ('preset' in _opts) {
        console.warn("Ignoring recommended machine preset and using ", _opts.preset);
      } else {
        machinePreset = recommendedPreset;
        opts.preset = machinePreset;
      }
    }
  }
  if (opts.preset) {
    machinePreset = opts.preset;
  }

  if (opts.autoboot) {
    if (opts.autoboot === true && softwareMeta) {
   
      if (!opts.pageBoot) { 
        emit('changeLocationHash', `#disc=${softwareMeta.id}&autoboot`);
      }
      emit('currentSoftware', softwareMeta);
     
      autoboot = getAutobootScript(softwareMeta, await fetchSoftwareCatalogue());
      if (!autoboot) {
        console.warn(`Empty autoboot URL param specified but software ${softwareMeta.id} does not have autoboot app`)
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
    } else {
      autoboot = opts.autoboot + '\n';
    }
    
    if (autoboot == '') {
      console.warn(`Empty autoboot URL specified`);
    }
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
    if (MOUSE_CAPTURE_MODES.includes(opts.mouseCapture)) {
      postMessage({type: 'EmulatorInput', func: 'setCaptureMode', params: [MOUSE_CAPTURE_MODES.indexOf(opts.mouseCapture)+1]});
    } else {
      console.warn('Invalid value for mouse-capture parameter - must be one of: auto, force, never')
    }
  }
  emit('bootedToBasic', opts.basic);

  let machineConfig = builder.build();
  emit('updateConfigUI', machineConfig.getUIInfo());
  emit('currentMachine', {
    preset: machinePreset,
    softwareId: softwareMeta ? softwareMeta.id : null,
    os: machineConfig.getOs(),
    cpu: machineConfig.getCpuName(),
    memory: machineConfig.getMemory()
  });
  putConfigFile(machineConfig);
  putCmosFile(machineConfig);
  await loadRoms(machineConfig);
  
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

function arc_fast_forward(ms) {
  console.log(`Fast-forwaring emulator to ${ms}ms`);
  emulator.ccall('arc_fast_forward', null, ['number'], [ms]);
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
