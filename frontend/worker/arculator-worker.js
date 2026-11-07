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
import { emulator, setEmulator } from './emulator.js'
import { handleCliRequest, setCliModule } from './jscli-worker.js'
import { setSwiHookModule } from './swi-hook.js'
import { clearMusicInfo } from './qtm-info.js'


console.log('in arculator worker');
let canvas = null;
let arculatorModule = null;


let machinePreset = null;

const MOUSE_CAPTURE_MODES = Object.freeze(['auto', 'force', 'never']);




// Message handlers are async, so their errors would otherwise go unseen
onunhandledrejection = (event) => { console.error('arculator worker: unhandled rejection', event.reason); }

onmessageerror = (event) => { console.log('worker message error', event); }

// Paused from the page (pauseEmulator in ui.js)
let userPaused = false;
// The page can't be seen, so the emulator doesn't draw (sendPageHidden in ui.js)
let pageHidden = false;

onmessage = async (e) => {
  const data = e.data;
  if (data.type === 'fs') {
    handleFsRequest(data);
    return;
  }
  if (data.type === 'cli') {
    handleCliRequest(data);
    return;
  }
  if (data.type === 'screenshot') {
    handleScreenshotRequest(data);
    return;
  }
  if (data.type === 'pause') {
    // From pauseEmulator and resumeEmulator in ui.js
    if (arculatorModule) {
      userPaused = data.paused;
      arculatorModule.ccall(data.paused ? 'arc_pause_main_thread' : 'arc_resume_main_thread', null, []);
    }
    return;
  }
  if (data.type === 'pageHidden') {
    pageHidden = data.hidden;
    if (arculatorModule)
      arc_set_page_hidden(pageHidden);
    return;
  }
  if (data.type === 'fastForward') {
    // arculatorModule is only set once the runtime is initialised
    if (arculatorModule) {
      arc_fast_forward(Number(arc_get_emulation_ms()) + data.ms);
    }
    return;
  }
  console.log('worker message', data.type);
  if (data.type === 'changeMachine') {
    // From the machine picker and software browser
    await whilePaused(async () => {
      let machineConfig = await loadMachineConfig(data.opts);
      arc_load_config_and_reset(machineConfig.getMachineType());
      if (machineConfig.fastForward) {
        arc_fast_forward(machineConfig.fastForward); // the reset restarted emulation time
      }
    });
    return;
  }
  if (data.type === 'loadSoftware') {
    await whilePaused(() => loadFromSoftwareCatalogue(data.softwareId));
    return;
  }
  if (data.type === 'loadFile') {
    // A File from the software browser's upload button or drag and drop
    await whilePaused(() => loadSoftware(data.file.name, data.file));
    return;
  }
  if (data.type === 'init') {
    const { canvas, pageBootParams } = data;
    arculatorModule = await ArculatorWasm({
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
    setCliModule(arculatorModule);
    setSwiHookModule(arculatorModule);
  }
}

/**
 * Pause the emulator while loading software. The emulator loop shares this
 * worker's event loop, so otherwise it runs a frame at every await in the
 * fetch and unzip, and unpacking an archive takes many seconds
 */
async function whilePaused(fn) {
  arculatorModule.ccall('arc_pause_main_thread', null, []);
  try {
    await fn();
  } finally {
    if (!userPaused)
      arculatorModule.ccall('arc_resume_main_thread', null, []);
  }
}

/**
 * Access to the Emscripten FS (and so HostFS, under /hostfs) from the page,
 * which doesn't have FS itself. Used by the window.arcFS hooks in ui.js.
 * HostFS keeps open files in stdio buffers, so a file RISC OS is still
 * writing may be incomplete until it's closed.
 */
function handleFsRequest({ id, op, path, data }) {
  let reply = { type: 'fsReply', id };
  try {
    if (op === 'read') {
      reply.result = emulator.FS.readFile(path, { encoding: 'binary' });
    } else if (op === 'write') {
      putDataAtPath(data, path);
    } else if (op === 'list') {
      reply.result = emulator.FS.readdir(path).filter(f => f != '.' && f != '..');
    } else if (op === 'unlink') {
      emulator.FS.unlink(path);
    } else {
      throw new Error(`Unknown fs op '${op}'`);
    }
  } catch (e) {
    reply.error = String(e && e.code ? `${e.code} ${path}` : e);
  }
  postMessage(reply);
}

/**
 * Screenshot of the next frame the emulator presents, as a PNG Blob, for the
 * window.arcScreenshot hook in ui.js. The frame comes straight from the
 * emulator's WebGL canvas (render in js/video.js), so it's at the size the
 * canvas shows, without anything the page draws over it. Frames aren't
 * presented while fast-forwarding, so this waits until that ends. They aren't
 * while the page is hidden either, so one is drawn for this.
 */
function handleScreenshotRequest({ id }) {
  if (!arculatorModule || !arculatorModule.renderer) {
    postMessage({ type: 'screenshotReply', id, error: 'The emulator display isn\'t running yet' });
    return;
  }
  if (pageHidden)
    arc_set_page_hidden(false);
  (arculatorModule.screenshotRequests ??= []).push(async png => {
    arc_set_page_hidden(pageHidden);
    try {
      postMessage({ type: 'screenshotReply', id, result: await png });
    } catch (e) {
      postMessage({ type: 'screenshotReply', id, error: String(e.message || e) });
    }
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
        postMessage({type: 'changeLocationHash', hash: `#disc=${softwareMeta.id}&autoboot`});
      }
      postMessage({type: 'currentSoftware', softwareMeta});
     
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
  postMessage({type: 'bootedToBasic', basic: opts.basic});

  let machineConfig = builder.build();
  postMessage({type: 'updateConfigUI', config: machineConfig.getUIInfo()});
  postMessage({type: 'currentMachine', machine: {
    preset: machinePreset,
    softwareId: softwareMeta ? softwareMeta.id : null,
    os: machineConfig.getOs(),
    cpu: machineConfig.getCpuName(),
    memory: machineConfig.getMemory()
  }});
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
  arculatorModule.ccall('arc_set_display_mode', null, ['number'], [display_mode]);
}

function arc_set_dblscan(dbl_scan) {
  arculatorModule.ccall('arc_set_dblscan', null, ['number'], [dbl_scan]);
}


function arc_renderer_reset() {
  arculatorModule.ccall('arc_renderer_reset', null, []);
}

function arc_do_reset() {
  arculatorModule.ccall('arc_do_reset', null, []);
  clearMusicInfo();
}

function arc_load_config_and_reset(configName) {
  console.log(`arc_load_config_and_reset ${configName}`);
  arculatorModule.ccall('arc_load_config_and_reset', null, ['string'], [configName]);
  clearMusicInfo();
}

function arc_set_sound_filter(filter) {
  arculatorModule.ccall('arc_set_sound_filter', null, ['number'], [filter]);
}

function arc_fast_forward(ms) {
  console.log(`Fast-forwaring emulator to ${ms}ms`);
  arculatorModule.ccall('arc_fast_forward', null, ['number'], [ms]);
}

function arc_set_page_hidden(hidden) {
  arculatorModule.ccall('arc_set_page_hidden', null, ['number'], [hidden ? 1 : 0]);
}

function arc_get_emulation_ms() {
  return arculatorModule.ccall('arc_get_emulation_ms', 'int', []);
}

function arc_enable_sound(enable) {
  arculatorModule.ccall('arc_enable_sound', null, ['int'], [enable ? 1 : 0]);
}

function arc_dump_audio(delay, duration) {
  console.log(`Dumping ${duration}s of audio after ${delay}s delay`);
  arculatorModule.ccall('arc_dump_audio', null, ['number', 'number'], [delay, duration]);
}
