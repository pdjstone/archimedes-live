/**
 * Layout of the shared audio ring. This mirrors arculator-wasm/src/sound_ring.h,
 * so keep the two in sync. It is imported by both audio-worklet.js and
 * emu-audio.js.
 */
export const RING = Object.freeze({
  AUDIO_FRAMES: 16384, // stereo frames at 48kHz, power of two
  DD_FRAMES: 16384,    // mono samples at 44.1kHz, power of two
  CTRL_WORDS: 32
});

// Indices into the Int32 control block at the start of the ring
export const CTRL = Object.freeze({
  WRITE: 0,          // emulator: stereo frames written (free running, modulo 2^32)
  READ: 1,           // worklet: stereo frames consumed
  DD_WRITE: 2,       // emulator: ddnoise samples written
  DD_READ: 3,        // worklet: ddnoise samples consumed
  CTX_RUNNING: 4,    // main thread: AudioContext is running and the worklet is attached
  GAIN: 5,           // emulator: sound_gain as a Q8 multiplier
  DD_GAIN: 6,        // emulator: disc noise gain as a Q8 multiplier
  TARGET_FILL: 7,    // worklet: wanted fill, in stereo frames
  FLUSH: 8,          // main thread: bumped on resume so the worklet drops stale audio
  UNDERRUNS: 9,      // worklet: times playback ran dry
  SILENT_FRAMES: 10, // worklet: frames of silence output because of underruns
  TRIMS: 11,         // worklet: times it dropped audio because the ring was overfull
  TRIM_FRAMES: 12,   // worklet: frames dropped by trims
  CLIPS: 13,         // worklet: output samples that clipped
  MIN_FILL: 14,      // worklet: minimum fill (frames) since last reset
  MAX_FILL: 15,      // worklet: maximum fill (frames) since last reset
  BLOCKS_DROPPED: 16, // emulator: 50ms blocks dropped because the ring was full
  BLOCKS_WRITTEN: 17, // emulator: 50ms blocks written
  DD_UNDERRUNS: 18,  // worklet: times the ddnoise stream ran dry
  LOOP_GAP_MAX: 19,  // emulator: longest gap (ms) between arcloop() calls since the main thread last reset it
  LOOP_LATE: 20,     // emulator: arcloop() calls that came more than 40ms after the previous one
  RUN_MAX: 21        // emulator: longest wall time (ms) in arc_run() since the main thread last reset it
});

export const SAMPLE_RATE = 48000;
export const DD_SAMPLE_RATE = 44100;

// Value of MIN_FILL when nothing has been measured since the last reset
export const FILL_UNSET = 0x7fffffff;
