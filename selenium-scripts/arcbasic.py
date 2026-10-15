#!/usr/bin/env python
"""Run BBC BASIC programs in Archimedes Live (headless Firefox) and collect
what they print, any error, and optionally a screenshot.

How it works:
  - The page is booted once with the `basic` URL parameter. That makes a
    HostFS !Boot (a Command file, so it's *Exec'd) which sets F1 to `*!boot`,
    enters BASIC and creates a Ready marker file.
  - For each program, a new HostFS !Boot,ffe is written through the page's
    window.arcFS hook and F1 is pressed. The Exec file restarts BASIC, types
    the program in, then does:
        *Spool HostFS:$.Output    everything the program prints
        RUN
        <input lines>             read by INPUT/GET/INKEY, like stdin
        *Spool HostFS:$.Status
        PRINT "STATUS:";ERR;":";ERL;":";REPORT$
        *Spool
        *Create HostFS:$.Done     marker: the spool files are closed
  - The script polls for the Done marker and reads the files back.
  - On a timeout it takes the screenshot, presses Escape and runs the epilogue
    again (Escape closes the Exec file, so the original one never runs).

A program that reads more input than it's given will read the epilogue
instead, and so will time out. Programs that poll with INKEY(+n) consume input
too; use INKEY(-n) to test keys without reading the input stream.

Start the test server first (venv/bin/python testserver.py 127.0.0.1 8000).

Usage:
  selenium-scripts/arcbasic.py prog.bas [more.bas ...]
  selenium-scripts/arcbasic.py -e 'PRINT 6*7'
  selenium-scripts/arcbasic.py game.bas --timeout 5 --screenshot-dir shots
  selenium-scripts/arcbasic.py ask.bas --input Paul --input 42

Programs without line numbers are numbered 10, 20, ... (lines must not be
longer than 255 characters, and keywords must be in capitals). Exit status is
0 if every program ran without error, 1 for a BASIC error, 2 for a timeout.

As a library:
  with ArcBasic() as arc:
      r = arc.run('PRINT 6*7')
      print(r.output, r.error, r.error_line)
"""
import argparse
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

HOSTFS = '/hostfs'

# Parameter bytes taken by each VDU control code
VDU_PARAMS = {1: 1, 17: 1, 18: 2, 19: 5, 22: 1, 23: 9, 24: 8, 25: 5,
              28: 4, 29: 4, 31: 2}


def vdu_to_text(raw):
    """Turn a spooled VDU stream into plain text: drop control codes and their
    parameters, keep printable characters and line feeds."""
    out = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == 10:
            out.append('\n')
        elif c in VDU_PARAMS:
            i += VDU_PARAMS[c]
        elif c >= 32 and c != 127:
            out.append(chr(c))
        i += 1
    return ''.join(out)


def number_lines(prog):
    """Return the program as a list of lines, numbering them if none are."""
    lines = [l.rstrip('\r') for l in prog.split('\n')]
    lines = [l for l in lines if l.strip()]
    if any(re.match(r'\s*\d', l) for l in lines):
        return lines
    return [f'{(n + 1) * 10} {l}' for n, l in enumerate(lines)]


# *FX3,2 turns off the screen (VDU driver) but not the spool file, so typing
# the program in and the epilogue don't clutter screenshots
PROLOGUE = [
    '*FX3,2',
    '*basic',
    '*Spool HostFS:$.Entry',
]
RUN = [
    '*Spool HostFS:$.Output',
    '*FX3,0',
    'MODE MODE:RUN',  # one line, so its echo is cleared before the program runs
]
def split_unread_input(text, inputs):
    """Strip the prompt and epilogue echo from the end of the output. Input
    lines the program didn't read are typed in at the BASIC prompt after it
    ends, so they show up as '>line' (plus any error they cause). Return the
    program's output and the list of unread lines."""
    lines = text.split('\n')
    # Trailing prompt, the epilogue's echo (or F1's after an Escape), blanks
    while lines and re.fullmatch(r'>?(\*FX3,2|\*!boot|\*Spool HostFS:\$\.Status)?\s*', lines[-1]):
        lines.pop()
    cut = len(lines)
    j = len(inputs)
    for i in range(len(lines) - 1, -1, -1):
        l = lines[i]
        if j > 0 and l == '>' + inputs[j - 1]:
            j -= 1
            cut = i
        elif l.startswith('>') and l != '>':
            break
        # else output from an unread line (e.g. Mistake): only dropped if an
        # unread line comes before it
    # A bare prompt just before is the line ending left after a GET
    while cut > 0 and cut < len(lines) and lines[cut - 1] == '>':
        cut -= 1
    out = '\n'.join(lines[:cut]).rstrip('\n')
    return (out + '\n' if out.strip() else ''), inputs[j:]


EPILOGUE = [
    '*FX3,2',
    '*Spool HostFS:$.Status',
    'PRINT "STATUS:";ERR;":";ERL;":";REPORT$',
    '*Spool',
    '*Create HostFS:$.Done',
    '*FX3,0',
]


@dataclass
class Result:
    output: str = ''            # what the program printed, as text
    raw: bytes = b''            # the spooled VDU stream, including the RUN echo
    error: str | None = None    # REPORT$ if the program stopped with an error
    error_number: int = 0       # ERR
    error_line: int = 0         # ERL
    handled_error: str | None = None  # an error the program trapped with ON ERROR
    entry_errors: list = field(default_factory=list)  # errors typing the program in
    unread_input: list = field(default_factory=list)  # input lines the program didn't read
    timed_out: bool = False
    seconds: float = 0.0
    screenshot: str | None = None

    @property
    def ok(self):
        return not self.error and not self.timed_out and not self.entry_errors

    def describe(self):
        s = self.output.rstrip('\n')
        if self.entry_errors:
            s += '\n[entry errors] ' + '; '.join(self.entry_errors)
        if self.unread_input:
            s += f'\n[unread input] {self.unread_input}'
        if self.timed_out:
            s += f'\n[timed out after {self.seconds:.1f}s]'
        if self.error:
            s += (f'\n[error {self.error_number}] ' if self.error_number else '\n[error] ') + \
                 self.error + \
                 (f' at line {self.error_line}' if self.error_line else '')
        return s.lstrip('\n') + '\n'


class ArcBasic:
    def __init__(self, url='http://localhost:8000/', preset=None,
                 headless=True, console=False, turbo=False):
        self.url = url.split('#')[0]
        self.turbo = turbo
        self.preset = preset
        self.headless = headless
        self.console = console
        self.logs = []
        self.driver = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.close()

    def start(self):
        opts = Options()
        if self.headless:
            opts.add_argument('-headless')
        opts.set_preference('media.autoplay.default', 0)
        opts.enable_bidi = True
        self.driver = webdriver.Firefox(options=opts)
        self.driver.script.add_console_message_handler(self._on_console)
        self.driver.script.add_javascript_error_handler(
            lambda e: self._on_console(e, 'JS error: '))
        self.driver.set_window_size(1024, 768)
        self.boot()

    def close(self):
        if self.driver:
            # Firefox takes ~10 s to quit with the emulator still running
            self.driver.get('about:blank')
            self.driver.quit()
            self.driver = None

    def _on_console(self, msg, prefix=''):
        self.logs.append(prefix + msg.text)
        if self.console:
            print(prefix + msg.text, file=sys.stderr)

    def boot(self, timeout=60):
        """(Re)load the page and wait until BASIC is ready for F1."""
        # The page wraps this as *KEY1 *!boot|M, *basic, <this>, RUN.
        # *Exec stops reading the !Boot before it gets to RUN.
        boot = '*Create HostFS:$.Ready\n*Exec'
        hash_ = 'basic=' + quote(boot, safe='')
        if self.preset:
            hash_ += '&preset=' + quote(self.preset)
        self.driver.get('about:blank')  # a hash change alone would just reload
        self.driver.get(self.url + '#' + hash_)
        if not self._wait_for('Ready', timeout):
            raise RuntimeError('Emulator did not boot to BASIC')

    # --- HostFS access -----------------------------------------------------

    def _js(self, script, *args):
        return self.driver.execute_script(script, *args)

    def list_dir(self, path=HOSTFS):
        try:
            return self._js('return arcFS.list(arguments[0])', path)
        except Exception:
            return []  # FS isn't ready until the worker has loaded the wasm

    def _hostfs_name(self, name):
        """Find a HostFS file by its RISC OS name, ignoring any ,xxx suffix."""
        for f in self.list_dir():
            if f.lower() == name.lower() or f.lower().startswith(name.lower() + ','):
                return f
        return None

    def read_file(self, name):
        """Read a file from the root of HostFS by RISC OS name, as bytes."""
        f = self._hostfs_name(name)
        if f is None:
            return None
        data = self._js('return arcFS.read(arguments[0]).then(a => Array.from(a))',
                        f'{HOSTFS}/{f}')
        return bytes(data)

    def write_file(self, name, data, filetype=0xfff):
        """Write a file to the root of HostFS, e.g. data for a program to read."""
        if isinstance(data, str):
            data = data.encode('latin-1')
        self.delete_file(name)
        self._js('return arcFS.write(arguments[0], new Uint8Array(arguments[1]))',
                 f'{HOSTFS}/{name},{filetype:03x}', list(data))

    def delete_file(self, name):
        f = self._hostfs_name(name)
        if f is not None:
            self._js('return arcFS.unlink(arguments[0])', f'{HOSTFS}/{f}')

    def _wait_for(self, name, timeout, turbo=False):
        end = time.time() + timeout
        while time.time() < end:
            if turbo:
                # Keep fast-forwarding about a second of emulated time ahead
                self._js('arcFastForward(1000)')
            if self._hostfs_name(name):
                if turbo:
                    time.sleep(0.2)  # let the fast-forward finish, so video is back on
                return True
            time.sleep(0.1)
        if turbo:
            time.sleep(0.2)
        return False

    # --- Input -------------------------------------------------------------

    def press(self, key, hold_ms=100):
        """Press an Archimedes key by its emu_input.js name, e.g. ArcEscape,
        ArcF1. Selenium's own key events are too short for the emulator to see."""
        self._js('window.emuinput.simulateKey(arguments[0], 0, arguments[1])', key, hold_ms)
        time.sleep(hold_ms / 1000 + 0.1)

    def exec_commands(self, lines):
        """Type lines in at the current prompt, by writing them to !Boot and
        pressing F1 (which the boot set to *!boot)."""
        self.write_file('!Boot', '\n'.join(lines) + '\n', 0xffe)
        self.press('ArcF1')

    def screenshot(self, path):
        self.driver.find_element('id', 'canvas').screenshot(str(path))
        return str(path)

    # --- Running programs --------------------------------------------------

    def run(self, prog, input=(), timeout=10, screenshot=None, turbo=None):
        """Type in a program (text, line numbers optional), RUN it and collect
        the result. `input` lines are fed to INPUT/GET as if typed. With
        `turbo` the emulator runs flat out (often 10x or more) with no video,
        so the screenshot is the screen as the program ended or timed out."""
        turbo = self.turbo if turbo is None else turbo
        for f in ('Entry', 'Output', 'Status', 'Done'):
            self.delete_file(f)
        lines = number_lines(prog)
        result = Result()
        result.entry_errors = [f'line too long ({len(l)} chars): {l[:40]}...'
                               for l in lines if len(l) > 255]
        self.exec_commands(PROLOGUE + lines + RUN + list(input) + EPILOGUE)

        t0 = time.time()
        done = self._wait_for('Done', timeout, turbo)
        result.seconds = time.time() - t0
        if screenshot:
            result.screenshot = self.screenshot(screenshot)
        if not done:
            result.timed_out = True
            self.press('ArcEscape')   # this also closes the Exec file
            time.sleep(0.3)
            self.exec_commands(EPILOGUE)
            if not self._wait_for('Done', 5):
                # Probably trapped Escape; start again for the next run
                result.entry_errors.append('could not stop the program; rebooted')
                self.boot()
                return result

        entry = vdu_to_text(self.read_file('Entry') or b'')
        result.entry_errors += [l for l in entry.split('\n')
                                if l.strip() and not l.startswith('>')]

        raw = self.read_file('Output') or b''
        result.raw = raw
        text = vdu_to_text(raw)
        text = re.sub(r'^>\*FX3,0\n>MODE MODE:RUN\n', '', text)
        text, result.unread_input = split_unread_input(text, list(input))
        status = vdu_to_text(self.read_file('Status') or b'')
        m = re.search(r'^STATUS:(-?\d+):(\d+):(.*)$', status, re.M)
        if result.unread_input:
            # Unread input was typed in at the prompt, so the status may be
            # from that. Take the program's error from its output instead.
            m = None
            e = re.search(r'\n(.+?)(?: at line (\d+))?\n*$', '\n' + text)
            if e and (e.group(2) or e.group(1) in ('Escape',)):
                result.error, result.error_line = e.group(1), int(e.group(2) or 0)
                text = text[:e.start()] + '\n'
        elif m and int(m.group(1)):
            number, line, report = int(m.group(1)), int(m.group(2)), m.group(3)
            # BASIC's default handler prints the report at the end. If it's not
            # there, ERR is from an error the program dealt with itself
            pattern = r'\n*' + re.escape(report) + (f' at line {line}' if line else '') + r'\n*$'
            if re.search(pattern, '\n' + text):
                result.error, result.error_number, result.error_line = report, number, line
                text = re.sub(pattern, '\n', '\n' + text)[1:]
            else:
                result.handled_error = report
        elif not m and not result.unread_input:
            result.error = ('no status: the program read more input than it was '
                            'given (so read the epilogue) or left BASIC')
        result.output = text.rstrip('\n') + ('\n' if text.strip() else '')
        return result


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('files', nargs='*', help='BASIC program text files')
    ap.add_argument('-e', '--eval', action='append', default=[],
                    help='program text to run (may be given more than once)')
    ap.add_argument('--input', action='append', default=[],
                    help='a line of input for INPUT/GET (repeatable)')
    ap.add_argument('--timeout', type=float, default=10,
                    help='seconds to let each program run (default 10)')
    ap.add_argument('--screenshot-dir', help='save a PNG of the screen for each program')
    ap.add_argument('--turbo', action='store_true',
                    help='run the emulator flat out (no video until the program ends)')
    ap.add_argument('--preset', help='machine preset, e.g. a5000')
    ap.add_argument('--url', default='http://localhost:8000/')
    ap.add_argument('--raw', action='store_true', help='also print the raw spooled bytes')
    ap.add_argument('--console', action='store_true', help='echo the browser console to stderr')
    args = ap.parse_args()

    progs = [(Path(f).stem, Path(f).read_text(encoding='latin-1')) for f in args.files]
    progs += [(f'eval{i}', p.replace('\\n', '\n')) for i, p in enumerate(args.eval)]
    if not progs:
        ap.error('give a program file or -e')

    status = 0
    with ArcBasic(args.url, args.preset, console=args.console, turbo=args.turbo) as arc:
        for name, prog in progs:
            shot = None
            if args.screenshot_dir:
                Path(args.screenshot_dir).mkdir(parents=True, exist_ok=True)
                shot = str(Path(args.screenshot_dir) / f'{name}.png')
            r = arc.run(prog, args.input, args.timeout, shot)
            if len(progs) > 1:
                print(f'=== {name}')
            print(r.describe(), end='')
            if args.raw:
                print(repr(r.raw))
            if r.screenshot:
                print(f'[screenshot] {r.screenshot}')
            if r.timed_out:
                status = max(status, 2)
            elif not r.ok:
                status = max(status, 1)
    sys.exit(status)


if __name__ == '__main__':
    main()
