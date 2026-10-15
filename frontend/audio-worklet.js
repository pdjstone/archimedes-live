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
const FIFO_FRAMES = 32768; // power of two (683ms). Has to hold the largest trim level
const FIFO_MASK = FIFO_FRAMES - 1;
const MAX_PRODUCE = 4096;  // most frames to run stage 1 for in one process(), so that it doesn't take too long

// The target fill sets the latency, and the emulator paces itself to keep the
// fill there. It adapts: each underrun raises it, and a long spell without one
// lowers it again. The other levels follow it.
const TARGET_START = 4800;     // frames (100ms)
const TARGET_MIN = 2880;       // 60ms
const TARGET_MAX = 14400;      // 300ms
const TARGET_RAISE = 480;      // 10ms, on each underrun
const TARGET_LOWER = 240;      // 5ms...
const TARGET_LOWER_AFTER = 480000; // ...after this many frames (10s) played without an underrun
const TRIM_HEADROOM_MIN = 2400; // 50ms. Trim at the target plus half the target, or plus this if more

// Disc noise arrives as 100ms blocks of mono 44.1kHz, each tagged with the
// base clock tick it starts at. Each block is made at the start of the time it
// covers, so it's here before the main audio for the same moment, and it's
// played from the frame whose tick reaches the block's. That locks it to the
// main audio with no buffering of its own.
const DD_STEP = 44100 / 48000;
const DD_BLOCK = RING.DD_BLOCK;
const DD_WORDS = RING.DD_BLOCK_BYTES / 4;  // Int32 words per block
const DD_HALVES = RING.DD_BLOCK_BYTES / 2; // Int16 words per block
const DD_HEADER = 4;                       // Int16 words before the samples
const DD_BLOCK_MASK = RING.DD_BLOCKS - 1;

const MAX_QUANTUM = 1024;  // frames. Web Audio uses 128

class ArculatorAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.dsp = null;
    this.pendingDump = null;
    // The 'post' audio dump: what actually reaches the speakers over the same
    // frames as the main dump, after gain and disc noise, and with any fades
    // and underrun silence
    this.postBuf = null;
    this.postFrames = 0;
    this.postPos = 0;
    this.postArmed = false;     // waiting for postStart to be played
    this.postStart = 0;         // FIFO frame (free running) the main dump starts at
    this.postCapturing = false;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        this.init(msg);
      } else if (msg.type === 'dump') {
        // Memory for an audio dump has to be allocated here, not when it starts
        if (this.dsp)
          this.setDump(msg);
        else
          this.pendingDump = msg;
      }
    };
  }

  init(msg) {
    // emu-audio.js has already checked, but this is cheap and the worklet is what would play garbage
    if (checkRingLayout(msg))
      return;
    this.ctrl = new Int32Array(msg.heap, msg.ctrlPtr, RING.CTRL_WORDS);
    this.ddHead = new Int32Array(msg.heap, msg.ddPtr, RING.DD_BLOCKS * DD_WORDS);
    this.ddData = new Int16Array(msg.heap, msg.ddPtr, RING.DD_BLOCKS * DD_HALVES);
    this.dsp = new ArculatorDsp(msg.heap, msg);
    this.dsp.onDumpDone = (buf) => this.port.postMessage({ type: 'dump', samples: buf.buffer }, [buf.buffer]);
    if (this.pendingDump)
      this.setDump(this.pendingDump);

    this.fifo = new Int16Array(FIFO_FRAMES * 2); // output of stage 1, interleaved left, right
    this.fifoTick = new Int32Array(FIFO_FRAMES); // the tick each of those frames was taken from
    this.fifoR = 0;  // frames read from the FIFO, free running
    this.fifoW = 0;  // frames written to it
    this.seenResets = this.dsp.resetCount;
    this.playing = false;
    this.fadeIn = false;
    this.ddActive = false; // a block is playing
    this.ddCur = 0;        // the block playing, as a free running block count
    this.ddNext = Atomics.load(this.ctrl, CTRL.DD_READ); // the next block to play
    this.ddPos = 0;        // sample position in the block playing
    this.lastL = 0;
    this.lastR = 0;

    this.quietFrames = 0;  // frames played since the last underrun, or the last time the target was lowered
    this.setTarget(TARGET_START);
    Atomics.store(this.ctrl, CTRL.MIN_FILL, FILL_UNSET);
    Atomics.store(this.ctrl, CTRL.MAX_FILL, 0);
    this.ready = true;
  }

  setDump(msg) {
    this.dsp.setDumpBuffer(msg.frames);
    if (msg.post) {
      this.postBuf = new Int16Array(msg.frames * 2);
      this.postFrames = msg.frames;
    }
  }

  /** Record n frames of what was played (as left, right floats) into the 'post' dump */
  capturePost(outL, outR, from, n) {
    const buf = this.postBuf;
    for (let i = from; i < from + n && this.postCapturing; i++) {
      let l = Math.round(outL[i] * 32768);
      let r = Math.round(outR[i] * 32768);
      buf[this.postPos * 2] = l > 32767 ? 32767 : l;
      buf[this.postPos * 2 + 1] = r > 32767 ? 32767 : r;
      if (++this.postPos >= this.postFrames) {
        this.postCapturing = false;
        this.postBuf = null;
        this.port.postMessage({ type: 'postdump', samples: buf.buffer }, [buf.buffer]);
      }
    }
  }

  /**
   * Set the target fill, and the levels that go with it: start playing at
   * half of it, and throw audio away above trimFill. The emulator reads both.
   */
  setTarget(frames) {
    if (frames < TARGET_MIN)
      frames = TARGET_MIN;
    if (frames > TARGET_MAX)
      frames = TARGET_MAX;
    this.target = frames;
    this.primeFill = frames >> 1;
    this.trimFill = frames + Math.max(frames >> 1, TRIM_HEADROOM_MIN);
    Atomics.store(this.ctrl, CTRL.TRIM_FILL, this.trimFill);
    Atomics.store(this.ctrl, CTRL.TARGET_FILL, frames);
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
      const got = dsp.produce(fifo, want, at, this.fifoTick);
      if (dsp.dumpStartAt >= 0) {
        // The main dump starts in what we've just made. The 'post' dump starts when it's played
        if (this.postBuf) {
          this.postStart = (this.fifoW + (dsp.dumpStartAt - at)) | 0;
          this.postArmed = true;
        }
        dsp.dumpStartAt = -1;
      }
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
      this.ddActive = false; // blocks from the old stream are skipped below
    }

    this.runStage1();

    let fill = (this.fifoW - this.fifoR) | 0;
    if (!this.playing) {
      if (fill < this.primeFill) {
        this.publish();
        if (this.postCapturing)
          this.capturePost(outL, outR, 0, n); // silence while it fills up again
        return true;
      }
      this.playing = true;
      this.fadeIn = true;
    }

    if (fill > this.trimFill) {
      // Too much queued
      const drop = fill - this.target;
      this.fifoR = (this.fifoR + drop) | 0;
      fill = this.target;
      Atomics.add(c, CTRL.TRIMS, 1);
      Atomics.add(c, CTRL.TRIM_FRAMES, drop);
    }

    const avail = fill < n ? fill : n;
    const st = this.fifo;
    const fifoR = this.fifoR;

    const gain = Atomics.load(c, CTRL.GAIN);
    const ddGain = Atomics.load(c, CTRL.DD_GAIN);
    const ticks = this.fifoTick;

    // Disc noise. Skip blocks that belong to an earlier stream, and all of
    // them if it's turned off
    const ddW = Atomics.load(c, CTRL.DD_WRITE);
    const ddHead = this.ddHead;
    const ddData = this.ddData;
    const seq = dsp.seenSeq;
    let ddNext = this.ddNext;
    if (ddGain === 0) {
      ddNext = ddW;
      this.ddActive = false;
    }
    while (((ddW - ddNext) | 0) > 0 && ddHead[(ddNext & DD_BLOCK_MASK) * DD_WORDS + 1] !== seq)
      ddNext = (ddNext + 1) | 0;
    let ddActive = this.ddActive;
    let ddCur = this.ddCur;
    let ddPos = this.ddPos;
    let ddBase = (ddCur & DD_BLOCK_MASK) * DD_HALVES + DD_HEADER;
    let ddUnderruns = 0;
    // How far (in ticks) disc noise can drift from the main audio before it's
    // pulled back into line: about 2ms
    const ddSlack = (dsp.sampInc * 6) >> 10;

    const fadeIn = this.fadeIn;
    let lastL = this.lastL;
    let lastR = this.lastR;
    let clips = 0;

    for (let i = 0; i < avail; i++) {
      const idx = ((fifoR + i) & FIFO_MASK) * 2;
      let l = (st[idx] * gain) >> 8;
      let rr = (st[idx + 1] * gain) >> 8;

      if (ddGain !== 0) {
        const hasNext = ((ddW - ddNext) | 0) > 0;
        if (hasNext) {
          // How far past the start of the next block this frame is
          const late = (ticks[(fifoR + i) & FIFO_MASK] - ddHead[(ddNext & DD_BLOCK_MASK) * DD_WORDS]) | 0;
          // Start it if it's time. Carry on into it from the end of the one
          // playing, as long as that's about when it's due. Jump to it if we've
          // fallen behind
          if ((!ddActive && late >= 0) ||
              (ddActive && ddPos >= DD_BLOCK && late >= -ddSlack) ||
              (ddActive && late > ddSlack)) {
            ddPos = ddActive && ddPos >= DD_BLOCK ? ddPos - DD_BLOCK : 0;
            ddActive = true;
            ddCur = ddNext;
            ddNext = (ddNext + 1) | 0;
            ddBase = (ddCur & DD_BLOCK_MASK) * DD_HALVES + DD_HEADER;
          }
        }
        if (ddActive && ddPos >= DD_BLOCK) {
          // The next block should have started by now
          ddActive = false;
          ddUnderruns++;
        }
        if (ddActive) {
          const k = ddPos | 0;
          const a = ddData[ddBase + k];
          // The last sample of a block interpolates towards the next block's first
          const b = k + 1 < DD_BLOCK ? ddData[ddBase + k + 1] :
            (((ddW - ddNext) | 0) > 0 ? ddData[(ddNext & DD_BLOCK_MASK) * DD_HALVES + DD_HEADER] : a);
          const d = ((a + (b - a) * (ddPos - k)) | 0) * ddGain >> 8;
          l += d;
          rr += d;
          ddPos += DD_STEP;
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
      // This much buffering wasn't enough
      this.setTarget(this.target + TARGET_RAISE);
      this.quietFrames = 0;
    } else if ((this.quietFrames += n) >= TARGET_LOWER_AFTER) {
      // Things have been calm for a while, so try a bit less latency
      this.quietFrames = 0;
      if (this.target > TARGET_MIN)
        this.setTarget(this.target - TARGET_LOWER);
    }

    if (this.postArmed && ((fifoR + avail - this.postStart) | 0) > 0) {
      // The start of the dump was played in this quantum (or trimmed away)
      let first = (this.postStart - fifoR) | 0;
      if (first < 0)
        first = 0;
      this.postArmed = false;
      this.postCapturing = true;
      this.postPos = 0;
      this.capturePost(outL, outR, first, n - first);
    } else if (this.postCapturing) {
      this.capturePost(outL, outR, 0, n);
    }

    this.fifoR = (fifoR + avail) | 0;
    this.fadeIn = false;
    this.lastL = lastL;
    this.lastR = lastR;
    this.ddActive = ddActive;
    this.ddCur = ddCur;
    this.ddNext = ddNext;
    this.ddPos = ddPos;

    this.publish();
    // Blocks before the one playing (or the next one) can be reused
    Atomics.store(c, CTRL.DD_READ, ddActive ? ddCur : ddNext);
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
