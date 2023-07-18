let ctx;
let canvas;
let cursor = null;
let coords;
let timing;
let keystate;

let delay = 0;
let n = 0;
let offset = 0;

const KEY_ID_SPACE = 1;
const KEY_ID_MOUSE_BUTTONS = 7;

const sleepbuf = new Int32Array(new SharedArrayBuffer(4));

function sleep(t) {
  Atomics.wait(sleepbuf, 0, 0, Math.max(1, t|0));
}

let lastFrameStart = 0;
let lastRenderTime = 0;
let lastLatency = 0;
let wasSpace = 0;
let wasMouse = 0;

function render() {
    let now = performance.now();
    let td = now - lastFrameStart;
    lastFrameStart = now;
    requestAnimationFrame(render);
   
    sleep(delay);

    let renderStart = performance.now();

    let space = Atomics.load(keystate, KEY_ID_SPACE);
    let mouse = keystate[KEY_ID_MOUSE_BUTTONS];
    
    if (space) {
        ctx.fillStyle = 'magenta';
        performance.mark('render-space');
        //performance.measure('space-latency', 'space-pressed', 'render-space');
    } else if (mouse) {
        ctx.fillStyle = 'red';
    } else {
        ctx.fillStyle = '#777'; 
    }   
    if (space && !wasSpace || mouse && !wasMouse)        
        lastLatency = performance.now() - timing[0] + offset;
    wasSpace = space;
    wasMouse = mouse > 0;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let px = coords[0];
    let py = coords[1];
    let n = coords[2];
    
    ctx.fillStyle = 'red';
    ctx.fillRect(10, 10, n * 10, 10);
    /*if (n > 0) {
        ctx.fillStyle = 'blue';
        ctx.fillRect(10, 30, latency * 10, 10);
    }*/
    Atomics.store(coords, 2, 0);

    ctx.font = "12px sans-serif";
    ctx.fillStyle = 'black';
    ctx.fillText("Frame: " + Math.round(td), 50, 90);
    ctx.fillText("render: " + Math.round(lastRenderTime), 50, 120);
    ctx.fillText("last latenct: " + Math.round(lastLatency), 50, 140);
    
    ctx.drawImage(cursor, px-6, py-2);   
    lastRenderTime = performance.now() - renderStart;   
}

onmessage = (e) => {
    if ('sab' in e.data) {
        let sab = e.data.sab;
        coords = new Int32Array(sab);
        timing = new Float64Array(sab, 16);
        keystate = new Uint8Array(sab, 24);
    }

    if ('canvas' in e.data) {
        canvas = e.data.canvas;
        ctx = canvas.getContext('2d');  
    }

    if ('cursor' in e.data) { 
        cursor = e.data.cursor;
        requestAnimationFrame(render);
    }
 
    if ('delay' in e.data) {
        delay = e.data.delay;
        console.log('setting delay to', delay);
    }

    if ('now' in e.data) { 
        let sync = e.data.now;
        let sig = new Int32Array(sync, 0, 2);
        let timestamp = new Float64Array(sync, 8, 1);
        
        let n = Atomics.load(sig, 0);
        console.log('worker sync time', n);
        let mainNow;
        while (n > 0) {
            Atomics.wait(sig, 0, n); // sleep until sig[0] != 0
            n = sig[0];
            mainNow = timestamp[0];
            offset = mainNow - performance.now();
            console.log(`${n}: offset: ${offset}`);
        }
        console.log('worker: sync done');
    }
};

