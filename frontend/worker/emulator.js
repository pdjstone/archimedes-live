/**
 * The emulator's Emscripten module, for the worker's modules: its FS (with
 * HostFS under /hostfs) and its exports. Set in preRun, so FS can be used
 * from then on; call exports only once the runtime is initialised.
 */

export let emulator = null;

export function setEmulator(module) {
  emulator = module;
}
