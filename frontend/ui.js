var statusElement = document.getElementById('status');
var progressElement = document.getElementById('progress');
var spinnerElement = document.getElementById('spinner');

var Module = {
  noInitialRun: true,
  onRuntimeInitialized: function() {
    console.log('runtime initialised');
    setWindowTitle=()=>{}; //prevent SDL changing window title
    preload.then(machineConfig => {
      let configName = machineConfig.getMachineType();
      console.log('calling main...(' + fps + ',' + configName + ')');
      callMain([fps.toString(), configName]);
      console.log('calling main done');
      if (machineConfig.fastForward) {
        arc_fast_forward(machineConfig.fastForward);
      }
    })
  },
  preRun: [],
  postRun: [],
  logReadFiles: true,
  locateFile: file => file + '?' + ARCULATOR_BUILD_TAG,
  print: (function() {
    var element = document.getElementById('output');
    if (element) element.value = ''; // clear browser cache
    return function(text) {
      if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
      // These replacements are necessary if you render to raw HTML
      //text = text.replace(/&/g, "&amp;");
      //text = text.replace(/</g, "&lt;");
      //text = text.replace(/>/g, "&gt;");
      //text = text.replace('\n', '<br>', 'g');
      console.log(text);
      if (element) {
        element.value += text + "\n";
        element.scrollTop = element.scrollHeight; // focus on bottom
      }
    };
  })(),

  canvas: (function() {
    var canvas = document.getElementById('canvas');

    // As a default initial behavior, pop up an alert when webgl context is lost. To make your
    // application robust, you may want to override this behavior before shipping!
    // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
    canvas.addEventListener("webglcontextlost", function(e) { alert('WebGL context lost. You will need to reload the page.'); e.preventDefault(); }, false);

    return canvas;
  })(),

  setStatus: function(text) {
    if (!Module.setStatus.last) Module.setStatus.last = { time: Date.now(), text: '' };
    if (text === Module.setStatus.last.text) return;
    var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
    var now = Date.now();
    if (m && now - Module.setStatus.last.time < 30) return; // if this is a progress update, skip it if too soon
    Module.setStatus.last.time = now;
    Module.setStatus.last.text = text;
    if (m) {
      text = m[1];
      progressElement.value = parseInt(m[2])*100;
      progressElement.max = parseInt(m[4])*100;
      progressElement.hidden = false;
      spinnerElement.hidden = false;
    } else {
      progressElement.value = null;
      progressElement.max = null;
      progressElement.hidden = true;
      if (!text) spinnerElement.style.display = 'none';
    }
    statusElement.innerHTML = text;
  },

  totalDependencies: 0,

  monitorRunDependencies: function(left) {
    this.totalDependencies = Math.max(this.totalDependencies, left);
    Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
  }

};

let queryString = '';
if (location.hash)
  queryString = '?' + location.hash.substr(1);

let searchParams = new URLSearchParams(queryString);
let unpackArchivesToHostFS = true;
let firstBoot = true;
let machinePreset = 'a3000';
let fps = 0;

if (searchParams.has('fixedfps')) {
  fps = searchParams.get('fixedfps');
  if (fps != null) {
    fps = parseInt(fps);
  } else {
    fps = 60;
  }
  console.log('UI: Fixing frame rate to ' + fps + ' FPS');
}

if (searchParams.has('showsoftwarebrowser')) {
  addEventListener('load', event => {
    showSoftwareBrowser().then(() => console.log('showsoftwarebrowser=1'));
  });
}

Module.preRun.push(() => ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT ="#canvas" );
Module.preRun.push(monitorAudioContext);

Module.preRun.push(() => {
  let opts = getPageBootParams();
  console.log('page boot params:', opts);
  preload = loadMachineConfig(opts);
});


Module.setStatus('Downloading...');

window.onerror = function(event) {
  // TODO: do not warn on ok events like simulating an infinite loop or exitStatus
  Module.setStatus('Exception thrown, see JavaScript console');
  spinnerElement.style.display = 'none';
  Module.setStatus = function(text) {
    if (text) Module.printErr('[post-exception status] ' + text);
  };
};


function pauseEmulator() {
  ccall('arc_pause_main_thread', null, []);
  document.body.classList.add('emu-paused');
  let emulatorTime = arc_get_emulation_ms();
  console.log('Emulator paused at ', emulatorTime);
}

function resumeEmulator() {
  ccall('arc_resume_main_thread', null, []);
  document.body.classList.remove('emu-paused');
}

function arc_set_display_mode(display_mode) {
  ccall('arc_set_display_mode', null, ['number'], display_mode);
}

function arc_set_dblscan(dbl_scan) {
  ccall('arc_set_dblscan', null, ['number'], dbl_scan);
}

function arc_enter_fullscreen() {
  ccall('arc_enter_fullscreen', null, []);
}

function arc_renderer_reset() {
  ccall('arc_renderer_reset', null, []);
}

function arc_do_reset() {
  ccall('arc_do_reset', null, []);
}

function arc_load_config_and_reset(configName) {
  console.log(`arc_load_config_and_reset ${configName}`);
  ccall('arc_load_config_and_reset', null, ['string'], [configName]);
}

function arc_set_sound_filter(filter) {
  ccall('arc_set_sound_filter', null, ['number'], [filter]);
}

function sdl_enable_mouse_capture() {
  ccall('sdl_enable_mouse_capture', null, []);
}

function sdl_disable_mouse_capture() {
  ccall('sdl_disable_mouse_capture', null, []);
}

function arc_fast_forward(ms) {
  console.log(`Fast-forwaring emulator to ${ms}ms`);
  ccall('arc_fast_forward', null, ['number'], [ms]);
}

function arc_get_emulation_ms() {
  return ccall('arc_get_emulation_ms', 'int', []);
}


function closeModal(id, event = null) {
  if (!event || event && (event.target.classList.contains('modal')  || event.target.classList.contains('modal-content')))
    document.getElementById(id).style.display = 'none';
}



function updateConfigUI(config) {
  let el = document.getElementById('machine-status');
  el.querySelector('.name').textContent = config.getMachineName();
  el.querySelector('.memory').textContent = MEM_SIZE_NAMES[config.getMemory()];
  el.querySelector('.os').textContent = OS_NAMES[config.getOs()];
  el.querySelector('.processor').textContent = CPU_DESCRIPTIONS[config.getProcessor()];
}

function getPageBootParams() {
  let opts = {};

  if (searchParams.has('disc')) {
    opts.disc = searchParams.get('disc');
  }
  if (searchParams.has('basic')) {
    if ('disc' in opts) {
      console.warn("Cannot specify 'disc' and 'basic' params");
    } else {
      let prog = searchParams.get('basic');

      showBasicEditor(prog, createAutobootFile=true);
      opts.autoboot = true;
      opts.fastForward = BASIC_RUN_FAST_FORWARD;
      opts.basic = true;
    }
  }
  if (searchParams.has('preset')) {
    let preset = searchParams.get('preset');
    if (preset in presetMachines) {
      opts.preset = preset;
      machinePreset = preset;
    } else {
      console.warn(`No machine preset named '${preset}'`);
    }
  }
  if (searchParams.has('autoboot')) {
    let autoboot = searchParams.get('autoboot');
    if (!autoboot) {
      autoboot = true;
    }
    opts.autoboot = autoboot;
  }
  if (searchParams.has('ff')) {
    let ff = parseInt(searchParams.get('ff'));
    if (!isNaN(ff)) {
      opts.fastForward = ff;
    } else {
      console.warn('Invalid ff value: ', searchParams.get('ff'));
    }
  }
  if (searchParams.has('soundfilter')) {
    let sf = parseInt(searchParams.get('soundfilter'));
    if (sf >= 0 && sf <= 2) {
      opts.soundFilter = sf;
    } else {
      console.warn(`Invalid value for sound-filter - must be 0 (full), 1 (reduced) or 2 (more reduced)`);
    }
  }
  return opts;
}

/**
 * This is called both at page load and when we change machine from the UI
 * @returns
 */
async function loadMachineConfig(_opts=null) {
  let opts = {
    autoboot: false,
    disc: null,
    preset: 'a3000',
    fastForward: 0,
    basic: null,
    soundFilter: -1,
    basic: false
  }
  if (_opts) {
    Object.assign(opts, _opts);
  }

  let discFile = ''; // if a floppy image is specifed this will be set
  let autoboot = '';
  let softwareMeta = null;

  if (opts.disc) {
    if (opts.disc.includes('/')) { // it's a URL
        console.log(`UI: Loading disc URL ${opts.disc}`);
        discFile = await loadSoftwareFromUrl(opts.disc, insert=false);
    } else { // assume it's an ID from the software catalog
      console.log(`UI: Load software ID ${opts.disc}`);
      discFile = await loadFromSoftwareCatalogue(opts.disc, insert=false);
      softwareMeta = software[opts.disc];
      let recommendedPreset = recommendMachinePreset(softwareMeta);
      if (recommendedPreset != machinePreset) {
        console.log(`UI: Recommended machine for ${opts.disc} is ${recommendedPreset}`);
        if ('preset' in _opts) {
          console.warn("ignoring recommended preset and using ", _opts.preset);
        } else {
          machinePreset = recommendedPreset;
          opts.preset = machinePreset;
        }
      }
    }
  }
  if (opts.preset) {
    machinePreset = opts.preset;
  }

  if (opts.autoboot) {
    if (opts.autoboot === true && softwareMeta) {
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
    } else {
      autoboot = opts.autoboot;
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
  bootedToBasic = opts.basic;

  let machineConfig = builder.build();
  updateConfigUI(machineConfig);
  putConfigFile(machineConfig);
  putCmosFile(machineConfig);
  await loadRoms(machineConfig);
  try {
    FS.mkdir('/hostfs');
  } catch (e) {
    console.log('hostfs dir already exists');
  }
  if (autoboot && !opts.basic) {
    console.log('UI: create !boot:' + autoboot);
    createHostfsBootFile(autoboot, FILETYPE_OBEY);
  }
  window.currentMachineConfig = machineConfig;
  return machineConfig;
}


function showModal(id) {
  let el = document.getElementById(id);
  el.style.display = 'flex';
  return el;
}

async function showBooleanDialog(title, text, trueText='OK', falseText='Cancel') {
  let modal = showModal('generic-dialog');
  modal.querySelector('h2').textContent = title;
  modal.querySelector('p').textContent = text;
  let buttons = modal.querySelectorAll('button');
  let trueButton = buttons[1];
  let falseButton = buttons[0];

  trueButton.textContent = trueText;
  falseButton.textContent = falseText;
  let promise = new Promise((resolve, reject) => {
    trueButton.onclick = () => resolve(true);
    falseButton.onclick = () => resolve(false);
  });
  let val = await promise;
  closeModal('generic-dialog');
  console.log('clicked', val);
  return val;
}

async function changeMachine(opts) {
  let config = await loadMachineConfig(opts);
  arc_load_config_and_reset(config.getMachineType());
  return config;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}



function arrayBufferToBase64(buffer) {
  let binary = '';
  let bytes = [].slice.call(new Uint8Array(buffer));
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return window.btoa(binary);
}

let machinePresetsPopulated = false;

function showMachinePicker() {
  if (!machinePresetsPopulated) {
    populateMachinePresets();
    machinePresetsPopulated = true;
  }
  showModal('machine-picker');
}

function populateMachinePresets() {
  let list = document.getElementById('machine-list');
  removeAllChildNodes(list);
  for (const [presetId, builderFn] of Object.entries(presetMachines)) {
    let li = document.createElement('li');
    let builder = builderFn();
    li.textContent = builder.configName;
    li.setAttribute('machine-id', presetId);
    if (presetId == machinePreset)
      li.classList.add('selected');
    list.appendChild(li);
  }
}

function previewMachine(e) {
  if (!e.target.nodeName == 'LI' || !e.target.hasAttribute('machine-id'))
    return;
  let liEl = e.target;
  let machineId = liEl.getAttribute('machine-id');
  let pv = document.getElementById('machine-preview');
  document.querySelector('#machine-list .selected').classList.remove('selected');
  liEl.classList.add('selected');
  
  let builder = presetMachines[machineId]();
  let machineType = builder.getMachine()
  pv.querySelector('h3').textContent = builder.configName;
  pv.querySelector('.cpu').textContent = CPU_DESCRIPTIONS[builder.getCpu()];
  pv.querySelector('.os').textContent = OS_NAMES[builder.getRom()];
  pv.querySelector('.memory').textContent = MEM_SIZE_NAMES[builder.getMemory()];
  pv.querySelector('.release-date').textContent = machineInfo[machineType].released;
  pv.querySelector('.price').textContent = machineInfo[machineType].price;
}

/**
 * Called via onclick from machine picker 'boot' button
 */
function bootSelected() {
  let presetId = document.querySelector('#machine-list .selected').getAttribute('machine-id');
  changeMachine({preset:presetId});
  closeModal('machine-picker');
}


function removeAllChildNodes(parent) {
  while (parent.firstChild) {
      parent.removeChild(parent.firstChild);
  }
}


function appendDl(dl, title, description) {
  let dt = document.createElement('dt');
  dt.textContent = title;
  let dd = document.createElement('dd');
  dd.textContent = description;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

async function monitorAudioContext() {
  let audioContext = null;
  while (audioContext == null) {
    let contexts = Object.keys(AL.contexts);
    if (contexts.length < 1) {
      console.log('Audio state: waiting for context');
      await sleep(200);
    } else {
      audioContext = AL.contexts[contexts[0]].audioCtx;
    }
  }
  
  let updateAudioState = function() {
    console.log("Audio state:", audioContext.state);
    if (audioContext.state == 'suspended')
      document.body.classList.add('audio-suspended');
    else
      document.body.classList.remove('audio-suspended');
  }
  audioContext.addEventListener('statechange', updateAudioState);
  updateAudioState();
}

if (searchParams.has('dbglatency')) {
  canvas.addEventListener('mousedown', e => {
    if (!document.pointerLockElement) return;
    document.body.classList.add('dbg-mouseclick');
    //console.log(performance.now(), "JS mousedown");
  });
  canvas.addEventListener('mouseup', e => {
    if (!document.pointerLockElement) return;
    document.body.classList.remove('dbg-mouseclick');
  });
  var mm = 0;
  canvas.addEventListener('mousemove', e => {
    if (!document.pointerLockElement) return;
    let cl = document.body.classList;
    
    if (e.movementX != 0 || e.movementY != 0) {
      if (mm) clearTimeout(mm);
      cl.add('dbg-mousemove');
    }
    mm = setTimeout(() => cl.remove('dbg-mousemove'),20);
  });

  document.body.addEventListener('keydown', e => {
    if (!document.pointerLockElement) return;
    document.body.classList.add('dbg-keypress');
  });
  document.body.addEventListener('keyup', e => {
    if (!document.pointerLockElement) return;
    document.body.classList.remove('dbg-keypress');
  });
/*

http://localhost:8000/#dbglatency&basic=10%20MODE%202%0A20%20*POINTER%0A30%20MOUSE%20ON%0A40%20LX%3D0%3ALY%3D0%3AT%3DTIME%0A50%20REPEAT%0A60%20MOUSE%20X%2CY%2CB%0A70%20PRINT%20%3BTIME-T%3B%22%20%22%3BB%3B%22%20%22%3BX-LX%3B%22%20%22%3BY-LY%0A80%20IF%20B%3E0%20THEN%20COLOUR%200%2CB%20ELSE%20IF%20X-LX%3C%3E0%20THEN%20COLOUR%200%2C5%20ELSE%20COLOUR%200%2C0%0A90%20LX%3DX%3ALY%3DY%0A100%20C%3DINKEY(1)%0A120%20IF%20B%3D1%20THEN%20T%3DTIME%0A130%20UNTIL%200

10 MODE 2
20 *POINTER
30 MOUSE ON
35 DIM Z% 16:!Z%=2:Z%!4=4:Z%!8=1:Z%!12=1
36 SYS "Wimp_SpriteOp",36,0,"ptr_default",1,0,0,Z%,0
40 LX=0:LY=0:T=TIME
50 REPEAT
60 MOUSE X,Y,B
70 PRINT ;TIME-T;" ";B;" ";X-LX;" ";Y-LY
80 IF B>0 THEN COLOUR 0,B ELSE IF X-LX<>0 THEN COLOUR 0,5 ELSE COLOUR 0,0
90 LX=X:LY=Y
100 C=INKEY(1)
120 IF B=1 THEN T=TIME
130 UNTIL 0
*/
}
