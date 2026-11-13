# Notes for agents

How to build Archimedes Live, run it in a headless browser, and drive it
through URL parameters and page hooks. See `README.md` for the user-facing
description of the URL options.

## Layout

- `frontend/` - the code (copied into `build/` by `make`). Each JS context
  has its own directory:
  - `frontend/*.js` - the page: UI, audio output, the page hooks
  - `frontend/worker/` - the emulator worker: the emulator, its FS, HostFS,
    software loading, JSCLI and SWI hooks
  - `frontend/worklet/` - the audio worklet
  - `frontend/shared/` - pure modules used by more than one of them (machine
    presets, the software catalogue, the audio ring layout, site paths, RPC,
    notices, mouse capture modes)

  Code that touches the emulator or its FS goes in `worker/`, and code that
  touches the DOM stays in the page. The page reaches the worker only through
  `frontend/shared/rpc.js`: worker modules make functions callable with
  `expose({name: fn})` and send events with `emit(name, detail)`; the page
  calls them as `await emu.name(...)` and listens with `on(name, fn)` (both
  from `connect(worker)` in `ui.js`). Calls resolve with what the function
  returns, or reject with what it throws. A function passed as an argument
  can be called back by the worker until the call settles (e.g. `arcCli`'s
  `onOutput`), and `transfer(value, [buffer])` moves buffers instead of
  copying them. `EmulatorInput` and `AudioInit` are still raw messages,
  posted by the submodule's own JS.
- `arculator-wasm/` - the emulator (git submodule, C compiled with Emscripten)
- `build/` - what is served. Everything the browser loads comes from here.
  `index.html`, `emu/` (ROMs) and `software/` are at the top; the code
  (frontend JS and CSS, `arculator.{js,wasm}`, `nspark/`, and the support
  ROM's modules in `worker/extnrom/`) is in `build/v/<build tag>/`, which
  `index.html` points to
- `testserver.py` - static server for `build/` with the COOP/COEP headers
- `selenium-scripts/` - headless Firefox tools (audio dump, WAV compare)

The emulator runs in a module Worker (`frontend/worker/arculator-worker.js`) and the
wasm heap is a SharedArrayBuffer, so the page **must** be cross-origin isolated.
Serve it with `testserver.py`; a plain `python -m http.server` won't work.

## Building

```sh
# Emscripten must be on PATH (emsdk activated)
make -j8                             # everything -> build/
make -C arculator-wasm -j8 wasm      # just the emulator -> arculator-wasm/build/wasm/arculator.{js,wasm}
```

The Emscripten version is pinned by `EMSCRIPTEN_VERSION` in
`arculator-wasm/emscripten.mk` (shared by both Makefiles): the wasm and
nspark builds stop if `emcc -dumpversion` differs, unless `ALLOW_ANY_EMCC=1`.

`make` hands the emulator, its extension ROM and nspark to their own builds
every time, so C changes are picked up; give it `-j` for a parallel build.
It needs `jinja2` from `requirements-dev.txt`. If the venv's `jinja2`
script has a broken shebang, run `make` with `venv/bin` first on `PATH`, or
`make JINJA2="venv/bin/python venv/bin/jinja2"`.

Each build goes in a new directory, so browsers never use a cached copy of an
old one: a clean tree's is `v/<commit>-clean`, a dirty tree's adds the time, so
every `make` of a dirty tree makes a new one (and removes the old). So code
must load its files by URLs relative to itself (`import`,
`new URL('x.js', import.meta.url)`), never relative to the page. Data at the top
level (ROMs, the catalogue) comes from `frontend/shared/paths.js`.

`make frontend` rebuilds only the page and its code (a new `v/` directory and
`index.html`), with the emulator and nspark already built (it doesn't run
their builds); it doesn't touch the ROMs or the catalogue.

For quick iteration you can skip `make` and copy the pieces into the current
version (`testserver.py` makes the browser revalidate everything):

```sh
cp arculator-wasm/build/wasm/arculator.{js,wasm} build/v/*/worker/
cp -r frontend/*.js frontend/worker frontend/worklet frontend/shared build/v/*/   # after editing frontend JS
```

`frontend/index.template.html` is only rendered by `make`. `make deploy`
uploads `v/` with an immutable cache header, adding it to the versions already
there, and the top-level pages with `no-cache`.

## Serving

```sh
venv/bin/python testserver.py 127.0.0.1 8000    # args: bind address, port
```

Run it in the background; it serves `build/` relative to the current
directory, so start it from the repo root. To serve another checkout (e.g. the
main branch for comparisons), run this `testserver.py` from that checkout's
root on another port.

## Running headless

Use Selenium with headless Firefox (`selenium` is in the venv; Selenium Manager
fetches geckodriver automatically). Minimal driver:

```python
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

opts = Options()
opts.add_argument('-headless')
# 0 = allow the AudioContext to start without a user gesture.
# 1 = blocked until a click/keypress, like a normal browser
opts.set_preference('media.autoplay.default', 0)
opts.enable_bidi = True                     # only needed to capture console output
d = webdriver.Firefox(options=opts)
logs = []
d.script.add_console_message_handler(lambda m: logs.append(m.text))
d.set_window_size(1024, 768)
d.get('http://localhost:8000/#preset=a5000&ff=14400')
...
d.quit()
```

Things to know:

- **Parameters go in the hash** (`#a=1&b=2`), not the query string. Changing
  the hash on a loaded page reloads it.
- **Audio needs a running AudioContext.** Audio dumps and audio stats only work
  once it runs, so set `media.autoplay.default` to 0. To test the user-gesture
  path, set it to 1 and click the canvas:
  `ActionChains(d).move_to_element(d.find_element(By.ID, 'canvas')).click().perform()`.
- **Keyboard and mouse input go to `#canvas`.** Send them there with ActionChains.
- **Screenshots:** use `window.arcScreenshot` (below), which takes the frame
  from the emulator's WebGL canvas. Selenium's own screenshots include the
  page's overlays, such as the suspended-audio banner.
- **The emulator runs in real time.** Each loop emulates the wall-clock time
  since the last one (at most 500 ms). While audio is playing, the audio
  clock takes over: it nudges that to keep the worklet's queue at its target,
  and drops time lost to stalls rather than catching up. The target adapts
  to underruns (60-300 ms); while the page is hidden it's 400 ms, to ride
  out background stalls, and on showing it comes down as the queue drains.
  Without a running AudioContext it's the wall clock alone. Use `ff` to skip boot rather than
  sleeping. Headless machines can stall for hundreds of ms, so treat a few
  audio underruns as environment noise unless they're reproducible.
- **Console output** from the page and worker comes through the BiDi handler
  above. `printf` in C code reaches it too. `rpclog` is silent in non-DEBUG
  builds.

## URL parameters

All are read in `getPageBootParams()` in `frontend/ui.js`.

| Parameter | Value | Effect |
|---|---|---|
| `preset` | `a310-arthur`, `a310-ro2`, `a3000` (default), `a5000`, `a3020`, `a540` | Machine configuration (`presetMachines` in `frontend/shared/machines.js`) |
| `disc` | software catalogue ID (e.g. `lander`) or a URL | Disc images (`.adf`, zipped or not) go into drive 0. RISC OS archives (Spark/ArcFS zips) are unpacked to HostFS. A catalogue ID may also choose the preset, `ff`, sound filter and mouse mode, unless you set them. |
| `autoboot` | Obey file text, or empty | Writes a HostFS `!Boot` that runs at startup (RISC OS 3 only). Leave it empty with a catalogue `disc` to use the title's own boot commands. Separate lines with `%0A`. |
| `basic` | BASIC program text | Boots into BASIC, then types and runs the program. Can't be combined with `disc`. Fast-forwards through boot. |
| `ff` | milliseconds | Fast-forward that much emulated time from boot, with no video or sound. `ff=14400` reaches the RISC OS 3 desktop. |
| `soundfilter` | `0`, `1` or `2` | Low-pass filter: 0 is the original, 2 the least filtering |
| `mouse-capture` | `auto`, `force` or `never` | Mouse handling mode |
| `showsoftwarebrowser` | (flag) | Open the software browser on load |
| `dumpaudio` | `dur,delay` (seconds) | Record `dur` s of 48 kHz stereo audio, starting `delay` s of emulated time after boot (see below). |
| `audiostats` | (flag) | Show audio stats over the display (`frontend/audio-stats-overlay.js`; tap for the full panel), and log `Audio stats: {...}` to the console every 5 s. Otherwise they're only logged when a glitch counter changes. |
| `dbglatency` | (flag) | Visual mouse-latency debugging |
| `jscli` | (flag), or `ws://127.0.0.1:PORT/TOKEN` | Put the JSCLI modules in the support ROM, for the `arcCli`, `arcCliSession` and `arcType` hooks (below); they're left out otherwise. With a URL, also connect to `tools/arcterm.py` (below), a command line for RISC OS. Only loopback addresses are accepted |

Examples:

```
#preset=a5000&ff=14400
#disc=lander&autoboot
#disc=https://bitshifters.github.io/content/bs-django01.zip&autoboot=desktop%20filer_run%20adfs::0.$.!Django01
#disc=bs-django01&autoboot&dumpaudio=5,25
#disc=arthur-welcome&preset=a5000&autoboot=*Mount%20:0%0A*Cat%20:0
```

Software delivered as a zip is unpacked to HostFS and never touches the floppy
drive. To exercise the floppy (and get disc drive noise), use a disc image and
read it from the boot commands, as in the last example.

## Page hooks for scripts

Call these with `d.execute_script('return window.arcAudioStats()')` and similar.

- **`window.arcGetAudioDump()`** returns `{state, size, base64}`.
  - `state` is `off`, `waiting`, `recording`, `finished` or `error`.
  - `base64` (a complete WAV) is only filled in once the state is `finished`, so polling stays cheap.
  - It's the stream before gain and disc noise, bit-exact with the main branch's dump of the same URL.
- **`window.arcAudioStats(resetFill = false)`** returns cumulative counters, or `null` before audio is set up.
  - Glitches: `underruns`, `silentFrames`, `overflows` (trims), `framesDropped`, `recordsDropped`, `eventsDropped`, `clips`, `ddUnderruns`.
  - Buffering: `minFillMs`, `maxFillMs`, `targetFillMs`, `trimFillMs`.
  - Emulator loop: `loopLate`, `loopGapMaxMs`, `runMaxMs`.
  - AudioContext: `ctxState`, `sampleRate`, `baseLatencyMs`, `outputLatencyMs`.
  - Stream positions: `recordsWritten`/`recordsRead`, `ticksWritten`, `frameWatermark`/`framesRead`, `resets`, `events`, `ddBlocksWritten`/`ddBlocksPlayed`.
  - `resetFill=true` resets the min/max fill and loop-gap maxima after reading them.

- **`window.arcFS`** reads and writes the emulator's Emscripten FS (it lives in
  the worker). HostFS is `/hostfs`, with file types as `,xxx` suffixes. All
  methods return Promises: `read(path)` (Uint8Array), `readText(path)`,
  `write(path, data)`, `list(dir)`, `unlink(path)`. They reject until the
  worker's FS exists, so retry while booting. HostFS buffers writes, so a file
  RISC OS still has open (OPENOUT, `*Spool`) is only complete once closed.
- **`window.arcType(text, {timeout})`** puts keys in the keyboard buffer
  through JSCLI (OS_Byte 153, so it needs `#jscli`), as if typed: `arcType('PRINT 6*7\r')`. `\r` is
  Return, `\x1b` Escape (it breaks into programs), and codes from `&80` are
  the function and cursor keys: F1-F9 are `&81`-`&89`, F10-F12 `&CA`-`&CC`
  (`'\xcc'` opens the desktop's command line). Characters are one byte each
  (Latin-1); an array of numbers and strings, or a Uint8Array, works too. Resolves once
  all are in the buffer; long text waits for the program to read some.
  Unlike `simulateKey`, nothing is dropped on a slow host.
- **`window.arcScreenshot({base64})`** resolves with a PNG of the next frame
  the emulator presents: a `Blob`, or a base64 string with `base64: true`. It's
  the size the canvas shows (double-scanned modes have their lines doubled, so
  the desktop is 640x512), without the page's overlays. Frames aren't presented
  while fast-forwarding, so it waits for a fast-forward to end. The emulator
  doesn't draw while the page is hidden, or during a fast-forward, but a
  hidden page still draws a frame for this. Rejects before the display has
  started. From selenium:

  ```python
  png = d.execute_async_script(
      'arcScreenshot({base64: true}).then(arguments[0])')
  open('x.png', 'wb').write(base64.b64decode(png))
  ```

  Alt+`\` in the page saves one as a download.
- **`window.arcFastForward(ms)`** runs flat out, with no video or sound, until
  `ms` of emulated time from now. Calling it again moves the end point. It
  returns a Promise that rejects before the emulator is running.
- **An `arcfastforward` window event** says how far a fast-forward (from
  `ff`, a catalogue title, the BASIC editor or `arcFastForward`) has got. Its
  detail is `{startMs, currentMs, targetMs, fraction}`, in emulated time since
  the last reset, when one starts and about three times a second while it
  runs, then null when it ends. Moving the end point keeps `startMs`, so
  `fraction` can go down. A reset ends a fast-forward (a machine change that
  wants one starts a new one from 0). The emulator reports it from its loop
  (`fast_forward_js_progress` in `emscripten_main.c`), and
  `frontend/worker/fast-forward.js` throttles it.
- **`window.emuinput.simulateKey(name, delayMs, holdMs)`** presses an
  Archimedes key (`ArcEscape`, `ArcF1`, ... from `emu_input.js`). Selenium's
  own key events are too short for the emulator to see; hold for about 100 ms.

- **`window.arcNotices()`** gives the notices raised so far, each `{id,
  params, level, text}`; an `arcnotice` window event, with one as its detail,
  says when there's a new one. They report what happened to a file the user
  dropped or uploaded (a disc inserted, files unpacked, or why it couldn't be
  loaded), bad URL parameters, and a `disc` that couldn't be loaded. All
  their text is in `frontend/shared/notices.js`: code raises a notice by its
  id from the `Notice` enum there, returning `{id: Notice.UNPACKED, params}`
  or throwing `new NoticeError(Notice.UNPACK_FAILED, params)` (whose
  `notice` crosses from the worker with the error), and `frontend/notify.js`
  formats and dispatches it, and shows it as a toast over the bottom of the
  display (click to dismiss). Errors without a notice only go to the console.
- **`window.arcMusicInfo()`** gives the song a program has loaded into the
  QTMTracker module, or null (`frontend/worker/qtm-info.js`, a SWI hook on
  `QTM_Load`, so it works while a demo has interrupts off). It's
  `{title, author, samples, format, tag, origin, channels, loadedFrom,
  address}`: the name, author and format are what `*QTMInfo` shows, and
  `samples` holds every sample's name, where trackers put their text. A song
  loaded from a file only gives `filename` (`loadedFrom: 'file'`). A window
  `arcmusicinfo` event, with it as its detail, says when it changes.
  `frontend/media-session.js` shows it in the OS media controls, whose
  play/pause buttons call **`window.pauseEmulator()`** and
  **`window.resumeEmulator()`** (these suspend the AudioContext too).
- **`window.arcCli(command, {via, onOutput})`** runs a `*` command and resolves
  with `{output, raw, error}`: `raw` is the VDU stream it printed, `output` the
  same as plain text, `error` `{number, message}` or null. It uses helper
  modules in the extension ROM (`arculator-wasm/src/jscli`), which are only
  there with `#jscli` in the URL, and which only RISC OS 3 loads; on RISC OS 2 they can be RMLoaded from a disc. JSCLIWimp needs
  the TaskWindow module, which RISC OS 2 doesn't have in ROM. `via:
  'callback'` (the default) uses JSCLI, which runs the command from a transient
  callback. `via: 'wimp'` uses JSCLIWimp, which runs it in a TaskWindow, in the
  desktop only. Rejects if that module isn't loaded, or after `timeout` ms (a
  command that hasn't started is removed from the queue; one that has is
  killed with `via: 'wimp'`, and with `'callback'` carries on, and its
  results are dropped). `onOutput(raw)` gets output chunks as they
  arrive. **`window.arcCliStatus()`** gives `{callback, wimp}`: which modules
  are loaded. With JSCLIWimp it adds `wimpIdleMs`, the emulated time since the
  task last checked for commands (under ~60 ms while the desktop runs, growing
  while it's suspended, e.g. at F12), and `wimpBusy`, whether it's running a
  command.
- **`window.arcCliSession(command = '', {onOutput})`** opens a TaskWindow
  that stays open, for interactive use (JSCLIWimp, so desktop only). It runs
  `command` (e.g. `'BASIC'`), or gives a `*` prompt. It returns a session at
  once:
  - `send(text)` sends input (bytes as for `arcType`).
  - `expect(pattern, {timeout})` waits for output matching a string or RegExp
    and resolves with the text up to the match, using it up.
  - `read()` takes the output so far.
  - `close()` kills the TaskWindow.
  - `done` resolves with `{error}` when it exits, and `ended` is set.

  Nothing marks the end of a command's output, so wait for the prompt:

  ```js
  s = arcCliSession('BASIC'); await s.expect('>');
  await s.send('PRINT 6*7\r'); await s.expect('>')   // 'PRINT 6*7\n        42\n>'
  ```

  The echo of what you send is part of the output. The TaskWindow module
  drops CR (13) from output, so newlines are a bare LF and `VDU 13` is lost. Input goes in 32-byte
  pieces, about 640 bytes/s, because a TaskWindow's input buffer holds only
  63 bytes. Input sent to a program that isn't reading can still be lost
  beyond that. Sessions and `arcCli(..., {via: 'wimp'})` commands run
  side by side.

## Watching SWIs

`frontend/worker/swi-hook.js` lets code in the worker watch for SWIs as the emulated
CPU calls them (`arculator-wasm/src/swihook.c`), e.g. to see what music a
program gives a tracker module. It doesn't need RISC OS, so it works while a
program has taken over the machine with interrupts off.

```js
import { addSwiHook, readMemory, readString } from './swi-hook.js'
const remove = addSwiHook(0x5, regs => console.log('OS_CLI', readString(regs[0])));
```

- A hook gets a copy of r0-r15 and runs synchronously before the SWI does. It
  sees only the call, not the results. SWI numbers are without the X bit,
  and the X form is seen too. At most 32 SWIs can be hooked at once.
- `readMemory(addr, len)` reads emulated memory at a logical address, as the
  program sees it then. It stops early at unmapped memory or I/O.
- Hooks run in the middle of the emulator, so keep them quick, and `emit`
  anything for the page (`frontend/shared/rpc.js`).

## A command line from a terminal

`tools/arcterm.py` gives a terminal a RISC OS command line through JSCLI. It's
a WebSocket server; the page connects to it (`frontend/jscli-remote.js`) when
given its URL in the `jscli` parameter, and reconnects if it restarts:

```sh
venv/bin/python tools/arcterm.py              # prints the jscli=... to put in the hash
venv/bin/python tools/arcterm.py --raw        # every key straight to RISC OS
venv/bin/python tools/arcterm.py -c 'Cat' -c 'Show Sys$Year'   # run and exit
```

- In the desktop, the default line mode runs an `arcCliSession` TaskWindow.
  The RISC OS prompt (`*`, BASIC's `>`) is the prompt, lines are edited
  locally and their echo is dropped. Ctrl-C sends Escape and Ctrl-D quits.
  Outside the desktop, each line runs as an `arcCli` command. Lines starting
  with `\` are arcterm commands (`\help`): `\cli`, `\wimp`, `\type`,
  `\open BASIC`, `\close`, `\status` and `\shot file.png`.
- `--raw` passes each key through, with cursor and function keys mapped
  and VDU codes turned into ANSI. Ctrl-D or Ctrl-] quits. A TaskWindow has no cursor
  editing, so cursor keys reach programs as key codes.
- `-c` runs commands through JSCLI (or TaskWindows with `--wimp`), prints
  their output and exits: 0 OK, 1 a command failed, 2 no connection within
  `--timeout`.
- The URL holds a random token (`--token` sets it). Connections from web pages
  other than local ones and archi.medes.live are refused (`--allow-origin`
  adds one). The page shows a "JSCLI remote" badge while it's connected.
- Sessions belong to the page and outlive the connection. When arcterm
  reconnects it carries on with its session, including what was printed
  meanwhile; a restarted arcterm takes over the newest one. One page at a
  time: when another connects, the old one is closed (code 4000) and stops
  reconnecting.
- The page connects as a client, so headless tests can use it too. Start
  arcterm with a fixed `--token`, then load the page with the matching
  `jscli`.

## Running BASIC programs

`selenium-scripts/arcbasic.py` types BASIC programs in, runs them and reports
what they printed, any error (REPORT$, ERR, ERL), and optionally a screenshot:

```sh
venv/bin/python selenium-scripts/arcbasic.py prog.bas [more.bas ...] \
    [--input LINE ...] [--timeout 10] [--turbo] [--screenshot-dir shots] [--preset a5000]
venv/bin/python selenium-scripts/arcbasic.py -e 'PRINT 6*7'
```

It can also be used as a library (`ArcBasic().run(prog)` returns a `Result`,
plus `read_file`/`write_file` for HostFS data files). Exit status: 0 OK,
1 BASIC error, 2 timeout. It boots once and runs every program in the same
session, which takes about 1 s per program after a ~5 s boot.

How it works, which is also how to do it by hand:

- Boot with `#basic=`. The page writes a HostFS `!Boot,ffe` (a Command file,
  run with `*Exec`): `*KEY1 *!boot|M`, `*basic`, the text, `RUN`. Lines
  are read as if typed, so the text can hold `*` commands and direct-mode
  lines too. A line `*Exec` stops reading the file before the final `RUN`.
- To run more code without rebooting, write a new `/hostfs/!Boot,ffe` with
  `arcFS.write` and press F1.
- `*Spool HostFS:$.Output` before `RUN` and `*Spool` after it captures
  everything printed, including BASIC's error report, as a VDU stream (strip
  control codes and their parameter bytes). Then `*Create HostFS:$.Done` marks
  the end. ERR/ERL/REPORT$ still hold the last error at the prompt.
- Lines after `RUN` are read by INPUT, GET and INKEY(+n), so they work as
  stdin. A program that reads more than it's given will read the epilogue
  instead. INKEY(-n) scans the keyboard without reading input.
- Escape (via `simulateKey`) stops a runaway program but also closes the Exec
  file, so run the epilogue again with F1.
- `*FX3,2` turns the screen off but keeps spooling, so typing in the program
  doesn't appear in screenshots. `*FX3,0` turns it back on.
- Programs can write their own files: `F%=OPENOUT "HostFS:$.Result"`,
  `BPUT#F%,"text"` (string plus LF), `CLOSE#F%`. `PRINT#` writes BASIC's binary
  format, not text. `*ScreenSave HostFS:$.Screen` saves the screen as a sprite
  file at native resolution.
- BASIC input lines are at most 255 characters, and keywords must be in
  capitals. Unnumbered lines need numbering before they're typed in.
- An A3000 runs at about real time. `--turbo` (arcFastForward) is about 5x
  faster on a slow host, but screenshots show the screen only as the program ended.

## Surveying the software catalogue

`selenium-scripts/catalogue_survey.py` boots catalogue titles (`#disc=ID&autoboot`)
and checks each one: whether JSCLI keeps responding, audio glitches, JavaScript
errors, and screenshots at the start and end. It writes `results.json` and an
HTML report (`index.html`, with a filter for each kind of problem) to
`build/survey/`, served at `http://127.0.0.1:8000/survey/`:

```sh
venv/bin/python selenium-scripts/catalogue_survey.py               # every title that autoboots
venv/bin/python selenium-scripts/catalogue_survey.py lander swiv --browsers 1 \
    --settle 20 --duration 120 --keys ''
venv/bin/python selenium-scripts/catalogue_survey.py --html-only   # remake the report
```

- After the boot fast-forward and `--settle` seconds, it records for
  `--duration` seconds: `arcCli('Echo ...')` every `--probe-interval` seconds,
  shown as `o` (answered) or `x` (no answer); `arcAudioStats()` at the start
  and end, reported as the glitch counters' increase; and `--keys` pressed one
  every `--key-interval` seconds (Space, Return, ... by default) to get past
  title screens into the game.
- `--browsers` sets how many run at once (default 2). Emulators competing for
  the CPU cause underruns, so keep it to about half the CPU count, and rerun a
  title alone (`--browsers 1`) before believing its glitches. `--keep` adds to
  the results already there.
- A JSCLI result of `none` or `stopped` means the title took over the machine
  (e.g. interrupts off), or crashed. Most titles keep it answering, at least
  on their title screens.

## Audio dump tools

```sh
venv/bin/python selenium-scripts/fetch_audio_dump.py \
    --url 'http://localhost:8000/#disc=bs-django01&autoboot' \
    --duration 5 --delay 25 --out wip
# -> build/audio-dumps/wip.wav

venv/bin/python selenium-scripts/compare_wav.py a.wav b.wav
```

`compare_wav.py` prints `exact match` (exit 0) or diagnostics: offset, first
differing frame, max difference, SNR (exit 1). Main-branch dumps of the same URL
are the reference; the dump should match them exactly. Keep the dump
`delay` at 0.1 s or more: with a shorter delay the dump starts one block later
than on main.

## Source gotchas

- **Line endings:** `arculator-wasm/src/sound.c` and `sound.h` use CRLF.
  `emscripten_main.c`, `sound_emscripten.c` and `sound_ring.h` use LF. Keep each
  file's existing endings when you edit it.
- **Shared layouts:** the audio ring layout in `arculator-wasm/src/sound_ring.h`
  is mirrored in `frontend/shared/audio-ring.js`. Change both together;
  `checkRingLayout` reports a mismatch at startup.
- **Support ROM:** the worker builds `roms/arcrom_ext` for each machine from
  the modules it needs (`SUPPORT_MODULES` in `frontend/shared/machines.js`,
  `putExtnRom` in `frontend/worker/machine-setup.js`), with
  `frontend/worker/extnrom.js`, a port of the submodule's
  `scripts/make_extnrom.py` (which still builds the native build's ROM).
  `make check` tests they make the same ROM. A new module needs adding to
  `SUPPORT_MODULES` and to `EXTNROM_MODULES` in the top-level Makefile.
- **JSCLI protocol:** the `ArcEm_JSCLI` SWI in `arculator-wasm/src/jscli.c`
  is mirrored in `arculator-wasm/src/jscli/jscli-defs.s`, and its request
  kinds and error codes in `frontend/worker/jscli-worker.js`. Change them together.
  The page hooks themselves are in `frontend/jscli-page.js`.
- **Wasm exports:** never `ccall` a wasm export before the runtime is
  initialised; it aborts the page. Worker modules get the module from
  `frontend/worker/emulator.js`: `emulator` is set in preRun (FS only), and
  `ready` (or `onReady(fn)`) says when exports can be called.
- **Native build:** the native (non-wasm) Arculator build still compiles
  `sound.c` without `ARC_AUDIO_WORKLET`. Check that path still builds after
  editing it.
- **Submodules:** `arclive-software` is a submodule maintained separately.
  Don't commit changes to it from here.
