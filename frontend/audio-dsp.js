/**
 * Stage 1 of the emulator's audio: turns the VIDC's sound DMA stream into
 * 48kHz stereo int16. This is a port of the sound.c code that the native
 * builds still use (update_sound), and gives the same output sample for sample.
 *
 * The emulator sends a stream of records (one per DMA fetch: 16 stereo samples,
 * and the number of base clock ticks, 1/1.049/1.5 MHz, that each is held for)
 * and events that say where in the stream the clock or filter changed
 * (arculator-wasm/src/sound_ring.h). For each tick of the stream this
 *
 *   1. holds the sample (zero order hold),
 *   2. runs it through a 2nd order Butterworth low pass filter, which models
 *      the analogue filter on the VIDC's output, and
 *   3. for each output frame, takes the filtered value at tick
 *      (rp >> 14), where rp advances by SAMP_INC (the ratio of the base clock
 *      to 48kHz, with a 14 bit fraction) per frame: nearest neighbour
 *      decimation.
 *
 * Everything is lazy: the filter is only run up to the tick that the next
 * output frame needs, so no buffer of ticks is needed. All of the arithmetic
 * is done on doubles in the same order as the C code, and the filter
 * coefficients are calculated by the C code (JS and C can differ in the last
 * bit of tan()), so the results are bit for bit the same.
 *
 * Stage 2 (gain, disc noise, float conversion) is in audio-worklet.js.
 *
 * Nothing in here allocates once running, so it's safe to use in process().
 */
import { RING, CTRL, EVENT, DUMP_STATE } from './audio-ring.js';

const EVT_MASK = RING.EVENT_COUNT - 1;
const REC_MASK = RING.RECORD_COUNT - 1;
const EV_WORDS = RING.EVENT_BYTES / 4;   // Int32 words per event
const EV_DBLS = RING.EVENT_BYTES / 8;    // Float64 words per event
const EV_COEF = 3;                       // first coefficient, in Float64 words from the start of an event
const REC_HALVES = RING.RECORD_BYTES / 2; // Int16 words per record

// The native code starts reading 1024 ticks before the start of the stream
// (in the stale part of its buffer), so that it can't catch up with what has
// been written. Stale samples are silence here.
const START_TICK = -1024;

export class ArculatorDsp {
  /**
   * @param {SharedArrayBuffer} heap the emulator's wasm heap
   * @param {{ctrlPtr: number, resetPtr: number, eventPtr: number, recordPtr: number}} ptrs addresses of the rings in it
   */
  constructor(heap, ptrs) {
    this.ctrl = new Int32Array(heap, ptrs.ctrlPtr, RING.CTRL_WORDS);
    this.rs32 = new Int32Array(heap, ptrs.resetPtr, RING.RESET_SLOTS * EV_WORDS);
    this.rs64 = new Float64Array(heap, ptrs.resetPtr, RING.RESET_SLOTS * EV_DBLS);
    this.ev32 = new Int32Array(heap, ptrs.eventPtr, RING.EVENT_COUNT * EV_WORDS);
    this.ev64 = new Float64Array(heap, ptrs.eventPtr, RING.EVENT_COUNT * EV_DBLS);
    this.rec16 = new Int16Array(heap, ptrs.recordPtr, RING.RECORD_COUNT * REC_HALVES);

    // What the emulator has published (see sync())
    this.wm = 0;      // output frame watermark
    this.ticksW = 0;  // ticks in the records written
    this.recW = 0;    // records written
    this.evW = 0;     // events written

    // Event cursors, in events (free running Int32). A reset sets them
    this.evRecCur = 0;    // next event whose record trigger hasn't fired
    this.evFrameCur = 0;  // next event whose output frame trigger hasn't fired

    // Nothing plays until the emulator resets the stream. This starts at 0,
    // not the current RESET_SEQ, as the emulator starts the stream as soon as
    // the AudioContext is running, which can be before we get here
    this.valid = false;
    this.seenSeq = 0;
    this.resetCount = 0;

    // Where we are in the stream
    this.recRead = 0;    // next record to load
    this.curBase = 0;    // Int16 index in rec16 of the current record's samples
    this.curPeriod = 0;  // ticks per sample in the current record
    this.curS = 0;       // current sample in the record
    this.curRep = 0;     // ticks left of the current sample
    this.curLeft = 0;    // ticks left in the record
    this.lx = 0;         // current sample, left and right
    this.rx = 0;

    // Positions are counted from the RESET. T and tickDone can't wrap in any plausible lifetime
    this.tick0 = 0;      // the emulator's tick counter at the RESET
    this.tickDone = 0;   // ticks filtered so far
    this.T = START_TICK; // tick that the next output frame is taken from
    this.frac = 0;       // fractional part of rp, 14 bits
    this.sampInc = 1 << 14;
    this.fr = 0;         // output frames produced (wraps in an Int32 compare)

    // IIR filter. The coefficients are set by RESET, CLOCK and FILTER events.
    // This state carries on across a RESET, as it does natively.
    this.a0 = 0; this.a1 = 0; this.a2 = 0; this.b1 = 0; this.b2 = 0;
    this.pxl1 = 0; this.pxl2 = 0; this.pyl1 = 0; this.pyl2 = 0; // previous inputs and outputs
    this.pxr1 = 0; this.pxr2 = 0; this.pyr1 = 0; this.pyr2 = 0;
    this.outL = 0;       // filtered output at tickDone - 1, as int16
    this.outR = 0;

    // Audio dump
    this.dumpBuf = null;
    this.dumpFrames = 0;
    this.dumpPos = 0;
    this.capturing = false;
    this.onDumpDone = null;
  }

  /** Provide the memory for an audio dump. This allocates, so can't be called from process() */
  setDumpBuffer(frames) {
    this.dumpBuf = new Int16Array(frames * 2);
  }

  /**
   * Call at the start of each process(): read what the emulator has published.
   *
   * The order matters. The emulator publishes a reset, then the events after
   * it, then the records and watermark that follow them (and it publishes the
   * watermark last of those), so reading in the opposite order means that
   * whatever we see, we see what goes with it:
   *  - an event for a record is published before the record, so if we can see
   *    the record we can see the event
   *  - the watermark is a promise that every event that applies to a frame
   *    before it has been published, so if we only produce frames before the
   *    watermark we have always seen the events for them
   *  - if we can see anything from after a reset, we can see the reset
   */
  sync() {
    const c = this.ctrl;
    this.wm = Atomics.load(c, CTRL.FRAME_WM);
    this.ticksW = Atomics.load(c, CTRL.TICKS_WRITE);
    this.recW = Atomics.load(c, CTRL.REC_WRITE);
    this.evW = Atomics.load(c, CTRL.EVT_WRITE);
    const seq = Atomics.load(c, CTRL.RESET_SEQ);
    if (seq !== this.seenSeq)
      this.reset(seq);
  }

  /** Restart the stream, from the latest reset slot */
  reset(seq) {
    const rs = this.rs32;
    let o, rec, value, tick0, evtBase;

    // The emulator may be filling in the other slot, or even (after two resets
    // in a row) this one, so check that RESET_SEQ didn't change while we read it
    for (;;) {
      o = (seq & 1) * EV_WORDS;
      rec = rs[o + 1];
      value = rs[o + 3];
      tick0 = rs[o + 4];
      evtBase = rs[o + 5];
      this.setCoefs(this.rs64, (seq & 1) * EV_DBLS);
      const again = Atomics.load(this.ctrl, CTRL.RESET_SEQ);
      if (again === seq)
        break;
      seq = again;
    }

    this.seenSeq = seq;
    this.valid = true;
    this.recRead = rec;
    this.tick0 = tick0;
    this.sampInc = value;
    this.tickDone = 0;
    this.T = START_TICK;
    this.frac = 0;
    this.fr = 0;
    this.curLeft = 0;
    this.curRep = 0;

    // Any watermark we've read belongs to the old stream. The emulator zeroed
    // it before sending the RESET, so the next sync() gets the new one
    this.wm = 0;

    // Events before this belong to the old stream
    this.evRecCur = this.evFrameCur = evtBase;

    if (this.capturing) {
      this.capturing = false;
      Atomics.store(this.ctrl, CTRL.DUMP_STATE, DUMP_STATE.ERROR);
    }
    this.resetCount++;
    Atomics.store(this.ctrl, CTRL.RESET_ACK, seq);
  }

  /** Load the filter coefficients from an event or reset slot. o is its index in Float64 words */
  setCoefs(d, o) {
    o += EV_COEF;
    this.a0 = d[o];
    this.a1 = d[o + 1];
    this.a2 = d[o + 2];
    this.b1 = d[o + 3];
    this.b2 = d[o + 4];
  }

  /** Apply the coefficient changes that take effect from record idx */
  applyRecordEvents(idx) {
    const ev = this.ev32;
    while (((this.evW - this.evRecCur) | 0) > 0) {
      const e = this.evRecCur & EVT_MASK;
      const code = ev[e * EV_WORDS];
      if (code === EVENT.CLOCK || code === EVENT.FILTER) {
        if (((ev[e * EV_WORDS + 1] - idx) | 0) > 0)
          break;
        this.setCoefs(this.ev64, e * EV_DBLS);
      }
      this.evRecCur = (this.evRecCur + 1) | 0;
    }
  }

  /** Apply the changes that take effect from output frame this.fr */
  applyFrameEvents() {
    const ev = this.ev32;
    while (((this.evW - this.evFrameCur) | 0) > 0) {
      const e = this.evFrameCur & EVT_MASK;
      const o = e * EV_WORDS;
      const code = ev[o];
      if (code === EVENT.CLOCK || code === EVENT.DUMP) {
        if (((this.fr - ev[o + 2]) | 0) < 0)
          break;
        if (code === EVENT.CLOCK)
          this.sampInc = ev[o + 3];
        else
          this.startDump(ev[o + 3]);
      }
      this.evFrameCur = (this.evFrameCur + 1) | 0;
    }
  }

  startDump(frames) {
    if (!this.dumpBuf || this.dumpBuf.length < frames * 2 || this.capturing) {
      Atomics.store(this.ctrl, CTRL.DUMP_STATE, DUMP_STATE.ERROR);
      return;
    }
    this.dumpFrames = frames;
    this.dumpPos = 0;
    this.capturing = true;
  }

  capture(l, r) {
    const p = this.dumpPos * 2;
    this.dumpBuf[p] = l;
    this.dumpBuf[p + 1] = r;
    if (++this.dumpPos >= this.dumpFrames) {
      const buf = this.dumpBuf;
      this.capturing = false;
      this.dumpBuf = null;
      Atomics.store(this.ctrl, CTRL.DUMP_FRAMES, this.dumpPos);
      Atomics.store(this.ctrl, CTRL.DUMP_STATE, DUMP_STATE.FINISHED);
      if (this.onDumpDone)
        this.onDumpDone(buf, this.dumpFrames);
    }
  }

  /** Load the next record. Returns false if there isn't one yet */
  nextRecord() {
    const idx = this.recRead;
    if (((this.recW - idx) | 0) <= 0)
      return false;

    this.applyRecordEvents(idx);

    const rec16 = this.rec16;
    const base = (idx & REC_MASK) * REC_HALVES;
    const period = rec16[base];
    this.recRead = (idx + 1) | 0;
    if (period <= 0)  // the emulator never sends one
      return this.nextRecord();

    this.curPeriod = period;
    this.curBase = base + 2;
    this.curS = 0;
    this.lx = rec16[base + 2];
    this.rx = rec16[base + 3];
    this.curRep = period;
    this.curLeft = 16 * period;
    return true;
  }

  /**
   * Run the zero order hold and the filter up to and including tick `last`.
   * Returns false if the stream ran out first.
   */
  advance(last) {
    const rec16 = this.rec16;
    let tickDone = this.tickDone;

    while (tickDone <= last) {
      if (this.curLeft === 0 && !this.nextRecord()) {
        this.tickDone = tickDone;
        return false;
      }

      // The input is constant for the rest of the current sample, so run the filter over as many ticks as that is
      let n = this.curRep;
      const want = last - tickDone + 1;
      if (n > want)
        n = want;

      const a0 = this.a0, a1 = this.a1, a2 = this.a2, b1 = this.b1, b2 = this.b2;
      const xl = this.lx, xr = this.rx;
      let pxl1 = this.pxl1, pxl2 = this.pxl2, pyl1 = this.pyl1, pyl2 = this.pyl2;
      let pxr1 = this.pxr1, pxr2 = this.pxr2, pyr1 = this.pyr1, pyr2 = this.pyr2;
      let yl = 0, yr = 0;

      // Same operations in the same order as iir_l() and iir_r() in sound.c
      for (let i = 0; i < n; i++) {
        yl = a0 * xl;
        yl += a1 * pxl1 - b1 * pyl1;
        yl += a2 * pxl2 - b2 * pyl2;
        pxl2 = pxl1; pxl1 = xl; pyl2 = pyl1; pyl1 = yl;

        yr = a0 * xr;
        yr += a1 * pxr1 - b1 * pyr1;
        yr += a2 * pxr2 - b2 * pyr2;
        pxr2 = pxr1; pxr1 = xr; pyr2 = pyr1; pyr1 = yr;
      }

      this.pxl1 = pxl1; this.pxl2 = pxl2; this.pyl1 = pyl1; this.pyl2 = pyl2;
      this.pxr1 = pxr1; this.pxr2 = pxr2; this.pyr1 = pyr1; this.pyr2 = pyr2;
      // (int16_t)double: truncate towards zero, then wrap to 16 bits
      this.outL = ((yl | 0) << 16) >> 16;
      this.outR = ((yr | 0) << 16) >> 16;

      tickDone += n;
      this.curRep -= n;
      this.curLeft -= n;
      if (this.curRep === 0 && this.curLeft > 0) {
        const p = this.curBase + ++this.curS * 2;
        this.lx = rec16[p];
        this.rx = rec16[p + 1];
        this.curRep = this.curPeriod;
      }
    }

    this.tickDone = tickDone;
    return true;
  }

  /**
   * Make up to n output frames into out (interleaved left, right), starting at
   * frame `at`. Returns the number made, which is fewer if the emulator hasn't
   * sent enough audio yet.
   */
  produce(out, n, at = 0) {
    if (!this.valid)
      return 0;

    let produced = 0;
    while (produced < n) {
      // Only make frames that we are sure we've seen all the events for
      if (((this.wm - this.fr) | 0) <= 0)
        break;
      this.applyFrameEvents();

      const T = this.T;
      let l = 0, r = 0;
      if (T >= 0) {
        // The tick has to have been written
        if (((this.ticksW - (this.tick0 + T)) | 0) <= 0)
          break;
        if (!this.advance(T))
          break;
        l = this.outL;
        r = this.outR;
      }

      out[(at + produced) * 2] = l;
      out[(at + produced) * 2 + 1] = r;
      produced++;
      if (this.capturing)
        this.capture(l, r);

      this.fr = (this.fr + 1) | 0;
      const acc = this.frac + this.sampInc;
      this.T = T + (acc >> 14);
      this.frac = acc & 16383;
    }
    return produced;
  }

  /**
   * Tell the emulator how far we've got, so that it can reuse the space and
   * pace itself. `queued` is how many of the frames we've made are still
   * waiting to be played.
   */
  publish(queued = 0) {
    const c = this.ctrl;
    if (this.valid) {
      // The record we're part way through is still in use
      Atomics.store(c, CTRL.REC_READ, (this.recRead - (this.curLeft > 0 ? 1 : 0)) | 0);
      Atomics.store(c, CTRL.FRAMES_READ, (this.fr - queued) | 0);
    }
    Atomics.store(c, CTRL.EVT_READ, ((this.evRecCur - this.evFrameCur) | 0) < 0 ? this.evRecCur : this.evFrameCur);
    if (this.capturing)
      Atomics.store(c, CTRL.DUMP_FRAMES, this.dumpPos);
  }
}
