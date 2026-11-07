/**
 * SWI hooks, for code in the worker that watches what the emulated program
 * does (arculator-wasm/src/swihook.c). A hook is called synchronously when the
 * CPU reaches a SWI instruction for its SWI number, before the SWI runs, with
 * a copy of r0-r15, and can read emulated memory with readMemory and
 * readString. It doesn't depend on RISC OS, so it works while a program has
 * turned interrupts off. It only sees the call, not the SWI's results.
 *
 *   addSwiHook(0x5, regs => console.log('OS_CLI', readString(regs[0])));
 *
 * SWI numbers are without the X bit, and a hook sees the X form too. Hooks run
 * in the middle of the emulator, so keep them quick, and post anything for
 * the page rather than awaiting.
 */

import { emulator, ready, onReady } from './emulator.js'

// The most SWIs the emulator watches at once (SWIHOOK_MAX in swihook.c)
const SWI_HOOK_MAX = 32;
const X_BIT = 0x20000;

// SWI number -> Set of hooks
const swiHooks = new Map();

// Hooks added before the runtime was initialised are sent then
onReady(updateEmulator);

/**
 * Calls fn(regs, swi) whenever the emulated CPU calls SWI swi. regs is a
 * Uint32Array of r0-r15 (r15 includes the PSR bits). Returns a function that
 * removes the hook.
 */
export function addSwiHook(swi, fn) {
  swi &= ~X_BIT;
  if (!swiHooks.has(swi)) {
    if (swiHooks.size >= SWI_HOOK_MAX)
      throw new Error(`At most ${SWI_HOOK_MAX} SWIs can be hooked`);
    swiHooks.set(swi, new Set());
  }
  swiHooks.get(swi).add(fn);
  updateEmulator();
  return () => {
    let hooks = swiHooks.get(swi);
    if (hooks && hooks.delete(fn) && hooks.size === 0) {
      swiHooks.delete(swi);
      updateEmulator();
    }
  };
}

/** Tells the emulator which SWIs to watch */
function updateEmulator() {
  if (!ready)
    return;   // onReady sends the list
  let swis = Uint32Array.from(swiHooks.keys());
  emulator.ccall('arc_swi_hook_set', 'number', ['array', 'number'],
    [new Uint8Array(swis.buffer), swis.length]);
}

// Called from swihook.c
self.arcSwiHook = (swi, regs) => {
  for (let fn of swiHooks.get(swi) || []) {
    try {
      fn(regs, swi);
    } catch (e) {
      console.error(`SWI &${swi.toString(16)} hook`, e);
    }
  }
};

/**
 * Reads len bytes of emulated memory at a logical address, as the program
 * sees it now. Stops early at memory that isn't mapped, or I/O, so the result
 * can be shorter.
 */
export function readMemory(addr, len) {
  const CHUNK = 65536;   // MEM_READ_MAX in swihook.c
  let result = new Uint8Array(len);
  let buffer = emulator.ccall('arc_mem_read_buffer', 'number', []);
  let done = 0;
  while (done < len) {
    let want = Math.min(len - done, CHUNK);
    let got = emulator.ccall('arc_mem_read', 'number', ['number', 'number'], [(addr + done) >>> 0, want]);
    result.set(emulator.HEAPU8.subarray(buffer, buffer + got), done);
    done += got;
    if (got < want)
      return result.slice(0, done);
  }
  return result;
}

/** Reads a string ended by a control character, as RISC OS strings are, in Latin-1 */
export function readString(addr, maxLen = 256) {
  let bytes = readMemory(addr, maxLen);
  let end = bytes.findIndex(b => b < 32);
  return String.fromCharCode(...(end < 0 ? bytes : bytes.subarray(0, end)));
}
