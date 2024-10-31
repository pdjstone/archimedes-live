# Archimedes Live! ([archi.medes.live](https://archi.medes.live))

Web frontend for [Arculator WASM](https://github.com/pdjstone/arculator-wasm). Still very much a work in progress, see Issues for what's left to do and known bugs.

## Current features:

* Machine picker dialog
* Disc picker / search dialog
* BASIC V editor (auto-runs/reloads in emulator)
* Load files from local machine into the emulator, including:
  * Disc images (optionally zipped) - will automatically be inserted into Drive 0
  * Archive files (e.g. [SparkFS/ArcFS](https://github.com/pdjstone/nspark-wasm)) - will automatically unpack onto HostFS
* Fullscreen
* Save screenshots using Alt+\ (backslash)
* Improve mouse support

## Supported URL options

Some features can be accessed using the hash portion of the URL (e.g. `https://archi.medes.live#foo=bar`). These are useful when linking to Archimedes Live:

* **preset** - load a preset machine configuration instead of the default A3000. Current valid values are:
  * `a310-arthur` - A310 with Arthur 1.20 ROM. ARM 2 CPU with 1MB RAM
  * `a310-ro2` - A310 with RISC OS 2 ROM. ARM 2 CPU with 1MB RAM 
  * `a3000` - A3000 with RISC OS 3. ARM 2 CPU with 2MB RAM
  * `a5000` - A5000 with RISC OS 3. ARM 3 CPU with 4MB RAM
  * `a3020` - A3020 with RISC OS 3. ARM 250 CPU with 2MB RAM 
* **disc** - a URL pointing to a disc image or RISC OS archive. If a disc image (e.g. .adf) or zipped disc image is specified, it will be inserted into drive 0. If a RISC OS compatible archive is specified (e.g. ArcFS/SparkFS), it will be unpacked into the root HostFS directory. **Note:** if the URL points to a different domain, the server must send the appropriate [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin) headers. The disc parameter can also be the ID of an title from the software catalogue (e.g. `disc=lemmings-demo`)
* **autoboot** - This will create a !Boot [Obey file](https://www.riscosopen.org/wiki/documentation/show/Introduction%20to%20Obey) on HostFS which will be run when the machine boots. The contents of the file are set to the value of this parameter. You can use this to auto-boot software loaded using the `disc` parameter. e.g. `https://archi.medes.live/#disc=https://bitshifters.github.io/content/bs-django01.zip&autoboot=desktop%20filer_run%20adfs::0.$.!Django01`. If the disc parameter specifes an item from the software catalogue which supports autoboot, this parameter may be present but empty (e.g. `#disc=lander&autoboot`) Auto boot currently only works on RISC OS 3 since it relies on HostFS.
* **basic** - This will create a !Boot [Command file](https://www.riscosopen.org/wiki/documentation/show/*Exec) on HostFS which will boot into BASIC when the emulator loads, then type and run the program contained in this parameter. You can use the BASIC editor share button to create these URLs.
* **showsoftwarebrowser** - Show the software browser when the page loads.
* **ff** - "Fast-forward" the emulator the specified number of milliseconds from boot time. When fast-forwarding, video and sound rendering are skipped, so the emulator will appear to start at the specified time. This is handy when autobooting to skip the boot and software loading time, and jump straight into the game/software. e.g. `http://archi.medes.live#ff=14400` will skip the RISC OS boot sequence and take you straight to the desktop.
* **soundfilter** - Adjust the low-pass sound filter. 0 keeps the the 'original' low-pass filter. 1 reduces the filtering and 2 sounds 'best', particularly for good-quality tracker music.
* **mouse-capture** - Controls how the mouse is handled by the emulator. One of:
  * `auto` (default) - The emulator will use to heuristics to decide when to capture the mouse, and when to use absolute mouse positioning.
  * `force` - The emulator will always capture the mouse pointer. This is useful on some games where `auto` causes problems.
  * `never`. Never capture mouse, this could be useful to avoid false-positives in the mouse capture heuristics. This will break mouse input on some games.

### Building

There are a few Python packages required to build the code. Jinja is required for HTML templating. s3cmd is required for deployment to S3. Run `pip3 install -r requirements-dev.txt` to install these.

After cloning, ensure that the git submodules are initialised and updated using `git submodule update --init`. Once done, the `arculator-wasm`, `arclive-software` and `nspark-wasm` directories should contain the source code for those projects.

Ensure Emscripten is [installed and activated](https://emscripten.org/docs/getting_started/downloads.html). Once done you should have `emsdk` in your path. Tested with Emscripten 3.1.29.

```
make
make serve
```