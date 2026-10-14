/**
 * Layout of the shared audio rings. This mirrors arculator-wasm/src/sound_ring.h,
 * so keep the two in sync. It is imported by audio-dsp.js, audio-worklet.js and
 * emu-audio.js.
 */
export const RING = Object.freeze({
  CTRL_WORDS: 32,
  RESET_SLOTS: 2,      // reset slots, each laid out like an event
  EVENT_COUNT: 256,    // power of two
  EVENT_BYTES: 64,
  RECORD_COUNT: 16384, // power of two
  RECORD_BYTES: 72,
  DD_FRAMES: 16384     // mono samples at 44.1kHz, power of two
});

// Indices into the Int32 control block at the start of the ring
export const CTRL = Object.freeze({
  REC_WRITE: 0,       // emulator: records written
  REC_READ: 1,        // worklet: records consumed
  DD_WRITE: 2,        // emulator: ddnoise samples written
  DD_READ: 3,         // worklet: ddnoise samples consumed
  CTX_RUNNING: 4,     // main thread: AudioContext is running and the worklet is attached
  GAIN: 5,            // emulator: sound_gain as a Q8 multiplier
  DD_GAIN: 6,         // emulator: disc noise gain as a Q8 multiplier
  TARGET_FILL: 7,     // worklet: wanted fill, in output frames
  DUMP_STATE: 8,      // DUMP_STATE below. Emulator sets WAITING and RECORDING, worklet FINISHED
  UNDERRUNS: 9,       // worklet: times playback ran dry
  SILENT_FRAMES: 10,  // worklet: frames of silence output because of underruns
  TRIMS: 11,          // worklet: times it dropped audio because it had too much queued
  TRIM_FRAMES: 12,    // worklet: frames dropped by trims
  CLIPS: 13,          // worklet: output samples that clipped
  MIN_FILL: 14,       // worklet: minimum fill (output frames) since last reset by the main thread
  MAX_FILL: 15,       // worklet: maximum fill (output frames) since last reset by the main thread
  RECORDS_DROPPED: 16, // emulator: records dropped because the ring was full
  EVENTS_DROPPED: 17, // emulator: events dropped because the ring was full
  DD_UNDERRUNS: 18,   // worklet: times the ddnoise stream ran dry
  LOOP_GAP_MAX: 19,   // emulator: longest gap (ms) between arcloop() calls since the main thread last reset it
  LOOP_LATE: 20,      // emulator: arcloop() calls that came more than 40ms after the previous one
  RUN_MAX: 21,        // emulator: longest wall time (ms) in arc_run() since the main thread last reset it
  EVT_WRITE: 22,      // emulator: events written
  EVT_READ: 23,       // worklet: events consumed
  TICKS_WRITE: 24,    // emulator: base clock ticks in the records written
  FRAMES_READ: 25,    // worklet: output frames played since the last RESET
  RESET_ACK: 26,      // worklet: the RESET_SEQ of the last reset it applied
  DUMP_FRAMES: 27,    // worklet: frames captured so far by the audio dump
  FRAME_WM: 28,       // emulator: output frame watermark - every event that applies to a frame before this has been published
  RESET_SEQ: 29       // emulator: resets sent. The latest is in reset slot RESET_SEQ & 1
});

// Event codes
export const EVENT = Object.freeze({
  // 1 was RESET, which now has a slot of its own so that it can't be held up by a full event ring
  CLOCK: 2,   // new base clock: coefficients from record `rec`, `value` (SAMP_INC) from output frame `outFrame`
  FILTER: 3,  // new coefficients from record `rec`
  DUMP: 4     // capture `value` output frames from output frame `outFrame`
});

// Values of CTRL.DUMP_STATE
export const DUMP_STATE = Object.freeze({
  OFF: 0,
  WAITING: 1,
  RECORDING: 2,
  FINISHED: 3,
  ERROR: 4
});

export const SAMPLE_RATE = 48000;
export const DD_SAMPLE_RATE = 44100;

// Value of MIN_FILL when nothing has been measured since the last reset
export const FILL_UNSET = 0x7fffffff;

/**
 * Check the sizes above against the C struct, whose layout shows in the
 * addresses the emulator sends in AudioInit. Returns null if they match,
 * otherwise a description of the problem: if they don't match, the audio
 * would be garbage.
 */
export function checkRingLayout(msg) {
  const expect = [
    ['reset slots', msg.resetPtr - msg.ctrlPtr, RING.CTRL_WORDS * 4],
    ['events', msg.eventPtr - msg.resetPtr, RING.RESET_SLOTS * RING.EVENT_BYTES],
    ['records', msg.recordPtr - msg.eventPtr, RING.EVENT_COUNT * RING.EVENT_BYTES],
    ['disc noise', msg.ddPtr - msg.recordPtr, RING.RECORD_COUNT * RING.RECORD_BYTES]
  ];
  for (const [what, got, want] of expect) {
    if (got !== want)
      return `audio-ring.js doesn't match sound_ring.h: ${what} at offset ${got}, expected ${want}`;
  }
  return null;
}
