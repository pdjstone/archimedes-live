#!/usr/bin/env python
"""Load the app in headless Firefox with the `dumpaudio` parameter set, wait for
the emulator to finish recording, then pull the dump through the page's
arcGetAudioDump() hook and save it locally.

The emulator writes the dump itself (see arc_dump_audio in arculator-wasm). The
page exposes it through window.arcGetAudioDump(), which is implemented on both
the main and worker-refactor branches, so this script works against either.

Start the test server first (python3 testserver.py -d build, or `make serve`).

Usage:
  scripts/fetch_audio_dump.py --duration 5 --delay 10
  scripts/fetch_audio_dump.py --url 'http://localhost:8000/#dumpaudio=5,10'
Dumps are written to build/audio-dumps/NAME.wav
"""
import argparse
import base64
import sys
import time
import wave
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

DUMP_DIR = Path(__file__).resolve().parent.parent / 'build' / 'audio-dumps'

# The branch-agnostic dump interface (see frontend/ui.js). Returns
# {state, size, base64} where state is 'off', 'waiting', 'recording',
# 'finished' or 'error'.
JS_GET_DUMP = """
if (typeof window.arcGetAudioDump !== 'function')
  return {state: 'error', size: 0, base64: null,
          reason: 'window.arcGetAudioDump is not defined - is the frontend up to date?'};
try {
  return window.arcGetAudioDump();
} catch (e) {
  return {state: 'error', size: 0, base64: null, reason: 'error: ' + e};
}
"""


def build_url(base, duration, delay):
    """Merge dumpaudio=<duration>,<delay> into the URL's hash.

    The frontend reads its parameters from the hash fragment, not the query string."""
    parts = urlsplit(base)
    params = parse_qs(parts.fragment, keep_blank_values=True)
    if duration is not None:
        params['dumpaudio'] = [f'{duration},{delay}']
    return urlunsplit((parts.scheme, parts.netloc, parts.path,
                       parts.query, urlencode(params, doseq=True)))


def describe(dump):
    if not dump:
        return 'no response from page'
    state = dump.get('state')
    if state == 'finished':
        return 'complete'
    if state == 'error':
        return dump.get('reason', 'error')
    if state == 'off':
        return 'no dump requested yet'
    return f"{state} ({dump.get('size', 0)} bytes so far)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://localhost:8000/',
                    help='page URL, optionally already including a dumpaudio parameter')
    ap.add_argument('--duration', type=float, default=None,
                    help='seconds of audio to record (default: take from --url)')
    ap.add_argument('--delay', type=float, default=0,
                    help='seconds of emulation to wait before recording starts')
    ap.add_argument('--out', default='audio_dump', help='output name (without .wav)')
    ap.add_argument('--outdir', default=None, help=f'output directory (default: {DUMP_DIR})')
    ap.add_argument('--timeout', type=float, default=180,
                    help='seconds to wait for the dump to finish')
    args = ap.parse_args()

    url = build_url(args.url, args.duration, args.delay)
    expected = args.duration
    if expected is None:
        # Fall back to whatever the URL already asked for, so --timeout and the
        # frame count check make sense either way.
        frag = parse_qs(urlsplit(url).fragment)
        if 'dumpaudio' in frag:
            expected = float(frag['dumpaudio'][0].split(',')[0])

    outdir = Path(args.outdir) if args.outdir else DUMP_DIR
    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / f'{args.out}.wav'
    path.unlink(missing_ok=True)

    print('loading', url, flush=True)
    opts = Options()
    opts.add_argument('-headless')
    # Allow the AudioContext to start without a user gesture, so that headless
    # runs behave like a normal browser session. The dump itself does not
    # depend on audio playing on this branch, but the AudioWorklet branch does.
    opts.set_preference('media.autoplay.default', 0)
    driver = webdriver.Firefox(options=opts)
    try:
        driver.set_window_size(1024, 768)
        driver.get(url)

        dump, deadline = None, time.monotonic() + args.timeout
        last_report = 0.0
        while time.monotonic() < deadline:
            dump = driver.execute_script(JS_GET_DUMP)
            if dump and dump.get('state') == 'finished':
                break
            now = time.monotonic()
            if now - last_report > 5:
                print(f'  waiting: {describe(dump)}', flush=True)
                last_report = now
            time.sleep(1.0)
        else:
            print(f'timed out after {args.timeout}s: {describe(dump)}', file=sys.stderr)
            return 1

        if not dump.get('base64'):
            print(f'dump finished but no data was returned: {describe(dump)}',
                  file=sys.stderr)
            return 1
        wav_bytes = base64.b64decode(dump['base64'])
        path.write_bytes(wav_bytes)
    finally:
        try:
            driver.quit()
        except Exception:
            pass

    with wave.open(str(path), 'rb') as w:
        frame_count = w.getnframes()
        print(f'saved {path} ({len(wav_bytes)} bytes)')
        print(f'  {w.getnchannels()} channels, {w.getsampwidth() * 8} bit, '
              f'{w.getframerate()} Hz')
        print(f'  {frame_count} frames ({frame_count / w.getframerate():.3f}s)')
    if expected is not None:
        want = expected * 48000
        if abs(frame_count - want) > 1:
            print(f'  warning: expected {want:.0f} frames for {expected}s', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
