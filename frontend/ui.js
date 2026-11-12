import { initSoftwareBrowser, showSoftwareBrowser, filterSoftware, removeAllChildNodes } from './software-browser-ui.js'
import { presetMachines, machineInfo, CPU_DESCRIPTIONS, OS_NAMES, MEM_SIZE_NAMES } from "./shared/machines.js"
import { getEmuInput } from "./emu_input.js";
import { initEmuInterface } from './emu-interface.js'
import { initBasicEditor, showBasicEditor, wrapProg, setBootedToBasic, BASIC_RUN_FAST_FORWARD } from './editor.js'
import { EmuAudio } from './emu-audio.js'
import { setCliEmu } from './jscli-page.js'
import { connect, transfer } from './shared/rpc.js'
import { Notice, PARAM_HINTS } from './shared/notices.js'
import { MOUSE_CAPTURE_MODES } from './shared/input.js'
import { notify, notifyFailure } from './notify.js'
import { initMediaSession, setMediaSessionAlbum, setMediaSessionPaused } from './media-session.js'
import { initFastForwardOverlay } from './fast-forward-overlay.js'

const DISPLAY_MODES = Object.freeze({
		0: 'DISPLAY_MODE_NO_BORDERS',
    1: 'DISPLAY_MODE_NATIVE_BORDERS',
    2: 'DISPLAY_MODE_TV'
});


let queryString = '';
if (location.hash)
  queryString = '?' + location.hash.substr(1);

let searchParams = new URLSearchParams(queryString);

let firstBoot = true;
let machinePreset = 'a3000';
// Machine the worker last booted: {preset, softwareId, softwareTitle, os, cpu, memory}
let currentMachine = null;
let fps = 0;
let preload = null;

const offscreenCanvas = document.getElementById('canvas').transferControlToOffscreen();

const emuAudio = new EmuAudio(searchParams.has('audiostats'));
initMediaSession({pause: pauseEmulator, resume: resumeEmulator, changeTrack});
initFastForwardOverlay(() => currentMachine?.softwareTitle);

/*Branch-agnostic audio dump hook, used by selenium-scripts/fetch_audio_dump.py
  so that one script works against both the main and worker-refactor branches.
  Returns {state, size, base64}: state is 'off', 'waiting', 'recording' or
  'finished'; size is the current size of the dump in bytes; base64 is the
  complete WAV file and is only populated once state is 'finished', so polling
  stays cheap. Here the dump is captured by the audio worklet, so it only
  starts once the AudioContext is running.*/
window.arcGetAudioDump = function() {
  return emuAudio.getDump();
};

/*Audio glitch counters, so that selenium can assert e.g. "0 underruns during
  the dump". All are cumulative since page load. Returns null until the audio
  has been set up.*/
window.arcAudioStats = function(resetFill = false) {
  return emuAudio.stats(resetFill);
};

// The same over the display, for browsers without a console (e.g. on a phone)
if (searchParams.has('audiostats')) {
  const { startAudioStatsOverlay } = await import('./audio-stats-overlay.js');
  startAudioStatsOverlay(emuAudio);
}

const arculatorWorker = new Worker(new URL('worker/arculator-worker.js', import.meta.url), { type: 'module' });
// emu's methods call the worker's functions; on() listens for its events
const { emu, on } = connect(arculatorWorker);
setCliEmu(emu);

// A command line client on this machine (tools/arcterm.py) to connect to.
// #jscli on its own only puts the JSCLI modules in the support ROM
if (searchParams.get('jscli')) {
  const { startJscliRemote } = await import('./jscli-remote.js');
  startJscliRemote(searchParams.get('jscli'));
}

/*Read and write the emulator's Emscripten FS from scripts (selenium-scripts/
  arcbasic.py). HostFS is under /hostfs, with RISC OS file types as ',xxx'
  suffixes. All return Promises; read gives a Uint8Array (readText a string),
  list gives the names in a directory. A file RISC OS still has open may be
  incomplete, as HostFS buffers writes until it's closed.*/
window.arcFS = {
  read: path => emu.fsRead(path),
  // One character per byte. TextDecoder('latin1') is really Windows-1252
  readText: async path => {
    let bytes = await emu.fsRead(path);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return s;
  },
  write: (path, data) => emu.fsWrite(path, typeof data == 'string' ? new TextEncoder().encode(data) : data),
  list: path => emu.fsList(path),
  unlink: path => emu.fsUnlink(path),
};

/*Screenshot of the emulator display, taken from the next frame it presents.
  Resolves with a PNG Blob, or with the PNG as a base64 string if `base64` is
  set (handy for selenium). It's at the size the canvas shows, without the
  page's overlays. Frames aren't presented while fast-forwarding, so it waits
  until a fast-forward ends.*/
window.arcScreenshot = async function({base64 = false} = {}) {
  let blob = await emu.screenshot();
  return base64 ? new Uint8Array(await blob.arrayBuffer()).toBase64() : blob;
};

/*Run the emulator flat out, without video or sound, for the next `ms` of
  emulated time (like the ff URL parameter, but from now). Calling it again
  before it finishes moves the end point. Resolves once it's started, and
  rejects before the emulator is running.*/
window.arcFastForward = function(ms) {
  return emu.fastForward(ms);
};

/*The emulator doesn't draw anything while the page can't be seen, such as
  when music plays in the background. It runs just the same otherwise, and
  the audio buffers more to ride out the stalls a background page gets.*/
function sendPageHidden() {
  emu.setPageHidden(document.hidden);
  emuAudio.setHidden(document.hidden);
}
document.addEventListener('visibilitychange', sendPageHidden);
sendPageHidden();

/*The music playing, for programs that use the QTMTracker module (see
  qtm-info.js): {title, author, samples, format, tag, channels, loadedFrom,
  ...}, or null. An 'arcmusicinfo' event on window, with it as its detail,
  says when it changes.*/
let musicInfo = null;
window.arcMusicInfo = () => musicInfo;

arculatorWorker.onerror = (event) => {
  console.log('main thread arculatorWorker onerror', event);
}
arculatorWorker.onmessageerror = (event) => {
  console.log('main thread arculatorWorker onmessageerror', event);
}

on('musicInfo', info => {
  musicInfo = info;
  window.dispatchEvent(new CustomEvent('arcmusicinfo', {detail: musicInfo}));
});
/*How far a fast-forward has got, as an 'arcfastforward' event on window.
  Its detail is {startMs, currentMs, targetMs, fraction} (emulated times since
  the last reset, and fraction from 0 to 1) when one starts and about three
  times a second as it runs, then null when it ends (or a reset stops it).*/
on('fastForward', status => {
  window.dispatchEvent(new CustomEvent('arcfastforward', {detail: status}));
});
on('currentSoftware', setCurrentSoftware);
on('updateConfigUI', updateConfigUI);
on('currentMachine', machine => {
  currentMachine = machine;
  machinePreset = currentMachine.preset;
});
on('bootedToBasic', setBootedToBasic);
on('changeLocationHash', changeLocationHash);
// Something to tell the user, such as a disc that couldn't be loaded
on('notice', notify);
on('mouseCapture', mode => getEmuInput().setCaptureMode(MOUSE_CAPTURE_MODES[mode]));

// Messages posted by the emulator's own JS (arculator-wasm/js), not through rpc.js
arculatorWorker.addEventListener('message', ({data}) => {
  switch (data?.type) {
    case 'EmulatorInput': {
      let input = getEmuInput();
      input[data.func].apply(input, data.params);
      break;
    }
    case 'AudioInit':
      emuAudio.init(data);
      break;
  }
});

emu.init(transfer({
  pageBootParams: getPageBootParams(),
  canvas: offscreenCanvas
}, [offscreenCanvas]));


initSoftwareBrowser({
  showModal,
  closeModal,
  changeMachine,
  loadSoftware: softwareId => emu.loadSoftware(softwareId).catch(notifyFailure),
  loadFile,
  getCurrentMachine: () => currentMachine,
  getCurrentSoftwareId: () => currentMachine?.softwareId
});

/**
 * Load a disc image or archive File into the emulator, from drag and drop or
 * the upload button, and say what happened
 */
function loadFile(file) {
  return emu.loadFile(file).then(notices => notices.forEach(notify), notifyFailure);
}

// ui.js is a module, so its functions aren't globals. Expose the ones
// called from inline event handlers in index.html and the classic scripts
Object.assign(window, {
  showModal, closeModal, pauseEmulator, resumeEmulator,
  showMachinePicker, previewMachine, bootSelected,
  showSoftwareBrowser, filterSoftware, loadFile, getEmuInput
});

initEmuInterface({
  resumeEmulator,
  loadFile,
  getCurrentSoftwareId: () => currentMachine?.softwareId
});

initBasicEditor({
  showModal,
  closeModal,
  showBooleanDialog,
  changeMachine,
  getMachinePreset: () => machinePreset
});

if (searchParams.has('showsoftwarebrowser')) {
  addEventListener('load', event => {
    showSoftwareBrowser().then(() => console.log('showsoftwarebrowser=1'));
  });
}



function setCurrentSoftware(softwareMeta) {
    document.title = `${softwareMeta.title} - Archimedes Live!`;
    setMediaSessionAlbum(softwareMeta.title);
}

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

/*Pause the emulator, and its sound. The overlay's button or a click on the
  display resumes it, as do the media controls (media-session.js).*/
function pauseEmulator() {
  emu.setPaused(true);
  emuAudio.setPaused(true);
  document.body.classList.add('emu-paused');
  setMediaSessionPaused(true);
}

function resumeEmulator() {
  emu.setPaused(false);
  emuAudio.setPaused(false);
  document.body.classList.remove('emu-paused');
  setMediaSessionPaused(false);
}

/*Asks the program for the next (dir 1) or previous (-1) song, from the media
  controls. For now this assumes it's one where cursor down or up then Return
  does that, as in the Bitshifters Django demos. Keys are held for 100 ms so
  the program sees them.*/
function changeTrack(dir) {
  if (document.body.classList.contains('emu-paused'))
    resumeEmulator();
  let emu = getEmuInput();
  emu.simulateKey(dir > 0 ? 'ArcArrowDown' : 'ArcArrowUp', 0, 100);
  emu.simulateKey('ArcReturn', 200, 100);
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
      notify({id: Notice.DISC_WITH_BASIC});
    } else {
      let prog = searchParams.get('basic');

      showBasicEditor(prog);
      // The page has no FS, so the worker writes the !Boot that types in the program
      opts.basicBoot = wrapProg(prog);
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
      notify({id: Notice.PRESET_UNKNOWN, params: {preset, machine: presetMachines[machinePreset]().configName}});
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
      invalidParam('ff');
    }
  }
  if (searchParams.has('soundfilter')) {
    let sf = parseInt(searchParams.get('soundfilter'));
    if (sf >= 0 && sf <= 2) {
      opts.soundFilter = sf;
    } else {
      invalidParam('soundfilter');
    }
  }
  if (searchParams.has('dumpaudio')) {
    // dumpaudio=<duration>,<delay> - both in seconds, delay defaults to 0
    let parts = searchParams.get('dumpaudio').split(',');
    let duration = parseFloat(parts[0]);
    let delay = parts.length > 1 ? parseFloat(parts[1]) : 0;
    if (duration > 0 && !isNaN(delay) && delay >= 0) {
      opts.dumpAudio = {duration: duration, delay: delay};
      // The audio worklet needs to allocate the dump's memory before it starts
      emuAudio.expectDump(Math.trunc(duration * 48000));
    } else {
      invalidParam('dumpaudio');
    }
  }
  if (searchParams.has('jscli')) {
    // The JSCLI modules, for the page hooks in jscli-page.js
    opts.jscli = true;
  }
  if (searchParams.has('mouse-capture')) {
    let mouseVal = searchParams.get('mouse-capture');
    if (Object.hasOwn(MOUSE_CAPTURE_MODES, mouseVal)) {
      opts.mouseCapture = mouseVal;
    } else {
      invalidParam('mouse-capture');
    }
  }
  return opts;
}

function invalidParam(param) {
  notify({id: Notice.PARAM_INVALID, params: {param, value: searchParams.get(param), hint: PARAM_HINTS[param]}});
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

/**
 * Reset the emulator with a new configuration. opts are as for
 * getPageBootParams (e.g. {preset}, or {disc, autoboot})
 */
function changeMachine(opts) {
  return emu.changeMachine(opts).catch(notifyFailure);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}



let machinePresetsPopulated = false;

function showMachinePicker() {
  if (!machinePresetsPopulated) {
    populateMachinePresets();
    machinePresetsPopulated = true;
  }
  // The machine may have changed since the list was populated
  for (let li of document.querySelectorAll('#machine-list li')) {
    li.classList.toggle('selected', li.getAttribute('machine-id') == machinePreset);
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
