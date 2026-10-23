#!/usr/bin/env python
"""Boot titles from the software catalogue in Archimedes Live (headless
Firefox) and check each one: whether JSCLI keeps responding, audio glitches,
JavaScript errors, and screenshots of what it was doing. Writes results.json
and an HTML report to look through.

For each title the page is loaded with #disc=ID&autoboot, as the software
browser does. Once the boot fast-forward has ended (and --settle seconds more),
it records for --duration seconds:
  - JSCLI: every --probe-interval seconds arcCli('Echo ...') is run through
    the JSCLI module. Each probe is 'o' (it answered), 'x' (no answer within
    the interval) or '?' (an odd answer). Games that take over the machine
    (interrupts off) stop it answering.
  - Keys: --keys are pressed in turn, one every --key-interval seconds, to
    get from title screens into the game. --keys '' presses none.
  - Audio: window.arcAudioStats() at the start and end of recording. The
    report gives the glitch counters' increase over the recording, and the
    loop and fill extremes within it. Headless machines stall now and then,
    so a few underruns can be noise; rerun a title to check.
  - Screenshots at the start and end of recording (window.arcScreenshot,
    which doesn't use JSCLI).

Start the test server first (venv/bin/python testserver.py 127.0.0.1 8000).

Usage:
  selenium-scripts/catalogue_survey.py                      # every title that autoboots
  selenium-scripts/catalogue_survey.py lander elite --browsers 1
  selenium-scripts/catalogue_survey.py --settle 20 --duration 120 --keys ''
  selenium-scripts/catalogue_survey.py --html-only          # remake the report from results.json

Output (default build/survey/ in the repo, wherever it's run from, so the test server serves the report at
http://127.0.0.1:8000/survey/): results.json, index.html and shots/*.png.
Each emulator needs a few hundred MB, and they compete for the CPU, which
causes audio underruns: --browsers more than about half the CPU count makes
the audio results meaningless.
"""
import argparse
import base64
import html
import json
import queue
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

# build/survey in the repo this script is in, so it works from any directory
DEFAULT_OUT = Path(__file__).resolve().parent.parent / 'build' / 'survey'

DEFAULT_KEYS = 'ArcSpace,ArcReturn,ArcSpace,ArcDigit1,ArcSpace,ArcReturn'

# arcAudioStats() counters that count glitches, and others worth a delta
GLITCH_COUNTERS = ['underruns', 'silentFrames', 'overflows', 'framesDropped',
                   'recordsDropped', 'eventsDropped', 'clips', 'ddUnderruns']
OTHER_COUNTERS = ['loopLate', 'resets']
# Extremes since the resetFill=true read at the start of recording
EXTREMES = ['minFillMs', 'maxFillMs', 'loopGapMaxMs', 'runMaxMs', 'targetFillMs', 'ctxState']

# Each browser call is kept short: Selenium gives up on one after 120 s.
# Resolves with 'ready' once the boot fast-forward has ended (arcScreenshot only
# resolves once frames are presented again), 'waiting' if it hasn't yet, and
# 'starting' before the display exists (arcScreenshot rejects)
DISPLAY_STATE_JS = '''
  let done = arguments[0];
  Promise.race([arcScreenshot().then(() => 'ready', () => 'starting'),
                new Promise(res => setTimeout(() => res('waiting'), 3000))]).then(done, () => done('starting'));
'''
SCREENSHOT_JS = '''
  let done = arguments[0];
  Promise.race([arcScreenshot({base64: true}), new Promise(res => setTimeout(() => res(null), 5000))])
    .then(done, () => done(null));
'''
CLI_STATUS_JS = 'arcCliStatus().then(arguments[0], () => arguments[0](null))'
PROBE_JS = '''
  let [timeoutMs, done] = arguments, t = performance.now();
  arcCli('Echo survey-ok', {timeout: timeoutMs}).then(
    res => done([res.output.includes('survey-ok') ? 'o' : '?', Math.round(performance.now() - t)]),
    () => done(['x', null]));
'''
AUDIO_STATS_JS = 'try { return window.arcAudioStats(arguments[0]); } catch (e) { return null; }'
KEY_JS = 'emuinput.simulateKey(arguments[0], 0, 120)'


def fetch_catalogue(base_url):
    with urlopen(base_url.rstrip('/') + '/software/software.json') as f:
        return json.load(f)


def audio_summary(start, end):
    """The glitch counters' increase between two arcAudioStats() reads, and
    the extremes from the second"""
    if not start or not end:
        return None
    out = {k: end.get(k, 0) - start.get(k, 0) for k in GLITCH_COUNTERS + OTHER_COUNTERS if k in end}
    out.update({k: end[k] for k in EXTREMES if k in end})
    out['glitches'] = sum(out.get(k, 0) for k in GLITCH_COUNTERS if k != 'silentFrames')
    return out


def jscli_verdict(seq):
    if not seq:
        return 'skipped'
    if set(seq) == {'o'}:
        return 'ok'
    if 'o' not in seq:
        return 'none'
    if seq.rstrip('x').count('x') == 0 and seq[0] == 'o':
        return 'stopped'        # answered, then never again
    return 'intermittent'


class Surveyor:
    def __init__(self, args, catalogue, out_dir):
        self.args = args
        self.catalogue = catalogue
        self.out_dir = out_dir
        self.shots = out_dir / 'shots'
        self.shots.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        # Selenium Manager corrupts its metadata file if browsers start at once
        self.start_lock = threading.Lock()
        self.results = {}

    def browser(self):
        opts = Options()
        opts.add_argument('-headless')
        opts.set_preference('media.autoplay.default', 0)    # audio without a click
        opts.enable_bidi = True
        with self.start_lock:
            d = webdriver.Firefox(options=opts)
        d.set_window_size(1024, 768)
        d.set_script_timeout(30)
        d.survey_errors = []
        d.script.add_javascript_error_handler(lambda e: d.survey_errors.append(e.text))
        d.script.add_console_message_handler(
            lambda m: d.survey_errors.append(m.text) if m.level == 'error' else None)
        return d

    def save_shot(self, sid, which, b64):
        if not b64:
            return None
        path = self.shots / f'{sid}-{which}.png'
        path.write_bytes(base64.b64decode(b64))
        return f'shots/{path.name}'

    def survey(self, d, sid):
        a = self.args
        meta = self.catalogue[sid]
        # The title's own boot commands, unless --params gives its own autoboot
        own_autoboot = any(p.split('=')[0] == 'autoboot' for p in a.params.split('&'))
        hash_ = f'disc={sid}' + ('' if own_autoboot else '&autoboot') + (f'&{a.params}' if a.params else '')
        r = {'id': sid, 'title': meta.get('title', sid), 'tags': meta.get('tags', []),
             'hash': hash_, 'time': datetime.now().isoformat(timespec='seconds')}
        d.survey_errors.clear()
        d.get('about:blank')
        d.get(f'{a.url.rstrip("/")}/#{hash_}')
        t0 = time.time()
        while (state := d.execute_async_script(DISPLAY_STATE_JS)) != 'ready':
            if time.time() - t0 > a.boot_timeout:
                r['boot'] = 'no display' if state == 'starting' else 'still fast-forwarding'
                r['errors'] = d.survey_errors[:10]
                return r
            time.sleep(1)
        r['boot'] = 'ok'
        r['bootSeconds'] = round(time.time() - t0, 1)
        time.sleep(a.settle)

        stats_start = d.execute_script(AUDIO_STATS_JS, True)
        r['shotStart'] = self.save_shot(sid, 'start', d.execute_async_script(SCREENSHOT_JS))
        cli_status = d.execute_async_script(CLI_STATUS_JS)
        keys = [k for k in a.keys.split(',') if k]
        probe_timeout = max(500, min(3000, a.probe_interval * 1000 - 500))
        seq, probe_ms = '', []
        t0 = time.monotonic()
        next_probe = t0 if not a.no_jscli else float('inf')
        next_key = t0 + a.key_interval
        while (now := time.monotonic()) < t0 + a.duration:
            if now >= next_key and keys:
                d.execute_script(KEY_JS, keys.pop(0))
                next_key += a.key_interval
            if now >= next_probe:
                c, ms = d.execute_async_script(PROBE_JS, probe_timeout)
                seq += c
                if ms is not None:
                    probe_ms.append(ms)
                next_probe += a.probe_interval
            time.sleep(max(0, min(next_probe, next_key if keys else float('inf'), t0 + a.duration) - time.monotonic()))
        stats_end = d.execute_script(AUDIO_STATS_JS, False)
        r['shotEnd'] = self.save_shot(sid, 'end', d.execute_async_script(SCREENSHOT_JS))
        r['jscli'] = {'seq': seq, 'verdict': jscli_verdict(seq), 'probeMs': probe_ms, 'status': cli_status}
        r['audio'] = audio_summary(stats_start, stats_end)
        r['errors'] = d.survey_errors[:10]
        return r

    def worker(self, ids):
        d = None
        while True:
            try:
                sid = ids.get_nowait()
            except queue.Empty:
                break
            try:
                if d is None:
                    d = self.browser()
                r = self.survey(d, sid)
            except Exception as e:
                r = {'id': sid, 'title': self.catalogue[sid].get('title', sid),
                     'tags': self.catalogue[sid].get('tags', []),
                     'boot': f'harness error: {type(e).__name__}: {str(e)[:300]}'}
                # A fresh browser for the next title
                try:
                    d.quit()
                except Exception:
                    pass
                d = None
            with self.lock:
                self.results[sid] = r
                self.save()
                audio = r.get('audio') or {}
                print(f"{sid:28} boot={r['boot']:10} jscli={r.get('jscli', {}).get('seq', '-'):16} "
                      f"glitches={audio.get('glitches', '-')}", flush=True)
        if d:
            d.quit()

    def run(self, ids):
        q = queue.Queue()
        for sid in ids:
            q.put(sid)
        threads = [threading.Thread(target=self.worker, args=(q,)) for _ in range(min(self.args.browsers, len(ids)))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    def save(self):
        a = self.args
        data = {'settings': {k: getattr(a, k) for k in
                             ('url', 'params', 'browsers', 'settle', 'duration', 'probe_interval',
                              'keys', 'key_interval', 'no_jscli')},
                'results': self.results}
        (self.out_dir / 'results.json').write_text(json.dumps(data, indent=1))
        write_html(self.out_dir, data)


def write_html(out_dir, data):
    results = sorted(data['results'].values(), key=lambda r: r['id'])
    s = data['settings']

    def problems(r):
        p = []
        if r.get('boot') != 'ok':
            p.append('boot')
        if r.get('jscli', {}).get('verdict') not in (None, 'ok', 'skipped'):
            p.append('jscli')
        if (r.get('audio') or {}).get('glitches'):
            p.append('audio')
        if r.get('errors'):
            p.append('errors')
        return p

    counts = {k: sum(k in problems(r) for r in results) for k in ('boot', 'jscli', 'audio', 'errors')}
    cards = []
    for r in results:
        e = html.escape
        p = problems(r)
        jscli = r.get('jscli') or {}
        audio = r.get('audio')
        seq = ''.join(f'<span class="p{c}">{c}</span>' for c in jscli.get('seq', ''))
        shots = ''.join(
            f'<figure><a href="{e(r[k])}" target="_blank"><img src="{e(r[k])}" loading="lazy" alt=""></a>'
            f'<figcaption>{label}</figcaption></figure>'
            for k, label in (('shotStart', 'start'), ('shotEnd', 'end')) if r.get(k))
        rows = []
        if r.get('boot') == 'ok':
            rows.append(('Boot', f"{r.get('bootSeconds')} s"))
            rows.append(('JSCLI', f'<span class="verdict {e(jscli.get("verdict", ""))}">{e(jscli.get("verdict", ""))}</span> '
                                  f'<code class="seq">{seq}</code>'))
            if audio:
                glitch = ', '.join(f'{k} {audio[k]}' for k in GLITCH_COUNTERS if audio.get(k))
                rows.append(('Audio', f'<span class="{"bad" if audio["glitches"] else "good"}">'
                                      f'{e(glitch) or "no glitches"}</span>'))
                rows.append(('Fill', f"{audio.get('minFillMs')}–{audio.get('maxFillMs')} ms "
                                     f"(target {audio.get('targetFillMs')}), {e(str(audio.get('ctxState')))}"))
                rows.append(('Loop', f"gap max {audio.get('loopGapMaxMs')} ms, run max {audio.get('runMaxMs')} ms, "
                                     f"{audio.get('loopLate', 0)} late, {audio.get('resets', 0)} stream resets"))
            else:
                rows.append(('Audio', '<span class="bad">no stats (audio not set up)</span>'))
        else:
            rows.append(('Boot', f'<span class="bad">{e(r.get("boot", ""))}</span>'))
        if r.get('errors'):
            rows.append(('Errors', '<br>'.join(e(x[:300]) for x in r['errors'])))
        table = ''.join(f'<tr><th>{k}</th><td>{v}</td></tr>' for k, v in rows)
        link = f'{s["url"].rstrip("/")}/#{r.get("hash", "")}'
        cards.append(
            f'<article data-problems="{" ".join(p)}"><h2><a href="{e(link)}" target="_blank">{e(r["title"])}</a> '
            f'<small>{e(r["id"])} · {e(", ".join(r.get("tags", [])))}</small></h2>'
            f'<div class="shots">{shots}</div><table>{table}</table></article>')

    settings = ', '.join(f'{k} {v!r}' for k, v in s.items())
    filters = ''.join(f'<button data-filter="{k}">{k} ({counts[k]})</button>' for k in counts)
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catalogue survey</title>
<style>
:root {{ --bg: #fff; --fg: #1a1a1a; --muted: #666; --card: #f4f4f4; --line: #ddd; --good: #1a7f37; --bad: #c62828; --warn: #b26a00; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #161616; --fg: #e8e8e8; --muted: #999; --card: #222; --line: #383838; --good: #5fd068; --bad: #ff6b6b; --warn: #ffb74d; }} }}
body {{ background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; margin: 0 16px 32px; }}
header {{ position: sticky; top: 0; background: var(--bg); padding: 12px 0 8px; border-bottom: 1px solid var(--line); z-index: 1; }}
h1 {{ font-size: 20px; margin: 0 0 4px; }}
header p {{ margin: 4px 0; color: var(--muted); font-size: 12px; }}
button {{ font: inherit; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 3px 10px; cursor: pointer; }}
button.on {{ border-color: var(--fg); font-weight: 600; }}
main {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 560px), 1fr)); gap: 12px; margin-top: 12px; }}
article {{ background: var(--card); border-radius: 6px; padding: 10px 12px; min-width: 0; }}
article[data-problems~="boot"], article[data-problems~="jscli"] {{ box-shadow: inset 4px 0 var(--bad); }}
article[data-problems~="audio"]:not([data-problems~="jscli"]):not([data-problems~="boot"]) {{ box-shadow: inset 4px 0 var(--warn); }}
h2 {{ font-size: 15px; margin: 0 0 8px; }}
h2 a {{ color: inherit; }}
h2 small {{ color: var(--muted); font-weight: normal; }}
.shots {{ display: flex; gap: 8px; }}
figure {{ margin: 0; flex: 1; min-width: 0; }}
figure img {{ width: 100%; image-rendering: pixelated; display: block; border: 1px solid var(--line); }}
figcaption {{ color: var(--muted); font-size: 11px; }}
table {{ border-collapse: collapse; margin-top: 6px; width: 100%; }}
th {{ text-align: left; color: var(--muted); font-weight: normal; padding: 2px 10px 2px 0; vertical-align: top; width: 4.5em; }}
td {{ padding: 2px 0; overflow-wrap: anywhere; }}
.good, .verdict.ok {{ color: var(--good); }}
.bad, .verdict.none, .verdict.stopped, .verdict.intermittent {{ color: var(--bad); }}
.seq {{ letter-spacing: 1px; }}
.po {{ color: var(--good); }} .px, .p\\? {{ color: var(--bad); }}
</style></head><body>
<header><h1>Catalogue survey</h1>
<p>{len(results)} titles. {html.escape(settings)}</p>
<p>Problems: <button data-filter="" class="on">all</button> {filters}</p></header>
<main>{''.join(cards)}</main>
<script>
for (let b of document.querySelectorAll('button[data-filter]')) {{
  b.onclick = () => {{
    document.querySelectorAll('button[data-filter]').forEach(x => x.classList.toggle('on', x == b));
    for (let a of document.querySelectorAll('article')) {{
      a.hidden = b.dataset.filter && !a.dataset.problems.split(' ').includes(b.dataset.filter);
    }}
  }};
}}
</script></body></html>
'''
    (out_dir / 'index.html').write_text(page)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ids', nargs='*', help='catalogue IDs (default: every title with an autoboot app)')
    ap.add_argument('--url', default='http://127.0.0.1:8000/', help='Archimedes Live (default %(default)s)')
    ap.add_argument('--params', default='',
                    help="more hash parameters, e.g. 'preset=a5000'. An autoboot here replaces the "
                         "title's own boot commands (and then its ff-ms isn't used)")
    ap.add_argument('--browsers', type=int, default=2, help='browsers to run at once (default %(default)s)')
    ap.add_argument('--settle', type=float, default=10,
                    help='seconds to wait after the boot fast-forward before recording (default %(default)s)')
    ap.add_argument('--duration', type=float, default=60, help='seconds to record (default %(default)s)')
    ap.add_argument('--probe-interval', type=float, default=5,
                    help='seconds between JSCLI probes (default %(default)s)')
    ap.add_argument('--no-jscli', action='store_true', help="don't probe JSCLI")
    ap.add_argument('--keys', default=DEFAULT_KEYS,
                    help="Archimedes keys (emu_input.js names) to press in turn while recording "
                         "(default %(default)s; '' for none)")
    ap.add_argument('--key-interval', type=float, default=10,
                    help='seconds between key presses (default %(default)s)')
    ap.add_argument('--boot-timeout', type=float, default=150,
                    help='seconds to wait for the display after loading (default %(default)s)')
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT, help='output directory (default %(default)s)')
    ap.add_argument('--html-only', action='store_true', help='just remake index.html from results.json')
    ap.add_argument('--keep', action='store_true',
                    help="add to the results already in --out instead of starting afresh")
    args = ap.parse_args()

    out_dir = args.out
    if args.html_only:
        write_html(out_dir, json.loads((out_dir / 'results.json').read_text()))
        print(f'Wrote {out_dir / "index.html"}')
        return 0

    catalogue = fetch_catalogue(args.url)
    if args.ids:
        unknown = [i for i in args.ids if i not in catalogue]
        if unknown:
            ap.error(f'not in the catalogue: {", ".join(unknown)}')
        ids = args.ids
    else:
        ids = [k for k, v in catalogue.items() if 'app-path' in v or 'autoboot' in v]

    surveyor = Surveyor(args, catalogue, out_dir)
    if args.keep and (out_dir / 'results.json').exists():
        surveyor.results = json.loads((out_dir / 'results.json').read_text())['results']
    per_title = args.settle + args.duration + 20
    print(f'Surveying {len(ids)} titles with {args.browsers} browser(s): about '
          f'{len(ids) * per_title / max(1, min(args.browsers, len(ids))) / 60:.0f} minutes', flush=True)
    surveyor.run(ids)
    print(f'Wrote {out_dir / "results.json"} and {out_dir / "index.html"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
