/**
 * Functions to integrate browser interaction and events with emulator
 */

import { getEmuInput } from './emu_input.js'

let ui = null;

/**
 * @param uiFunctions - from ui.js: resumeEmulator, loadFile and
 *   getCurrentSoftwareId
 */
export function initEmuInterface(uiFunctions) {
  ui = uiFunctions;
  // tryCapture is called by emu_input.js, fullscreen from index.html
  Object.assign(window, { tryCapture, fullscreen });
}

function lockChangeAlert() {
  let locked = document.pointerLockElement === document.getElementById('canvas');
  document.body.classList.toggle('mouse-captured', locked);

  if (locked) {
    console.log('The pointer lock status is now locked');
    
  } else {
    console.log('The pointer lock status is now unlocked');
  }
}

function tryCapture(event) {
  if (document.pointerLockElement)
    return;
  if (document.body.classList.contains('emu-paused')) {
    ui.resumeEmulator();
  }
  document.getElementById('canvas').requestPointerLock();
  if (event && event.ctrlKey)
    document.getElementById('display-container').requestFullscreen();
}

document.addEventListener('pointerlockchange', lockChangeAlert, false);


/**
 * This is attached to the canvas element to handle keydown events
 * when canvas has pointerLock
 */
function captureKeyShortcuts(event) {
  if (event.altKey && event.code == 'IntlBackslash') {
    arc_capture_screenshot();
  } else if (event.ctrlKey && event.code == 'Backquote') {
    console.log('simulate escape');
    getEmuInput().simulateKey('ArcEscape');
  } 
}


document.ondragenter = function(e) {
  console.log('dragenter', e);
  //e.preventDefault();
}

document.ondragleave = function(e) {
  console.log('dragleave', e);
  //e.preventDefault();
}

document.ondragend = function(e) {
  console.log('dragend', e);
}

document.ondragover = e => e.preventDefault();

document.ondrop = function(ev) {
  console.log('drop', ev);
  ev.preventDefault();
  if (ev.dataTransfer.items) {
    for (var i = 0; i < ev.dataTransfer.items.length; i++) {
      if (ev.dataTransfer.items[i].kind === 'file') {
        var file = ev.dataTransfer.items[i].getAsFile();
        console.log('... file[' + i + '].name = ' + file.name, file);
        ui.loadFile(file);
      }
    }
  } 
}


document.getElementById('display-container').addEventListener('fullscreenchange', function(e) {
  console.log('fullscreen', document.fullscreenElement);
  let el = document.getElementById('display-container');
  if (el == document.fullscreenElement) {
    el.classList.add('fullscreen');
    document.getElementById('canvas').focus(); // ensure keyboard focus after fullscreen
    tryCapture();
  } else {
    el.classList.remove('fullscreen');
  }
});


function fullscreen() {
  // TODO: we probably don't want keyboard lock by default
  // but it might be nice to have as an option
  //tryCapture();
  // document.getElementById('display-container').requestFullscreen({keyboardLock: 'browser'});
  // if ('keyboard' in navigator) {
  //   navigator.keyboard.lock().then(() => console.log('keyboard locked'));
  // }
  document.getElementById('display-container').requestFullscreen();
}

let screenshots = 0;

function saveEmulatorScreenshot(blob) {
  let a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  screenshots++;
  let prefix = (ui.getCurrentSoftwareId() || 'archimedes-live') + '-';
  let filename = prefix + screenshots.toString().padStart(2, '0') + '.png';
  console.log('Saving screenshot to ' + filename);
  a.download = filename;
  a.click(); 
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function arc_capture_screenshot() {
  window.arcScreenshot().then(saveEmulatorScreenshot, e => console.log('screenshot failed', e));
}

document.getElementById('canvas').addEventListener('keydown', captureKeyShortcuts);