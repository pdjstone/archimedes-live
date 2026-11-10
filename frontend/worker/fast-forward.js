/**
 * Fast-forwards: the emulator runs flat out, without sound or video, until an
 * emulated time. The emulator reports how far one has got
 * (fast_forward_js_progress in emscripten_main.c), and this sends it to the
 * page as 'fastForward' events, at most a few a second:
 * {startMs, currentMs, targetMs, fraction} while one runs, then null when it
 * ends (it finished, or a reset stopped it).
 */
import { emulator } from './emulator.js'
import { emit } from '../shared/rpc.js'

const MIN_INTERVAL_MS = 300;

let active = false;
let lastSent = 0;

self.arcFastForwardProgress = (startMs, currentMs, targetMs, nowActive) => {
  let now = performance.now();
  // Always send the start and the end
  if (nowActive && active && now - lastSent < MIN_INTERVAL_MS)
    return;
  if (!nowActive && !active)
    return;
  active = nowActive;
  lastSent = now;
  let span = targetMs - startMs;
  emit('fastForward', nowActive ? {
    startMs, currentMs, targetMs,
    fraction: span > 0 ? Math.min(1, Math.max(0, (currentMs - startMs) / span)) : 1,
  } : null);
};

/** Fast-forward until `ms` of emulated time since the last reset */
export function arc_fast_forward(ms) {
  console.log(`Fast-forwarding emulator to ${ms}ms`);
  emulator.ccall('arc_fast_forward', null, ['number'], [ms]);
}
