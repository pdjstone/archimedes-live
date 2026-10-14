/**
 * AudioWorklet processor that plays the emulator's audio.
 *
 * The emulator (running in a Worker) sends the VIDC's sound DMA stream through
 * rings in the shared wasm heap (arculator-wasm/src/sound_ring.h). Stage 1,
 * in audio-dsp.js, filters that and resamples it to 48kHz int16 stereo, exactly
 * as the native code does. This is stage 2: apply the sound gain, mix in the
 * disc drive noise, convert to float and play it, keeping counters of anything
 * that goes wrong. It must not allocate in process().
 */
import { RING, CTRL, FILL_UNSET, checkRingLayout } from './audio-ring.js';
import { ArculatorDsp } from './audio-dsp.js';

// Stage 1 runs as far ahead as the emulator lets it, into a FIFO of 48kHz
// frames, so that the emulator's records are freed as soon as possible: at
// short sample periods the record ring holds very little time. The fill is
// what's in the FIFO.
const FIFO_FRAMES = 16384; // power of two (341ms)
const FIFO_MASK = FIFO_FRAMES - 1;
const MAX_PRODUCE = 4096;  // most frames to run stage 1 for in one process(), so that it doesn't take too long
const TARGET_FILL = 7200;  // frames (150ms). Wanted fill, sets the latency. The emulator paces itself to this
const PRIME_FILL = 3600;   // frames needed before (re)starting playback
const MAX_FILL = 12000;    // frames. If we get fuller than this we drop audio to get back to TARGET_FILL

// Disc noise arrives as mono 44.1kHz in 4410 sample blocks and has to be
// delayed enough to be gapless
const DD_PRIME = 8820;     // samples
const DD_MAX_FILL = 13230; // samples
const DD_STEP = 44100 / 48000;

const MAX_QUANTUM = 1024;  // frames. Web Audio uses 128
const DD_MASK = RING.DD_FRAMES - 1;

class ArculatorAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.dsp = null;
    this.pendingDump = 0;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        this.init(msg);
      } else if (msg.type === 'dump') {
        // Memory for an audio dump has to be allocated here, not when it starts
        if (this.dsp)
          this.dsp.setDumpBuffer(msg.frames);
        else
          this.pendingDump = msg.frames;
      }
    };
  }

  init(msg) {
    // emu-audio.js has already checked, but this is cheap and the worklet is what would play garbage
    if (checkRingLayout(msg))
      return;
    this.ctrl = new Int32Array(msg.heap, msg.ctrlPtr, RING.CTRL_WORDS);
    this.dd = new Int16Array(msg.heap, msg.ddPtr, RING.DD_FRAMES);
    this.dsp = new ArculatorDsp(msg.heap, msg);
    this.dsp.onDumpDone = (buf) => this.port.postMessage({ type: 'dump', samples: buf.buffer }, [buf.buffer]);
    if (this.pendingDump)
      this.dsp.setDumpBuffer(this.pendingDump);

    this.fifo = new Int16Array(FIFO_FRAMES * 2); // output of stage 1, interleaved left, right
    this.fifoR = 0;  // frames read from the FIFO, free running
    this.fifoW = 0;  // frames written to it
    this.seenResets = this.dsp.resetCount;
    this.playing = false;
    this.fadeIn = false;
    this.ddR = 0;
    this.ddFrac = 0;
    this.ddPlaying = false;
    this.lastL = 0;
    this.lastR = 0;

    Atomics.store(this.ctrl, CTRL.TARGET_FILL, TARGET_FILL);
    Atomics.store(this.ctrl, CTRL.MIN_FILL, FILL_UNSET);
    Atomics.store(this.ctrl, CTRL.MAX_FILL, 0);
    this.discardDD();
    this.ready = true;
  }

  /** Drop whatever disc noise is queued */
  discardDD() {
    const c = this.ctrl;
    this.ddR = Atomics.load(c, CTRL.DD_WRITE) >>> 0;
    this.ddFrac = 0;
    this.ddPlaying = false;
    Atomics.store(c, CTRL.DD_READ, this.ddR | 0);
  }

  /** Run stage 1 into the FIFO, as far as the emulator has got and there's room */
  runStage1() {
    const dsp = this.dsp;
    const fifo = this.fifo;
    let room = FIFO_FRAMES - ((this.fifoW - this.fifoR) | 0);
    if (room > MAX_PRODUCE)
      room = MAX_PRODUCE;
    while (room > 0) {
      // produce() writes contiguously, so stop at the end of the FIFO's memory
      const at = this.fifoW & FIFO_MASK;
      let want = FIFO_FRAMES - at;
      if (want > room)
        want = room;
      const got = dsp.produce(fifo, want, at);
      this.fifoW = (this.fifoW + got) | 0;
      room -= got;
      if (got < want)
        break;
    }
  }

  /**
   * Tell the emulator how far we've got. It paces itself on what has been
   * played, which is what stage 1 has made less what is still in the FIFO.
   */
  publish() {
    this.dsp.publish(((this.fifoW - this.fifoR) | 0));
  }

  process(inputs, outputs) {
    if (!this.ready)
      return true; // outputs are already silent

    const c = this.ctrl;
    const dsp = this.dsp;
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const n = outL.length < MAX_QUANTUM ? outL.length : MAX_QUANTUM;

    dsp.sync();
    if (dsp.resetCount !== this.seenResets) {
      // The stream has restarted (sound enabled, or the AudioContext was resumed), so whatever we were playing is stale
      this.seenResets = dsp.resetCount;
      this.playing = false;
      this.fifoR = this.fifoW = 0;
      this.discardDD();
    }

    this.runStage1();

    let fill = (this.fifoW - this.fifoR) | 0;
    if (!this.playing) {
      if (fill < PRIME_FILL) {
        this.publish();
        return true;
      }
      this.playing = true;
      this.fadeIn = true;
    }

    if (fill > MAX_FILL) {
      // Too much queued
      const drop = fill - TARGET_FILL;
      this.fifoR = (this.fifoR + drop) | 0;
      fill = TARGET_FILL;
      Atomics.add(c, CTRL.TRIMS, 1);
      Atomics.add(c, CTRL.TRIM_FRAMES, drop);
    }

    const avail = fill < n ? fill : n;
    const st = this.fifo;
    const fifoR = this.fifoR;

    const gain = Atomics.load(c, CTRL.GAIN);
    const ddGain = Atomics.load(c, CTRL.DD_GAIN);
    const dd = this.dd;

    // Disc noise
    const ddW = Atomics.load(c, CTRL.DD_WRITE) >>> 0;
    let ddR = this.ddR;
    let ddAvail = (ddW - ddR) >>> 0;
    if (ddGain === 0 || ddAvail > RING.DD_FRAMES) {
      ddR = ddW; // disabled (or corrupted): don't let a backlog build up
      ddAvail = 0;
      this.ddPlaying = false;
    } else if (ddAvail > DD_MAX_FILL) {
      ddR = (ddR + ddAvail - DD_PRIME) >>> 0;
      ddAvail = DD_PRIME;
    }
    if (!this.ddPlaying && ddAvail >= DD_PRIME) {
      this.ddPlaying = true;
      this.ddFrac = 0;
    }
    let ddPlaying = this.ddPlaying;
    let ddFrac = this.ddFrac;
    let ddUnderruns = 0;

    const fadeIn = this.fadeIn;
    let lastL = this.lastL;
    let lastR = this.lastR;
    let clips = 0;

    for (let i = 0; i < avail; i++) {
      const idx = ((fifoR + i) & FIFO_MASK) * 2;
      let l = (st[idx] * gain) >> 8;
      let rr = (st[idx + 1] * gain) >> 8;

      if (ddPlaying) {
        if (ddAvail < 2) {
          ddPlaying = false;
          ddUnderruns++;
        } else {
          const a = dd[ddR & DD_MASK];
          const b = dd[(ddR + 1) & DD_MASK];
          const d = ((a + (b - a) * ddFrac) | 0) * ddGain >> 8;
          l += d;
          rr += d;
          ddFrac += DD_STEP;
          if (ddFrac >= 1) {
            ddFrac -= 1;
            ddR = (ddR + 1) >>> 0;
            ddAvail--;
          }
        }
      }

      if (l < -32768) { l = -32768; clips++; } else if (l > 32767) { l = 32767; clips++; }
      if (rr < -32768) { rr = -32768; clips++; } else if (rr > 32767) { rr = 32767; clips++; }

      lastL = l / 32768;
      lastR = rr / 32768;
      if (fadeIn) {
        const g = (i + 1) / n;
        outL[i] = lastL * g;
        outR[i] = lastR * g;
      } else {
        outL[i] = lastL;
        outR[i] = lastR;
      }
    }

    if (avail < n) {
      // Ran out of audio. Ramp the last sample to zero rather than cutting it off
      const rem = n - avail;
      for (let i = 0; i < rem; i++) {
        const g = 1 - (i + 1) / rem;
        outL[avail + i] = lastL * g;
        outR[avail + i] = lastR * g;
      }
      lastL = 0;
      lastR = 0;
      this.playing = false;
      Atomics.add(c, CTRL.UNDERRUNS, 1);
      Atomics.add(c, CTRL.SILENT_FRAMES, rem);
    }

    this.fifoR = (fifoR + avail) | 0;
    this.fadeIn = false;
    this.lastL = lastL;
    this.lastR = lastR;
    this.ddR = ddR;
    this.ddFrac = ddFrac;
    this.ddPlaying = ddPlaying;

    this.publish();
    Atomics.store(c, CTRL.DD_READ, ddR | 0);
    if (ddUnderruns)
      Atomics.add(c, CTRL.DD_UNDERRUNS, ddUnderruns);
    if (clips)
      Atomics.add(c, CTRL.CLIPS, clips);

    // Fill statistics: lowest after we've taken our share, highest before
    const after = fill - avail;
    if (after < Atomics.load(c, CTRL.MIN_FILL))
      Atomics.store(c, CTRL.MIN_FILL, after);
    if (fill > Atomics.load(c, CTRL.MAX_FILL))
      Atomics.store(c, CTRL.MAX_FILL, fill);

    return true;
  }
}

registerProcessor('arculator-audio', ArculatorAudioProcessor);
