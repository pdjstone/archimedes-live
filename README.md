# Archimedes Live!

Web frontend for [Arculator WASM](https://github.com/pdjstone/arculator-wasm). Still very much a work in progress, see Issues for what's left to do and known bugs.

### Current features:

* Machine picker dialog
* Disc picker / search dialog (WIP)
* BASIC V editor (auto-runs/reloads in emulator)
* Drag/drop upload support for:
  * Disc images (optionally zipped) - will automatically be inserted into Drive 0
  * Archive files (e.g. [SparkFS/ArcFS](https://github.com/pdjstone/nspark-wasm)) - will automatically unpack onto HostFS
* Fullscreen

### Building

After cloning, ensure that the git submodules are initialised and updated using `git submodule update --init`. Once done, the arculator-wasm, arclive-software and nspark-wasm directories should contain the source code for those projects.

Ensure Emscripten is [installed and activated](https://emscripten.org/docs/getting_started/downloads.html). Once done you should have `emsdk` in your path. Tested with Emscripten 3.1.9.

```
make
make serve
```