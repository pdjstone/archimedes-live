/**
 * Main thread side of the emulator's audio. The emulator in the worker writes
 * audio into a ring in shared memory; this creates the AudioContext and the
 * AudioWorklet that plays it, tells the emulator whether anything is
 * listening (so it can pace itself against the audio clock and stops queueing
 * audio when it isn't), and reports glitch counters.
 */
import { RING, CTRL, SAMPLE_RATE, FILL_UNSET } from './audio-ring.js';

const STATS_LOG_INTERVAL_MS = 5000;

export class EmuAudio {
  /**
   * @param {string} buildTag - query string appended to the worklet URL
   * @param {boolean} alwaysLogStats - log the counters every interval, not just when they change
   */
  constructor(buildTag = '', alwaysLogStats = false) {
    this.buildTag = buildTag;
    this.alwaysLogStats = alwaysLogStats;
    this.ctx = null;
    this.node = null;
    this.ctrl = null;
    this.running = false;
    this.lastLogged = null;
  }

  /**
   * Handle the AudioInit message from the emulator worker. This is sent each time the
   * emulator is (re)initialised but the ring doesn't change, so repeats are ignored.
   */
  async init(msg) {
    if (this.ctx)
      return;

    this.ctrl = new Int32Array(msg.heap, msg.ctrlPtr, RING.CTRL_WORDS);

    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch (e) {
      console.error('Audio: unable to create AudioContext', e);
      return;
    }
    this.ctx = ctx;
    if (ctx.sampleRate !== SAMPLE_RATE) {
      // We don't resample, so this would play at the wrong pitch
      console.warn(`Audio: AudioContext is running at ${ctx.sampleRate}Hz not ${SAMPLE_RATE}Hz`);
    }
    ctx.addEventListener('statechange', () => this.updateState());

    try {
      await ctx.audioWorklet.addModule(new URL('audio-worklet.js' + this.buildTag, import.meta.url));
      this.node = new AudioWorkletNode(ctx, 'arculator-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
    } catch (e) {
      console.error('Audio: unable to start AudioWorklet', e);
      return;
    }
    this.node.port.postMessage({
      type: 'init',
      heap: msg.heap,
      ctrlPtr: msg.ctrlPtr,
      audioPtr: msg.audioPtr,
      ddPtr: msg.ddPtr
    });
    this.node.connect(ctx.destination);

    // Browsers won't let audio start until the user has interacted with the page
    const resume = () => {
      if (ctx.state === 'running') {
        removeEventListener('pointerdown', resume, true);
        removeEventListener('keydown', resume, true);
      } else {
        ctx.resume().catch(() => {});
      }
    };
    addEventListener('pointerdown', resume, true);
    addEventListener('keydown', resume, true);

    this.updateState();
    setInterval(() => this.logStats(), STATS_LOG_INTERVAL_MS);
  }

  /**
   * Called when the AudioContext state changes. Tells the emulator whether it
   * has an audience and shows or hides the "audio suspended" warning.
   */
  updateState() {
    const state = this.ctx.state;
    console.log('Audio state:', state);
    document.body.classList.toggle('audio-suspended', state === 'suspended');

    const running = state === 'running' && this.node !== null;
    if (running === this.running)
      return;
    this.running = running;
    if (running) {
      // Whatever is in the ring is from before the context was suspended
      Atomics.add(this.ctrl, CTRL.FLUSH, 1);
      Atomics.store(this.ctrl, CTRL.CTX_RUNNING, 1);
    } else {
      Atomics.store(this.ctrl, CTRL.CTX_RUNNING, 0);
    }
  }

  /**
   * Snapshot of the counters, all cumulative since the page loaded. Pass
   * resetFill to restart the min/max fill measurement.
   */
  stats(resetFill = false) {
    const c = this.ctrl;
    if (!c) {
      return null;
    }
    const ms = frames => Math.round(frames / SAMPLE_RATE * 1000 * 10) / 10;
    const min = Atomics.load(c, CTRL.MIN_FILL);
    const max = Atomics.load(c, CTRL.MAX_FILL);
    const target = Atomics.load(c, CTRL.TARGET_FILL);
    if (resetFill) {
      Atomics.store(c, CTRL.MIN_FILL, FILL_UNSET);
      Atomics.store(c, CTRL.MAX_FILL, 0);
    }
    const loopGapMax = Atomics.load(c, CTRL.LOOP_GAP_MAX);
    const runMax = Atomics.load(c, CTRL.RUN_MAX);
    if (resetFill) {
      Atomics.store(c, CTRL.LOOP_GAP_MAX, 0);
      Atomics.store(c, CTRL.RUN_MAX, 0);
    }
    return {
      underruns: Atomics.load(c, CTRL.UNDERRUNS),
      silentFrames: Atomics.load(c, CTRL.SILENT_FRAMES),
      overflows: Atomics.load(c, CTRL.TRIMS),
      framesDropped: Atomics.load(c, CTRL.TRIM_FRAMES),
      recordsDropped: Atomics.load(c, CTRL.BLOCKS_DROPPED), // 50ms blocks the emulator couldn't write
      clips: Atomics.load(c, CTRL.CLIPS),
      ddUnderruns: Atomics.load(c, CTRL.DD_UNDERRUNS),
      blocksWritten: Atomics.load(c, CTRL.BLOCKS_WRITTEN),
      loopLate: Atomics.load(c, CTRL.LOOP_LATE), // emulator loop iterations over 40ms late
      loopGapMaxMs: loopGapMax,
      runMaxMs: runMax,
      minFillMs: min === FILL_UNSET ? null : ms(min),
      maxFillMs: max === 0 ? null : ms(max),
      targetFillMs: target === 0 ? null : ms(target),
      ctxState: this.ctx ? this.ctx.state : null,
      sampleRate: this.ctx ? this.ctx.sampleRate : null,
      baseLatencyMs: this.ctx ? Math.round(this.ctx.baseLatency * 1000 * 10) / 10 : null,
      outputLatencyMs: this.ctx && 'outputLatency' in this.ctx ? Math.round(this.ctx.outputLatency * 1000 * 10) / 10 : null
    };
  }

  /** Log the counters if any glitch counter has changed since last time */
  logStats() {
    const s = this.stats();
    const key = JSON.stringify([s.underruns, s.silentFrames, s.overflows, s.framesDropped,
                                s.recordsDropped, s.clips, s.ddUnderruns]);
    if (this.alwaysLogStats || (key !== this.lastLogged && this.lastLogged !== null) ||
        (this.lastLogged === null && key !== '[0,0,0,0,0,0,0]')) {
      console.log('Audio stats:', JSON.stringify(s));
    }
    this.lastLogged = key;
  }
}
