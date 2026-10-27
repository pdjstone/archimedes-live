#!/usr/bin/env python3
"""A command line for RISC OS in Archimedes Live, through JSCLI.

The page can't listen for connections, so this is the WebSocket server, and
Archimedes Live connects to it when given its URL in the jscli parameter
(frontend/jscli-remote.js), from the same machine:

    venv/bin/python tools/arcterm.py
    # then open e.g. http://127.0.0.1:8000/#preset=a3000&ff=14400&jscli=ws://127.0.0.1:8765/<token>

It prints the jscli value to use, with a random token in it, so other local
programs and web pages can't connect in its place. Connections from web
pages other than Archimedes Live (checked by their Origin) are refused.

Modes:
  (default)  A line at a time, edited here (history, cursor keys). In the
             desktop it runs a TaskWindow session (JSCLIWimp), with RISC OS's
             prompt as the prompt, so interactive programs such as BASIC work.
             Outside the desktop each line is run as a * command (JSCLI).
             Ctrl-C sends Escape, Ctrl-D quits. Lines starting with a
             backslash are commands for arcterm: \\help lists them.
  --raw      Every key goes straight to the session, as in a terminal, and
             the output's VDU codes are turned into ANSI. Ctrl-D or Ctrl-] quits.
  -c CMD     Run * commands, print what they print, and exit (status 1 if
             one fails). Handy for scripts.

Sessions belong to the page, so they carry on if the connection drops or
arcterm is restarted: it picks its session up again, or takes over the
newest one. Only one page can be connected; when another connects, the old
one stops trying to reconnect.
"""
import argparse
import asyncio
import base64
import codecs
import collections
import json
import os
import secrets
import sys
from http import HTTPStatus
from urllib.parse import urlsplit

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

LOOPBACK_HOSTS = {'localhost', '127.0.0.1', '::1'}
# Close code telling a page that another one has taken over, so it doesn't
# reconnect (as in jscli-remote.js)
CLOSE_REPLACED = 4000
DEFAULT_ORIGINS = {'https://archi.medes.live'}

# Parameter bytes taken by each VDU control code (as in jscli-page.js)
VDU_PARAMS = {1: 1, 17: 1, 18: 2, 19: 5, 22: 1, 23: 9, 24: 8, 25: 5, 28: 4, 29: 4, 31: 2}

ESCAPE = '\x1b'

# Terminal key sequences -> RISC OS key codes, for --raw
KEY_CODES = {
    b'\x1b[A': 0x8f, b'\x1b[B': 0x8e, b'\x1b[C': 0x8d, b'\x1b[D': 0x8c,     # cursor keys
    b'\x1bOA': 0x8f, b'\x1bOB': 0x8e, b'\x1bOC': 0x8d, b'\x1bOD': 0x8c,
    b'\x1bOP': 0x81, b'\x1bOQ': 0x82, b'\x1bOR': 0x83, b'\x1bOS': 0x84,     # F1-F4
    b'\x1b[15~': 0x85, b'\x1b[17~': 0x86, b'\x1b[18~': 0x87, b'\x1b[19~': 0x88,
    b'\x1b[20~': 0x89, b'\x1b[21~': 0xca, b'\x1b[23~': 0xcb, b'\x1b[24~': 0xcc,
    b'\x1b[3~': 0x7f,                                                       # Delete
}
RAW_QUIT = (0x04, 0x1d)     # Ctrl-D, Ctrl-]


class BridgeError(Exception):
    pass


def latin1(data):
    """A str (which may have characters outside Latin-1) as JSCLI's bytes"""
    return data.encode('latin1', 'replace').decode('latin1')


class VduConverter:
    """Turns a VDU stream into text for a terminal, in chunks. With `ansi`,
    cursor movement and CLS become ANSI sequences; without, they're dropped
    (for line mode, where the output scrolls past). Colours (VDU 17) become
    ANSI colours either way."""

    def __init__(self, ansi):
        self.ansi = ansi
        self.code = None
        self.params = []

    def feed(self, data):
        out = []
        for b in data:
            if self.code is not None:
                self.params.append(b)
                if len(self.params) == VDU_PARAMS[self.code]:
                    out.append(self.control(self.code, self.params))
                    self.code = None
                continue
            if b in VDU_PARAMS:
                self.code = b
                self.params = []
            elif 0x80 <= b < 0xa0:
                # RISC OS has characters here where Latin-1 has controls
                out.append('?')
            elif b >= 32 and b != 127:
                out.append(chr(b))      # Latin-1
            else:
                out.append(self.control(b, []))
        return ''.join(out)

    def control(self, code, params):
        if code == 10:
            # TaskWindows drop CR from their output, so a newline is just LF,
            # which a terminal in raw mode doesn't take back to the left
            return '\r\n' if self.ansi else '\n'
        if code in (8, 127):
            return '\b \b' if self.ansi and code == 127 else '\b'
        if code == 7:
            return '\a'
        if code == 17:
            n = params[0]
            if n < 128:
                return f'\x1b[{(90 if n & 8 else 30) + (n & 7)}m'
            return f'\x1b[{40 + (n & 7)}m'
        if code == 20:
            return '\x1b[0m'
        if not self.ansi:
            return ''
        return {
            9: '\x1b[C', 11: '\x1b[A', 12: '\x1b[2J\x1b[H', 13: '\r', 30: '\x1b[H',
            31: f'\x1b[{params[1] + 1 if params else 1};{params[0] + 1 if params else 1}H',
        }.get(code, '')


class Bridge:
    """The WebSocket server, and requests to the page connected to it"""

    def __init__(self, token, origins):
        self.token = token
        self.origins = origins
        self.ws = None
        self.status = None
        self.ready = asyncio.Event()        # JSCLI or JSCLIWimp is loaded
        self.pending = {}
        self.next_id = 1
        self.on_event = lambda msg: None
        self.on_connection = lambda connected: None

    def check_request(self, connection, request):
        if request.path != '/' + self.token:
            return connection.respond(HTTPStatus.FORBIDDEN, 'Wrong token\n')
        origin = request.headers.get('Origin')
        # No Origin means it's not a web page (e.g. websocat), which the token covers
        if origin and origin not in self.origins and urlsplit(origin).hostname not in LOOPBACK_HOSTS:
            return connection.respond(HTTPStatus.FORBIDDEN, f'Origin {origin} not allowed\n')
        return None

    async def handler(self, ws):
        if self.ws:
            # e.g. the page was reloaded, or opened in another tab: the new
            # one takes over, and the old one stops trying to reconnect
            await self.ws.close(CLOSE_REPLACED, 'Another Archimedes Live connected')
        self.ws = ws
        self.status = None
        self.ready.clear()
        self.on_connection(True)
        try:
            async for text in ws:
                try:
                    self.message(json.loads(text))
                except Exception as e:
                    # A bad message shouldn't cost the connection
                    print(f'arcterm: bad message from Archimedes Live ({e!r}): {text[:200]}', file=sys.stderr)
        except ConnectionClosed:
            pass        # e.g. the page closed without saying so: 'disconnected' covers it
        except Exception as e:
            print(f'arcterm: connection error: {e!r}', file=sys.stderr)
        finally:
            if self.ws is ws:
                self.ws = None
                self.status = None
                self.ready.clear()
                for fut in self.pending.values():
                    if not fut.done():
                        fut.set_exception(BridgeError('Archimedes Live disconnected'))
                self.pending.clear()
                self.on_connection(False)

    def message(self, msg):
        if 'event' in msg:
            if msg['event'] == 'status':
                self.status = msg['status']
                if self.status.get('callback') or self.status.get('wimp'):
                    self.ready.set()
            self.on_event(msg)
        else:
            fut = self.pending.pop(msg.get('id'), None)
            if fut and not fut.done():
                fut.set_result(msg)

    async def request(self, op, **args):
        if not self.ws:
            raise BridgeError("Archimedes Live isn't connected")
        req_id = self.next_id
        self.next_id += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[req_id] = fut
        await self.ws.send(json.dumps({'id': req_id, 'op': op, **args}))
        msg = await fut
        if 'error' in msg:
            raise BridgeError(msg['error'])
        return msg.get('result')

    def wimp(self):
        return bool(self.status and self.status.get('wimp'))


def choose_session(page, session_id, msg):
    """Which of the page's sessions to use, from the 'sessions' event it sends
    when it connects. The one we had, if the page still has it, with what it
    printed while we were disconnected; otherwise the newest one still
    running, with its last line (usually its prompt). Returns (session info
    or None, output to show, whether it's the one we had)."""
    if msg['page'] == page:
        for s in msg['sessions']:
            if s['session'] == session_id:
                return s, s['unsent'], True
    running = [s for s in msg['sessions'] if not s['ended']]
    if not running:
        return None, '', False
    s = running[-1]
    return s, s['tail'][s['tail'].rfind('\n') + 1:], False


class EchoFilter:
    """Drops the TaskWindow's echo of the lines we've sent, which line mode
    has already shown as typed. Gives up on a line at the first difference
    (a program that reads without echoing, or output that comes first)."""

    def __init__(self):
        self.lines = collections.deque()
        self.pos = 0
        self.newlines = 0

    def expect(self, line):
        self.lines.append(line)

    def clear(self):
        self.lines.clear()
        self.pos = self.newlines = 0

    def feed(self, data):
        out = bytearray()
        for b in data:
            while self.lines:
                line = self.lines[0]
                if self.pos < len(line):
                    if b == line[self.pos]:
                        self.pos += 1
                        break
                    out += line[:self.pos]
                    self.clear()
                    continue
                # The echoed line's newline (LF CR)
                if b in (10, 13) and self.newlines < 2:
                    self.newlines += 1
                    break
                self.lines.popleft()
                self.pos = self.newlines = 0
            else:
                out.append(b)
        return bytes(out)


class LineTerm:
    """Line mode: prompt_toolkit edits the line, with RISC OS's prompt (the
    output after the last newline) as its prompt"""

    HELP = r"""arcterm commands:
  \cli CMD      run * command CMD from a callback (JSCLI), outside the session
  \wimp CMD     run * command CMD in its own TaskWindow (JSCLIWimp)
  \type TEXT    type TEXT into the keyboard buffer (\r is Return, \x1b Escape)
  \esc          send Escape to the session (or press Ctrl-C)
  \open [CMD]   start a new session running CMD (default: a * prompt)
  \close        end the session; lines then run as * commands
  \status       which JSCLI modules are loaded
  \shot [FILE]  save a screenshot (default arcterm-N.png)
  \quit         quit (or press Ctrl-D)"""

    def __init__(self, bridge, args):
        from prompt_toolkit import PromptSession
        self.bridge = bridge
        self.session_command = args.session
        self.want_session = not args.cli
        self.session_id = None
        self.page = None
        self.opening = False
        self.partial = ''
        self.echo = EchoFilter()
        self.vdu = VduConverter(ansi=False)
        self.shots = 0
        self.prompt = PromptSession()
        bridge.on_event = self.on_event
        bridge.on_connection = self.on_connection

    def say(self, text, style='ansiyellow'):
        from prompt_toolkit import print_formatted_text
        from prompt_toolkit.formatted_text import FormattedText
        print_formatted_text(FormattedText([(style, f'[arcterm] {text}')]))

    def show(self, text):
        from prompt_toolkit import print_formatted_text
        from prompt_toolkit.formatted_text import ANSI
        print_formatted_text(ANSI(text), end='')

    def refresh(self):
        if self.prompt.app.is_running:
            self.prompt.app.invalidate()

    def message(self):
        from prompt_toolkit.formatted_text import ANSI
        if not self.bridge.ws:
            return ANSI('\x1b[33m(not connected)\x1b[0m ')
        if not self.bridge.ready.is_set():
            return ANSI('\x1b[33m(waiting for JSCLI)\x1b[0m ')
        if self.session_id is None:
            return ANSI('*')
        return ANSI(self.partial)

    def on_connection(self, connected):
        # The session carries on in the page, to pick up when it reconnects
        self.say('Archimedes Live connected' if connected else 'Archimedes Live disconnected')
        self.refresh()

    def on_sessions(self, msg):
        had = self.session_id
        s, data, resumed = choose_session(self.page, self.session_id, msg)
        self.page = msg['page']
        if not resumed and not self.want_session:
            s = None
        if not resumed:
            self.session_id = None
            self.partial = ''
            self.echo.clear()
            self.vdu = VduConverter(ansi=False)
            if had is not None:
                self.say('The session has gone')
            if s:
                self.session_id = s['session']
                self.say(f"Took over session {s['session']}{' running ' + s['command'] if s['command'] else ''}")
        if s:
            self.output(data.encode('latin1'))
            if s['ended']:
                self.session_ended(s['error'])
        self.refresh()

    def session_ended(self, error):
        self.session_id = None
        self.partial = ''
        self.say(f"Session ended{': ' + error['message'] if error else ''}")
        if not error:
            # Like quitting a program in a terminal: back to a * prompt
            self.session_command = ''
            asyncio.ensure_future(self.ensure_session())
        self.refresh()

    def on_event(self, msg):
        event = msg['event']
        if event == 'status':
            self.say(f"JSCLI: {'loaded' if msg['status'].get('callback') else 'not loaded'}, "
                     f"JSCLIWimp: {'running' if msg['status'].get('wimp') else 'not running'}")
            asyncio.ensure_future(self.ensure_session())
        elif event == 'sessions':
            self.on_sessions(msg)
        elif event == 'output' and msg['session'] == self.session_id:
            self.output(msg['data'].encode('latin1'))
        elif event == 'ended' and msg['session'] == self.session_id:
            self.session_ended(msg.get('error'))

    def output(self, data):
        text = self.partial + self.vdu.feed(self.echo.feed(data))
        lines = []
        line = []
        for c in text:
            if c == '\n':
                lines.append(''.join(line))
                line = []
            elif c == '\b':
                if line:
                    line.pop()
            else:
                line.append(c)
        self.partial = ''.join(line)
        if lines:
            self.show(''.join(l + '\x1b[0m\n' for l in lines))
        self.refresh()

    async def ensure_session(self):
        if not self.want_session or self.session_id is not None or self.opening or not self.bridge.wimp():
            return
        self.opening = True
        try:
            r = await self.bridge.request('open', command=latin1(self.session_command))
            self.session_id = r['session']
            self.partial = ''
            self.echo.clear()
            self.say(f"Session started{' running ' + self.session_command if self.session_command else ''}")
        except BridgeError as e:
            self.say(f'Could not start a session: {e}', 'ansired')
        finally:
            self.opening = False
            self.refresh()

    async def run_cli(self, command, via='callback'):
        r = await self.bridge.request('cli', command=latin1(command), via=via)
        text = VduConverter(ansi=False).feed(r['output'].encode('latin1'))
        if text:
            self.show(text if text.endswith('\n') else text + '\n')
        if r['error']:
            self.say(f"Error &{r['error']['number']:X}: {r['error']['message']}", 'ansired')

    async def meta(self, line):
        name, _, rest = line.partition(' ')
        rest = rest.strip()
        if name in ('quit', 'exit', 'q'):
            raise EOFError
        if name == 'help':
            self.say(self.HELP, '')
        elif name == 'cli':
            await self.run_cli(rest)
        elif name == 'wimp':
            await self.run_cli(rest, 'wimp')
        elif name == 'type':
            await self.bridge.request('type', data=latin1(codecs.decode(rest, 'unicode_escape')))
        elif name == 'esc':
            await self.send_escape()
        elif name == 'open':
            await self.close_session()
            self.session_command = rest
            self.want_session = True
            await self.ensure_session()
            if self.session_id is None and not self.bridge.wimp():
                self.say("JSCLIWimp isn't running, so there can't be a session (is the desktop running?)", 'ansired')
        elif name == 'close':
            self.want_session = False
            await self.close_session()
        elif name == 'status':
            self.say(json.dumps(await self.bridge.request('status')))
        elif name == 'shot':
            self.shots += 1
            path = rest or f'arcterm-{self.shots}.png'
            png = await self.bridge.request('screenshot')
            with open(path, 'wb') as f:
                f.write(base64.b64decode(png))
            self.say(f'Saved {path}')
        else:
            self.say(f'Unknown command \\{name}: \\help lists them', 'ansired')

    async def close_session(self):
        # Forget it first, so its 'ended' event doesn't start another one
        session, self.session_id = self.session_id, None
        if session is not None:
            await self.bridge.request('close', session=session)
            self.say('Session closed')

    async def send_escape(self):
        if self.session_id is not None:
            self.echo.clear()
            await self.bridge.request('input', session=self.session_id, data=ESCAPE)

    async def line(self, line):
        if line.startswith('\\'):
            await self.meta(line[1:])
        elif not self.bridge.ready.is_set():
            self.say("Not connected to JSCLI yet", 'ansired')
        elif self.session_id is not None:
            # The prompt and the line are on the screen as typed
            self.partial = ''
            self.echo.expect(latin1(line).encode('latin1'))
            await self.bridge.request('input', session=self.session_id, data=latin1(line) + '\r')
        else:
            await self.run_cli(line.lstrip('*'))

    async def run(self):
        while True:
            try:
                line = await self.prompt.prompt_async(self.message)
            except KeyboardInterrupt:
                try:
                    await self.send_escape()
                except BridgeError as e:
                    self.say(str(e), 'ansired')
                continue
            except EOFError:
                return
            try:
                await self.line(line)
            except EOFError:
                return
            except (BridgeError, ValueError) as e:
                self.say(str(e), 'ansired')


class RawTerm:
    """Raw mode: keys go to the session one at a time, and its output to the
    terminal with VDU codes turned into ANSI"""

    def __init__(self, bridge, args):
        self.bridge = bridge
        self.session_command = args.session
        self.session_id = None
        self.page = None
        self.vdu = VduConverter(ansi=True)
        self.keys = asyncio.Queue()
        self.quit = asyncio.Event()
        bridge.on_event = self.on_event
        bridge.on_connection = self.on_connection

    def say(self, text):
        sys.stdout.write(f'\r\n\x1b[33m[arcterm] {text}\x1b[0m\r\n')
        sys.stdout.flush()

    def on_connection(self, connected):
        # The session carries on in the page, to pick up when it reconnects
        self.say('Archimedes Live connected' if connected else 'Archimedes Live disconnected')

    def on_sessions(self, msg):
        had = self.session_id
        s, data, resumed = choose_session(self.page, self.session_id, msg)
        self.page = msg['page']
        if not resumed:
            self.session_id = None
            self.vdu = VduConverter(ansi=True)
            if had is not None:
                self.say('The session has gone')
            if s:
                self.session_id = s['session']
                self.say(f"Took over session {s['session']}{' running ' + s['command'] if s['command'] else ''}")
        if s:
            self.show(data)
            if s['ended']:
                self.session_ended(s['error'])

    def session_ended(self, error):
        self.session_id = None
        self.say(f"Session ended{': ' + error['message'] if error else ''}")
        if not error:
            # Like quitting a program in a terminal: back to a * prompt
            self.session_command = ''
            asyncio.ensure_future(self.ensure_session())

    def show(self, data):
        sys.stdout.write(self.vdu.feed(data.encode('latin1')))
        sys.stdout.flush()

    def on_event(self, msg):
        event = msg['event']
        if event == 'status':
            asyncio.ensure_future(self.ensure_session())
        elif event == 'sessions':
            self.on_sessions(msg)
        elif event == 'output' and msg['session'] == self.session_id:
            self.show(msg['data'])
        elif event == 'ended' and msg['session'] == self.session_id:
            self.session_ended(msg.get('error'))

    async def ensure_session(self):
        if self.session_id is not None:
            return
        if not self.bridge.wimp():
            self.say("Waiting for JSCLIWimp (the desktop) to start a session")
            return
        try:
            self.session_id = (await self.bridge.request('open', command=latin1(self.session_command)))['session']
        except BridgeError as e:
            self.say(f'Could not start a session: {e}')

    def read_keys(self):
        data = os.read(sys.stdin.fileno(), 1024)
        out = bytearray()
        i = 0
        while i < len(data):
            if data[i] in RAW_QUIT:
                self.quit.set()
                return
            if data[i] == 3:            # Ctrl-C: Escape
                out.append(0x1b)
                i += 1
                continue
            if data[i] == 0x1b:
                for seq, code in KEY_CODES.items():
                    if data.startswith(seq, i):
                        out.append(code)
                        i += len(seq)
                        break
                else:
                    if i + 1 < len(data) and data[i + 1] in b'[O':
                        # Another key's sequence: skip it
                        j = i + 2
                        while j < len(data) and not 0x40 <= data[j] <= 0x7e:
                            j += 1
                        i = j + 1
                    else:
                        out.append(0x1b)
                        i += 1
                continue
            # Text up to the next key handled above, as UTF-8
            j = i
            while j < len(data) and data[j] not in (0x1b, 3, *RAW_QUIT):
                j += 1
            out += data[i:j].decode('utf-8', 'replace').encode('latin1', 'replace')
            i = j
        if out:
            self.keys.put_nowait(out.decode('latin1'))

    async def send_keys(self):
        while True:
            keys = await self.keys.get()
            if self.session_id is not None:
                try:
                    await self.bridge.request('input', session=self.session_id, data=keys)
                except BridgeError as e:
                    self.say(str(e))

    async def run(self):
        import termios
        import tty
        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
        loop = asyncio.get_running_loop()
        tty.setraw(fd)
        sender = asyncio.ensure_future(self.send_keys())
        loop.add_reader(fd, self.read_keys)
        try:
            self.say('Raw mode: keys go to RISC OS. Ctrl-C is Escape, Ctrl-D or Ctrl-] quits')
            await self.quit.wait()
        finally:
            loop.remove_reader(fd)
            sender.cancel()
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)
            sys.stdout.write('\x1b[0m\n')


async def run_commands(bridge, commands, via, timeout):
    """-c: run each command, print its output, stop at the first error"""
    try:
        await asyncio.wait_for(bridge.ready.wait(), timeout)
    except asyncio.TimeoutError:
        print(f'arcterm: Archimedes Live (with JSCLI) did not connect within {timeout} s', file=sys.stderr)
        return 2
    for command in commands:
        r = await bridge.request('cli', command=latin1(command), via=via)
        sys.stdout.write(VduConverter(ansi=False).feed(r['output'].encode('latin1')))
        sys.stdout.flush()
        if r['error']:
            print(f"arcterm: {command}: {r['error']['message']} (&{r['error']['number']:X})", file=sys.stderr)
            return 1
    return 0


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--host', default='127.0.0.1', help='address to listen on (default 127.0.0.1)')
    parser.add_argument('--port', type=int, default=8765, help='port to listen on (default 8765)')
    parser.add_argument('--token', help='token for the URL (default: a random one)')
    parser.add_argument('--allow-origin', action='append', default=[], metavar='ORIGIN',
                        help='also accept pages from ORIGIN, e.g. https://example.com '
                             '(pages on this machine and archi.medes.live are accepted)')
    parser.add_argument('--session', default='', metavar='CMD',
                        help='run CMD in the first session, e.g. BASIC; when it ends you get a * prompt')
    parser.add_argument('--cli', action='store_true',
                        help='run each line as a * command, without a session')
    parser.add_argument('--raw', action='store_true', help='send every key straight to the session')
    parser.add_argument('-c', dest='commands', action='append', metavar='CMD',
                        help='run * command CMD and exit (can be repeated)')
    parser.add_argument('--wimp', action='store_true', help='with -c, run the commands in TaskWindows')
    parser.add_argument('--timeout', type=float, default=120,
                        help='with -c, seconds to wait for Archimedes Live to connect (default 120)')
    args = parser.parse_args()

    token = args.token or secrets.token_urlsafe(12)
    bridge = Bridge(token, DEFAULT_ORIGINS | set(args.allow_origin))
    async with serve(bridge.handler, args.host, args.port, process_request=bridge.check_request,
                     max_size=16 * 1024 * 1024):
        host = f'[{args.host}]' if ':' in args.host else args.host
        print(f'Waiting for Archimedes Live. Open it with this parameter in the URL\'s hash:\n'
              f'  jscli=ws://{host}:{args.port}/{token}\n'
              f'e.g. http://127.0.0.1:8000/#preset=a3000&ff=14400&jscli=ws://{host}:{args.port}/{token}',
              file=sys.stderr)
        if args.commands:
            return await run_commands(bridge, args.commands, 'wimp' if args.wimp else 'callback', args.timeout)
        term = RawTerm(bridge, args) if args.raw else LineTerm(bridge, args)
        await term.run()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
