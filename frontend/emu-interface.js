/**
 * Functions to integrate browser interaction and events with emulator
 */


const KEY_ESCAPE = 27;
const KEY_F1 = 112;

function sendKeyCode(keycode) {
  simulateKeyEvent('keydown', keycode, 0);
  setTimeout(() => simulateKeyEvent('keyup', keycode, 0), 100);
}


function simulateKeyEvent(eventType, keyCode, charCode) {
  let e = document.createEventObject ? document.createEventObject() : document.createEvent("Events");
  if (e.initEvent)
    e.initEvent(eventType, true, true);

  e.keyCode = keyCode;
  e.which = keyCode;
  e.charCode = charCode;

  // Dispatch directly to Emscripten's html5.h API (use this if page uses emscripten/html5.h event handling):
  if (typeof JSEvents !== 'undefined' && JSEvents.eventHandlers && JSEvents.eventHandlers.length > 0) {
    for (let i = 0; i < JSEvents.eventHandlers.length; ++i) {
      if ((JSEvents.eventHandlers[i].target == Module['canvas'] || JSEvents.eventHandlers[i].target == window)
       && JSEvents.eventHandlers[i].eventTypeString == eventType) {
         JSEvents.eventHandlers[i].handlerFunc(e);
      }
    }
  } else {
    // Dispatch to browser for real (use this if page uses SDL or something else for event handling):
    Module['canvas'].dispatchEvent ? Module['canvas'].dispatchEvent(e) : Module['canvas'].fireEvent("on" + eventType, e);
  }
}

function lockChangeAlert() {
  if (document.pointerLockElement === canvas) {
    console.log('The pointer lock status is now locked');
    sdl_enable_mouse_capture();
    document.getElementById('canvas').addEventListener('keydown', captureKeyShortcuts);
  } else {
    console.log('The pointer lock status is now unlocked');
    sdl_disable_mouse_capture();
    document.getElementById('canvas').removeEventListener('keydown', captureKeyShortcuts);
  }
}

function tryCapture(event) {
  if (document.pointerLockElement)
    return;
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
  if (event.altKey && event.code == 'F1') {
    arc_capture_screenshot();
  } else if (event.ctrlKey && event.code == 'Backquote') {
    console.log('simulate escape');
    setTimeout(() => sendKeyCode(KEY_ESCAPE), 20);
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
        loadSoftware(file.name, file).then(() => console.log('done loading file'));
      }
    }
  } 
}


document.getElementById('display-container').addEventListener('fullscreenchange', function(e) {
  console.log('fullscreen', document.fullscreenElement);
  let el = document.getElementById('display-container');
  if (el == document.fullscreenElement) {
    el.classList.add('fullscreen');
    tryCapture();
  } else {
    el.classList.remove('fullscreen');
  }
});


function fullscreen() {
  //tryCapture();
  document.getElementById('display-container').requestFullscreen();
  if ('keyboard' in navigator) {
    navigator.keyboard.lock().then(() => console.log('keyboard locked'));
  }
}

var screenshots = 0;


function saveEmulatorScreenshot(canvas) {
  canvas.toBlob(blob => {
    let a = document.createElement("a");
    a.href = window.URL.createObjectURL(blob);
    window.screenshots++;
    let prefix = "archimedes-live-";
    if ('currentSoftwareId' in window) {
      prefix = window.currentSoftwareId + '-';
    }
    let filename = prefix + window.screenshots.toString().padStart(2, '0') + '.png';
    console.log('Saving screenshot to ' + filename);
    a.download = filename;
    a.click(); 
  });
}

function arc_capture_screenshot() {
  ccall('arc_capture_screenshot', null, []);
}

/**
 * This is called from video_renderer_update in video_sdl2.c when a 
 * screenshot has been requested. The simpler way of doing this is
 * to just call toBlob on the main emulator canvas. However, by default
 * that doesn't work with a WebGL context. You can  preserveDrawingBuffer
 * when createing the WebGL context, however this can affect performance.
 * So instead this works by copying the display buffer out of WASM memory.
 * 
 * bptr is a pointer to the emulator display buffer. 
 * The buffer is in ARGB  format (i.e. 4 bytes per pixel) 
 * bw/bh is the size of the display buffer. 
 * sx/sy/sw/sh describe the area within the buffer which contains the
 * screen display (this can change size/position depending on the
 * current mode/borders etc..)
 * ww/wh are the current size of the screen (i.e. canvas), which the 
 * screenshot must be scaled to fit
 */
function save_screenshot(bptr, bw, bh, sx, sy, sw, sh, ww, wh) {  
  let pixels = new Uint8ClampedArray(HEAPU8.subarray(bptr, bptr + bw*bh*4));

  // Flip endianness and convert ARGB to RGBA  
  // This is probably slower than doing it in WebGL but it doesn't
  // seem to add much overhead 
  let dv = new DataView(pixels.buffer);
  for (let y=0 ; y < sh; y++) {
    for (let x=0; x < sw; x++) {
      let p = (sy+y)*bw*4 + (sx+x)*4;
      dv.setUint32(p, (dv.getUint32(p, true)<<8)|0xff, false);
    }
  }
  let imgData = new ImageData(pixels, bw);

  // We can scale the bitmap using resizeWidth/resizeWidth but Firefox 
  // doesn't support resizeQuality: pixelated. Instead scale on canvas
  createImageBitmap(imgData, sx, sy, sw, sh)
  .then(bitmap => {
    let canvas = document.createElement('canvas');
    let ctx = canvas.getContext('2d');
    canvas.width = ww;
    canvas.height = wh;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0, ww, wh);
    saveEmulatorScreenshot(canvas);
  });
}
