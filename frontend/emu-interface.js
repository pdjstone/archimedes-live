/**
 * Functions to integrate browser interaction and events with emulator
 */

function lockChangeAlert() {
  let locked = document.pointerLockElement === canvas;
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
    resumeEmulator();
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
  if (false && event.shiftKey && event.altKey && event.code == 'F1') {
    console.log('captureKeyShortcuts: record video');
    recordVideo(10000).then(() => {});
  } else if (event.altKey && event.code == 'IntlBackslash') {
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
    document.getElementById('canvas').focus(); // ensure keyboard focus after fullscreen
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

window.capturingVideo = false;
window.capturingScreenshot = false;
window.videoFrames = 0;

function arc_capture_screenshot() {
  window.capturingScreenshot = true;
  ccall('arc_capture_screenshot', null, []);
}

function arc_capture_video(record) {
  window.capturingVideo = (record == 1);
  ccall('arc_capture_video', null, ['number'], [record]);
}

// Returns the next <name> event of `target`.
function nextEvent(target, name) {
  return new Promise(resolve => {
    target.addEventListener(name, resolve, { once: true });
  });
}

async function recordVideo(durationMS, pauseMS=1000) {
  if (capturingVideo) return false;
  window.videoFrames = 0;
  window.videoWorker = new Worker("webm-wasm/webm-worker.js", {type:"module"});
  videoWorker.postMessage("./webm-wasm.wasm?"+Math.random());
  await nextEvent(videoWorker, "message");

  let framerate = 50;
  let width = 640;
  let height = 256;
  let bitrate = 200;
  videoWorker.postMessage({realtime: false, timebaseDen: framerate, width:width, height:height, bitrate:bitrate });

  arc_capture_video(1);
  await sleep(durationMS);
  arc_capture_video(0);
  await sleep(pauseMS);
  console.log(`captured ${window.videoFrames} frames`);
  videoWorker.postMessage(null);
  const webm = (await nextEvent(videoWorker, "message")).data;
  videoWorker.terminate();
  const blob = new Blob([webm], { type: "video/webm" });
  let a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  window.screenshots++;
  let prefix = "archimedes-live-";
  if ('currentSoftwareId' in window) {
    prefix = window.currentSoftwareId + '-';
  }
  let filename = prefix + window.screenshots.toString().padStart(2, '0') + '.webm';
  console.log('Saving video to ' + filename);
  a.download = filename;
  a.click(); 
}

/**
 * This is called from video_renderer_update in video_sdl2.c when a 
 * screenshot has been requested. The simpler way of doing this is
 * to just call toBlob on the main emulator canvas. However, by default
 * that doesn't work with a WebGL context. You can specifc 
 * preserveDrawingBuffer when createing the WebGL context, however this 
 * can affect performance.
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
function capture_frame(bptr, bw, bh, sx, sy, sw, sh, ww, wh) {  
  if (capturingScreenshot) {
    capturingScreenshot = false;
    let pixels = new Uint8ClampedArray(HEAPU8.subarray(bptr, bptr + bw*bh*4));
    //console.log(`(${bw}x${bh}):(${sx},${sy}) ${sw}x${sh} => ${ww}x${wh}`);
    // Flip endianness and convert ARGB to RGBA  
    // This is probably slower than doing it in WebGL but it doesn't
    // seem to add much overhead 
    let dv = new DataView(pixels.buffer);
    for (let y=0 ; y < sh; y++) {
      for (let x=0; x < sw; x++) {
        let p = (sy+y)*bw*4 + (sx+x)*4;
        /*if (x==0 && y== 0) {
          console.log(pixels.slice(p, p+8));
        }*/
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
      // TODO: delete canvas after it's been saved
    });
  } else if (capturingVideo) {
    window.videoFrames++;
    let offset = sy*bw*4 + sx*4;
    let pixels = new Uint8Array(HEAPU8.subarray(bptr+offset, bptr + bw*bh*4));
    videoWorker.postMessage(pixels.buffer, pixels.buffer);
  }
}

document.getElementById('canvas').addEventListener('keydown', captureKeyShortcuts);