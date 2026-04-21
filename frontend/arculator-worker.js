onerror = (message, filename, lineno, colno, error) => {
  console.log('arculator worker', message);
  throw new Error(message + " (" + filename + ":" + lineno + ")");
 }


import { default as ArculatorWasm } from './arculator.js';
import { 
  presetMachines, 
  recommendMachinePreset,
  getAutobootScript,
  MEM_SIZE_NAMES, OS_NAMES, CPU_DESCRIPTIONS, 
  putConfigFile, 
  putCmosFile, 
  loadRoms } from './machine-config.js'
import { loadFromSoftwareCatalogue, fetchSoftwareCatalogue } from './software-browser.js'
import { loadSoftwareFromUrl, createHostfsBootFile, FILETYPE_DESKTOP } from './hostfs.js'

// if we await anything before setting the onmessage handler, messages posted to us 
// aren't queued so get lost. a better alternative to using dynamic import to add the
// build tag might be using a ServiceWorker to transparently handle fetching scripts
// with the correct tag
//const { default: ArculatorWasm } = await import('./arculator.js' + buildTag);

let ARCULATOR_BUILD_TAG = new URL(import.meta.url).search;


console.log('in arculator worker');
let canvas = null;
let arculatorModule = null;


let machinePreset = null;


onmessageerror = (event) => { console.log('worker message error', event); }

onmessage = async (e) => {
  const data = e.data;
  console.log('worker message', data.type);
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
          if (machineConfig.fastForward) {
              arc_fast_forward(machineConfig.fastForward);
          }
          })
      },
      preRun: [function(module) {
          console.log('preRun');
          self.FS = module.FS;
        
      }],
      logReadFiles: true,
      locateFile: file => file + '?' + ARCULATOR_BUILD_TAG,
      print: (function() { 
      
        return function(text) {
          if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
          console.log('worker print', text);
        };
      })(),

      setStatus: function(text) {
        if (!this.setStatus.last) this.setStatus.last = { time: Date.now(), text: '' };
        if (text === this.setStatus.last.text) return;
        var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
        var now = Date.now();
        if (m && now - this.setStatus.last.time < 30) return; // if this is a progress update, skip it if too soon
        this.setStatus.last.time = now;
        this.setStatus.last.text = text;
        if (m) {
          text = m[1];
          let progressVal = parseInt(m[2])*100;
          let progressMax = parseInt(m[4])*100;
          console.log(`worker status ${progressVal}/${progressMax}`)
        } else {
          console.log('hide status element');
          // hide status elements
        }
        console.log('worker status', text);
      },

      totalDependencies: 0,

      monitorRunDependencies: function(left) {
        this.totalDependencies = Math.max(this.totalDependencies, left);
        Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
      }
    });
  }
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
    mouseCapture: null
  }
  if (_opts) {
    Object.assign(opts, _opts);
  }

  let discFile = ''; // if a floppy image is specifed this will be set
  let autoboot = '';
  let softwareMeta = null;

  try {
    FS.mkdir('/hostfs');
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
        postMessage({'changeLocationHash': `#disc=${softwareMeta.id}&autoboot`});
      }
      postMessage({'currentSoftware': softwareMeta});
     
      autoboot = getAutobootScript(softwareMeta);
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
  if (builder.getRom().includes('arthur')) {
    // TODO: can we fix doosmouse() for Arthur?
    console.log('Setting mouse-capture=force for Arthur');
    opts.mouseCapture = 'force';
  }
  if (opts.mouseCapture) {
    if (MOUSE_CAPTURE_MODES.includes(opts.mouseCapture)) {
      getEmuInput().setCaptureMode(MOUSE_CAPTURE_MODES.indexOf(opts.mouseCapture)+1);
    } else {
      console.warn('Invalid value for mouse-capture parameter - must be one of: auto, force, never')
    }
  }
  postMessage({bootedToBasic: opts.basic});

  let machineConfig = builder.build();
  postMessage({updateConfigUI: machineConfig.getUIInfo()});
  putConfigFile(machineConfig);
  putCmosFile(machineConfig);
  await loadRoms(machineConfig);
  
  if (autoboot && !opts.basic) {
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
}

function arc_load_config_and_reset(configName) {
  console.log(`arc_load_config_and_reset ${configName}`);
  arculatorModule.ccall('arc_load_config_and_reset', null, ['string'], [configName]);
}

function arc_set_sound_filter(filter) {
  arculatorModule.ccall('arc_set_sound_filter', null, ['number'], [filter]);
}

function arc_fast_forward(ms) {
  console.log(`Fast-forwaring emulator to ${ms}ms`);
  arculatorModule.ccall('arc_fast_forward', null, ['number'], [ms]);
}

function arc_get_emulation_ms() {
  return arculatorModule.ccall('arc_get_emulation_ms', 'int', []);
}

function arc_enable_sound(enable) {
  arculatorModule.ccall('arc_enable_sound', null, ['int'], [enable ? 1 : 0]);
}