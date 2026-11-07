/**
 * The emulator's Emscripten module, for the worker's modules. It's ready in
 * two stages:
 *
 * - `emulator` is set in preRun. From then on its FS (with HostFS under
 *   /hostfs) can be used, but not its exports.
 * - `ready` is set once the runtime is initialised. Only then can exports be
 *   called (ccall); calling one sooner aborts the page.
 */

export let emulator = null;
export let ready = false;

const readyCallbacks = [];

export function setEmulator(module) {
  emulator = module;
}

export function setReady() {
  ready = true;
  for (let fn of readyCallbacks.splice(0))
    fn();
}

/** Calls fn once the runtime is initialised, or now if it is */
export function onReady(fn) {
  if (ready)
    fn();
  else
    readyCallbacks.push(fn);
}
