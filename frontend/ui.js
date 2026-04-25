let buildTag = new URL(import.meta.url).search;  


const { createHostfsBootFile, FILETYPE_DESKTOP } = await import('./hostfs.js' + buildTag);
const { loadFromSoftwareCatalogue, loadSoftwareFromUrl, removeAllChildNodes, showSoftwareBrowser} = await import('./software-browser.js' + buildTag);
import { presetMachines } from "./machine-config.js";
import { getEmuInput } from "./emu_input.js";

const DISPLAY_MODES = Object.freeze({
		0: 'DISPLAY_MODE_NO_BORDERS',
    1: 'DISPLAY_MODE_NATIVE_BORDERS',
    2: 'DISPLAY_MODE_TV'
});

const MOUSE_CAPTURE_MODES = Object.freeze(['auto', 'force', 'never']);


var statusElement = document.getElementById('status');
var progressElement = document.getElementById('progress');
var spinnerElement = document.getElementById('spinner');

let queryString = '';
if (location.hash)
  queryString = '?' + location.hash.substr(1);

let searchParams = new URLSearchParams(queryString);

let firstBoot = true;
let machinePreset = 'a3000';
let fps = 0;
let preload = null;

const offscreenCanvas = document.getElementById('canvas').transferControlToOffscreen();

const arculatorWorker = new Worker('arculator-worker.js' + buildTag, { type: 'module' });

arculatorWorker.onerror = (event) => {
  console.log('main thread arculatorWorker onerror', event);
}
arculatorWorker.onmessageerror = (event) => {
  console.log('main thread arculatorWorker onmessageerror', event);
}
arculatorWorker.onmessage = (event) => {
  // todo: maybe register functions or use worker proxy?
  if ('currentSoftware' in event.data) {
    setCurrentSoftware(event.data.currentSoftware)
  } else if ('updateConfigUI' in event.data) {
    updateConfigUI(event.data.updateConfigUI);
  } else if ('type' in event.data && event.data.type == 'EmulatorInput') {
    console.log('EmulatorInput', event.data);
    let emu = getEmuInput();
    emu[event.data.func].apply(emu, event.data.params);
  } else {
    console.log('main thread arculatorWorker onmessage', event.data);
  }

}


arculatorWorker.postMessage({ 
  type: 'init', 
  pageBootParams: getPageBootParams(), 
  canvas: offscreenCanvas 
}, [offscreenCanvas]);


if (searchParams.has('showsoftwarebrowser')) {
  addEventListener('load', event => {
    showSoftwareBrowser().then(() => console.log('showsoftwarebrowser=1'));
  });
}



function setCurrentSoftware(softwareMeta) {
    document.title = `${softwareMeta.title} - Archimedes Live!`;
}

/*window.onerror = function(event) {
  console.log('window.onerror', event);
  // TODO: do not warn on ok events like simulating an infinite loop or exitStatus
  // Module.setStatus('Exception thrown, see JavaScript console');
  // spinnerElement.style.display = 'none';
  // Module.setStatus = function(text) {
  //   if (text) Module.printErr('[post-exception status] ' + text);
  // };
};*/

let scriptTriggeredHashChange = false;

addEventListener('hashchange', (e) => {
  // If the user changes the URL (hash) then we should reload the page so the new parameters take effect
  // But we don't want to reload if the change was triggerd by our own code
  if (!scriptTriggeredHashChange) {
      console.log(`user changed location hash to ${location.hash}, reloading page`);
      location.reload();
  }
  scriptTriggeredHashChange = false;
});

function changeLocationHash(hash) {
  scriptTriggeredHashChange = true;
  if (hash[0] == '#')
    hash = hash.substr(1);
  // Use assign so that we create a new history entry the use can go back to
  document.location.assign('#' + hash);
}

function pauseEmulator() {
  Module.ccall('arc_pause_main_thread', null, []);
  document.body.classList.add('emu-paused');
  let emulatorTime = arc_get_emulation_ms();
  console.log('Emulator paused at ', emulatorTime);
}

function resumeEmulator() {
  Module.ccall('arc_resume_main_thread', null, []);
  document.body.classList.remove('emu-paused');
}





function closeModal(id, event = null) {
  if (!event || event && 
    (event.target.classList.contains('modal') || event.target.classList.contains('modal-content'))) {
    document.getElementById(id).style.display = 'none';
    document.getElementById('canvas').focus(); // ensure canvas has keyboard focus after closing modal
  }

}



function updateConfigUI(config) {
  let el = document.getElementById('machine-status');
  el.querySelector('.name').textContent = config['name'];
  el.querySelector('.memory').textContent = config['memory'];
  el.querySelector('.os').textContent = config['os'];
  el.querySelector('.processor').textContent = config['processor'];
}

function getPageBootParams() {
  let opts = {pageBoot:true};

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
  if (searchParams.has('mouse-capture')) {
    let mouseVal = searchParams.get('mouse-capture');
    if (MOUSE_CAPTURE_MODES.includes(mouseVal)) {
      opts.mouseCapture = mouseVal;
    } else {
      console.warn('Invalid value for mouse-capture parameter - must be one of: auto, force, never')
    }
  }
  return opts;
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

  // Work aroud a (SDL?) bug where we get a 'divide by zero' error in
  // the SDL function HandleAudioProcess after closing the audio device
  // when changing machines
  // if (typeof Module.SDL2 != 'undefined') {
  //   await Module.SDL2.audioContext.suspend();
  // }
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
    console.log('Audio state: waiting for context');
    await sleep(200);
    if (typeof Module.SDL2 != 'undefined') {
      audioContext = Module.SDL2.audioContext;
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
