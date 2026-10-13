/**
 * AudioWorklet processor that plays the emulator's audio.
 *
 * The emulator (running in a Worker) does all of the filtering and resampling
 * and writes finished 48kHz stereo int16 audio into a ring in the shared wasm
 * heap (arculator-wasm/src/sound_ring.h). All this does is apply the sound
 * gain, mix in the disc drive noise, convert to float and play it, keeping
 * counters of anything that goes wrong. It must not allocate in process().
 */
import { RING, CTRL, FILL_UNSET } from './audio-ring.js';

// The emulator produces audio in 2400 frame (50ms) lumps
const TARGET_FILL = 7200;  // frames (150ms). Wanted fill, sets the latency. The emulator paces itself to this.
                           // It counts the part-built 50ms block, so the ring itself can be 50ms lower than this
const PRIME_FILL = 3600;   // frames needed before (re)starting playback - two blocks
const MAX_FILL = 12000;    // frames. If the ring gets fuller than this we drop audio to get back to TARGET_FILL

// Disc noise arrives as mono 44.1kHz in 4410 sample blocks and has to be
// delayed enough to be gapless
const DD_PRIME = 8820;     // samples
const DD_MAX_FILL = 13230; // samples
const DD_STEP = 44100 / 48000;

const AUDIO_MASK = RING.AUDIO_FRAMES - 1;
const DD_MASK = RING.DD_FRAMES - 1;

class ArculatorAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.port.onmessage = (event) => {
      if (event.data.type === 'init')
        this.init(event.data);
    };
  }

  init(msg) {
    this.ctrl = new Int32Array(msg.heap, msg.ctrlPtr, RING.CTRL_WORDS);
    this.audio = new Int16Array(msg.heap, msg.audioPtr, RING.AUDIO_FRAMES * 2);
    this.dd = new Int16Array(msg.heap, msg.ddPtr, RING.DD_FRAMES);

    this.seenFlush = Atomics.load(this.ctrl, CTRL.FLUSH);
    this.playing = false;
    this.fadeIn = false;
    this.r = 0;
    this.ddR = 0;
    this.ddFrac = 0;
    this.ddPlaying = false;
    this.lastL = 0;
    this.lastR = 0;

    Atomics.store(this.ctrl, CTRL.TARGET_FILL, TARGET_FILL);
    Atomics.store(this.ctrl, CTRL.MIN_FILL, FILL_UNSET);
    Atomics.store(this.ctrl, CTRL.MAX_FILL, 0);
    this.discard();
    this.ready = true;
  }

  /** Drop whatever is in the ring and wait for fresh audio */
  discard() {
    const c = this.ctrl;
    this.r = Atomics.load(c, CTRL.WRITE) >>> 0;
    this.ddR = Atomics.load(c, CTRL.DD_WRITE) >>> 0;
    this.ddFrac = 0;
    this.playing = false;
    this.ddPlaying = false;
    Atomics.store(c, CTRL.READ, this.r | 0);
    Atomics.store(c, CTRL.DD_READ, this.ddR | 0);
  }

  process(inputs, outputs) {
    if (!this.ready)
      return true; // outputs are already silent

    const c = this.ctrl;
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const n = outL.length;

    const flush = Atomics.load(c, CTRL.FLUSH);
    if (flush !== this.seenFlush) {
      this.seenFlush = flush;
      this.discard();
    }

    const w = Atomics.load(c, CTRL.WRITE) >>> 0;
    let fill = (w - this.r) >>> 0;
    if (fill > RING.AUDIO_FRAMES) { // can't happen unless the counters have been corrupted
      this.r = w;
      fill = 0;
    }

    if (!this.playing) {
      if (fill < PRIME_FILL) {
        Atomics.store(c, CTRL.READ, this.r | 0);
        return true;
      }
      this.playing = true;
      this.fadeIn = true;
    }

    if (fill > MAX_FILL) {
      const drop = fill - TARGET_FILL;
      this.r = (this.r + drop) >>> 0;
      fill = TARGET_FILL;
      Atomics.add(c, CTRL.TRIMS, 1);
      Atomics.add(c, CTRL.TRIM_FRAMES, drop);
    }

    const gain = Atomics.load(c, CTRL.GAIN);
    const ddGain = Atomics.load(c, CTRL.DD_GAIN);
    const audio = this.audio;
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

    const avail = fill < n ? fill : n;
    const fadeIn = this.fadeIn;
    let r = this.r;
    let lastL = this.lastL;
    let lastR = this.lastR;
    let clips = 0;

    for (let i = 0; i < avail; i++) {
      const idx = ((r + i) & AUDIO_MASK) << 1;
      let l = (audio[idx] * gain) >> 8;
      let rr = (audio[idx + 1] * gain) >> 8;

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

    r = (r + avail) >>> 0;
    this.r = r;
    this.fadeIn = false;
    this.lastL = lastL;
    this.lastR = lastR;
    this.ddR = ddR;
    this.ddFrac = ddFrac;
    this.ddPlaying = ddPlaying;

    Atomics.store(c, CTRL.READ, r | 0);
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
