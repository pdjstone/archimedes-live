/**
 * Main thread side of the emulator's audio. The emulator in the worker sends
 * the VIDC's sound stream through rings in shared memory; this creates the
 * AudioContext and the AudioWorklet that plays it, tells the emulator whether
 * anything is listening (so it can pace itself against the audio clock and
 * stops sending audio when it isn't), reports glitch counters, and collects
 * audio dumps.
 */
import { RING, CTRL, DUMP_STATE, SAMPLE_RATE, FILL_UNSET, checkRingLayout } from './shared/audio-ring.js';
import { latin1Bytes } from './shared/latin1.js';

const STATS_LOG_INTERVAL_MS = 5000;
/* Events that let a page start audio. A touch only counts as a gesture when
   the finger is lifted (pointerup), so on touch screens pointerdown is too
   early; Firefox for Android is strict about this. pointerdown is kept so a
   mouse click starts audio without waiting for the button to come up. */
export const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'keydown'];
const DUMP_STATE_NAMES = ['off', 'waiting', 'recording', 'recording', 'error'];

export class EmuAudio {
  /**
   * @param {boolean} alwaysLogStats - log the counters every interval, not just when they change
   */
  constructor(alwaysLogStats = false) {
    this.alwaysLogStats = alwaysLogStats;
    this.ctx = null;
    this.node = null;
    this.ctrl = null;
    this.running = false;
    this.paused = false;  // suspended because the emulator is paused
    this.hidden = false;  // the page can't be seen, so the worklet buffers more
    this.lastLogged = null;
    this.dumpFrames = 0;  // size of the audio dump that's been asked for
    this.dumpWav = null;  // the finished dump, as a WAV file
    this.dumpBase64 = null;
  }

  /**
   * Handle the AudioInit message from the emulator worker. This is sent each time the
   * emulator is (re)initialised but the ring doesn't change, so repeats are ignored.
   */
  async init(msg) {
    if (this.ctx)
      return;

    const layoutError = checkRingLayout(msg);
    if (layoutError) {
      console.error('Audio:', layoutError);
      return;
    }
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
      await ctx.audioWorklet.addModule(new URL('worklet/audio-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(ctx, 'arculator-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
    } catch (e) {
      console.error('Audio: unable to start AudioWorklet', e);
      return;
    }
    this.node.port.onmessage = (event) => this.onWorkletMessage(event.data);
    this.node.port.postMessage({
      type: 'init',
      heap: msg.heap,
      ctrlPtr: msg.ctrlPtr,
      resetPtr: msg.resetPtr,
      eventPtr: msg.eventPtr,
      recordPtr: msg.recordPtr,
      ddPtr: msg.ddPtr,
      dumpFrames: this.dumpFrames,
      hidden: this.hidden
    });
    this.node.connect(ctx.destination);

    // Browsers won't let audio start until the user has interacted with the page
    const resume = () => {
      if (ctx.state === 'running')
        GESTURE_EVENTS.forEach(e => removeEventListener(e, resume, true));
      else
        ctx.resume().catch(() => {});
    };
    GESTURE_EVENTS.forEach(e => addEventListener(e, resume, true));

    this.updateState();
    setInterval(() => this.logStats(), STATS_LOG_INTERVAL_MS);
  }

  /**
   * Called when the AudioContext state changes. Tells the emulator whether it
   * has an audience and shows or hides the "audio suspended" warning. When it
   * does have one the emulator starts the stream again from the current moment.
   */
  updateState() {
    const state = this.ctx.state;
    console.log('Audio state:', state);
    document.body.classList.toggle('audio-suspended', state === 'suspended' && !this.paused);

    const running = state === 'running' && this.node !== null;
    if (running === this.running)
      return;
    this.running = running;
    Atomics.store(this.ctrl, CTRL.CTX_RUNNING, running ? 1 : 0);
  }

  /**
   * Suspends the AudioContext while the emulator is paused, rather than
   * letting the worklet run dry, and resumes it after.
   */
  setPaused(paused) {
    this.paused = paused;
    if (!this.ctx)
      return;
    (paused ? this.ctx.suspend() : this.ctx.resume()).catch(() => {});
  }

  /**
   * While the page is hidden latency doesn't matter, so the worklet keeps a
   * much deeper fill, which rides out the stalls a background page gets.
   */
  setHidden(hidden) {
    this.hidden = hidden;
    if (this.node)
      this.node.port.postMessage({ type: 'hidden', hidden });
  }

  onWorkletMessage(msg) {
    if (msg.type === 'dump')
      this.dumpWav = makeWav(new Int16Array(msg.samples), SAMPLE_RATE);
  }

  /**
   * An audio dump of this many frames is going to be requested. The worklet
   * needs the memory for it up front, so this has to be called before init(),
   * which ui.js does while it reads the page's parameters.
   */
  expectDump(frames) {
    this.dumpFrames = frames;
  }

  /**
   * Progress of the audio dump: {state, size, base64}. State is 'off',
   * 'waiting', 'recording', 'finished' or 'error'; size is the size of the
   * WAV file so far in bytes, and base64 is the complete file once the state
   * is 'finished'.
   */
  getDump() {
    if (this.dumpWav) {
      if (!this.dumpBase64)
        this.dumpBase64 = this.dumpWav.toBase64();
      return { state: 'finished', size: this.dumpWav.length, base64: this.dumpBase64 };
    }
    if (!this.ctrl)
      return { state: 'off', size: 0, base64: null };

    // FINISHED means the worklet has finished, but the file hasn't reached us yet
    const state = Atomics.load(this.ctrl, CTRL.DUMP_STATE);
    const frames = state === DUMP_STATE.OFF || state === DUMP_STATE.WAITING ? 0 : Atomics.load(this.ctrl, CTRL.DUMP_FRAMES);
    return {
      state: DUMP_STATE_NAMES[state] || 'error',
      size: 44 + frames * 4,
      base64: null,
      reason: state === DUMP_STATE.ERROR ? 'the audio worklet was unable to capture the dump' : undefined
    };
  }

  /**
   * Snapshot of the counters, all cumulative since the page loaded. Pass
   * resetFill to restart the min/max measurements.
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
    const loopGapMax = Atomics.load(c, CTRL.LOOP_GAP_MAX);
    const runMax = Atomics.load(c, CTRL.RUN_MAX);
    if (resetFill) {
      Atomics.store(c, CTRL.MIN_FILL, FILL_UNSET);
      Atomics.store(c, CTRL.MAX_FILL, 0);
      Atomics.store(c, CTRL.LOOP_GAP_MAX, 0);
      Atomics.store(c, CTRL.RUN_MAX, 0);
    }
    return {
      underruns: Atomics.load(c, CTRL.UNDERRUNS),
      silentFrames: Atomics.load(c, CTRL.SILENT_FRAMES),
      overflows: Atomics.load(c, CTRL.TRIMS),
      framesDropped: Atomics.load(c, CTRL.TRIM_FRAMES),
      recordsDropped: Atomics.load(c, CTRL.RECORDS_DROPPED), // DMA fetches the emulator couldn't send because the ring was full
      eventsDropped: Atomics.load(c, CTRL.EVENTS_DROPPED),
      clips: Atomics.load(c, CTRL.CLIPS),
      ddUnderruns: Atomics.load(c, CTRL.DD_UNDERRUNS),
      ddBlocksWritten: Atomics.load(c, CTRL.DD_WRITE), // 100ms disc noise blocks
      ddBlocksPlayed: Atomics.load(c, CTRL.DD_READ),
      recordsWritten: Atomics.load(c, CTRL.REC_WRITE) >>> 0,
      recordsRead: Atomics.load(c, CTRL.REC_READ) >>> 0,
      ticksWritten: Atomics.load(c, CTRL.TICKS_WRITE) >>> 0,
      frameWatermark: Atomics.load(c, CTRL.FRAME_WM), // output frames the emulation has reached since the last RESET
      framesRead: Atomics.load(c, CTRL.FRAMES_READ),  // output frames the worklet has made since the last RESET
      resets: Atomics.load(c, CTRL.RESET_ACK),
      events: Atomics.load(c, CTRL.EVT_WRITE) >>> 0, // RESET, CLOCK, FILTER and DUMP events sent by the emulator
      loopLate: Atomics.load(c, CTRL.LOOP_LATE), // emulator loop iterations over 40ms late
      loopGapMaxMs: loopGapMax,
      runMaxMs: runMax,
      minFillMs: min === FILL_UNSET ? null : ms(min),
      maxFillMs: max === 0 ? null : ms(max),
      targetFillMs: target === 0 ? null : ms(target),
      trimFillMs: Atomics.load(c, CTRL.TRIM_FILL) === 0 ? null : ms(Atomics.load(c, CTRL.TRIM_FILL)), // fill above which the worklet throws audio away
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
                                s.recordsDropped, s.eventsDropped, s.clips, s.ddUnderruns]);
    if (this.alwaysLogStats || (key !== this.lastLogged && this.lastLogged !== null) ||
        (this.lastLogged === null && key !== '[0,0,0,0,0,0,0,0]')) {
      console.log('Audio stats:', JSON.stringify(s));
    }
    this.lastLogged = key;
  }
}

/** A 16 bit stereo PCM WAV file holding the samples */
function makeWav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset, text) => bytes.set(latin1Bytes(text), offset);

  tag(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 2, true);           // channels
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);    // byte rate
  view.setUint16(32, 4, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  tag(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

