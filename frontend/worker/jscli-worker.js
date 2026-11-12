/**
 * The worker's side of the JSCLI page hooks in jscli-page.js (the cli*
 * functions it calls). Runs * commands through the JSCLI helper modules
 * (arculator-wasm/src/jscli) for window.arcCli, sends keys through JSCLI for
 * arcType, and runs arcCliSession's sessions in
 * JSCLIWimp. The emulator queues each request for the module serving its
 * channel, then reports output and completion through self.jscliOutput and
 * self.jscliDone (called from jscli.c).
 */

import { emulator, ready } from './emulator.js'
import { expose, transfer } from '../shared/rpc.js'

const CLI_CHANNELS = Object.freeze({callback: 0, wimp: 1});
const CLI_KINDS = Object.freeze({keys: 1, session: 2, input: 3, close: 4});
// Bytes per emulator request: the modules' buffer size, and for input less
// than a TaskWindow's input buffer, which holds 63 bytes and drops the rest.
// The next part is only queued when one is done, and JSCLIWimp takes one
// request per null event, so input goes at a part every 5 cs or so, which
// programs that are reading keep up with
const CLI_MAX_DATA = Object.freeze({keys: 256, input: 32});
const CLI_QUEUE_ERRORS = Object.freeze({
  '-1': 'module not loaded (it needs RISC OS 3, and #jscli in the page\'s URL)',
  '-2': 'too many commands queued',
  '-3': 'command too long (255 characters at most)',
  '-4': 'that module can\'t do that (keys need JSCLI, sessions JSCLIWimp)',
  '-5': 'the session has ended',
});
// Emulator request id -> request: {label, output, parts, timer, resolve, reject}. Long key
// or input data goes as several emulator requests (parts), one after another
const cliRequests = new Map();
// Page id -> request, for the open sessions
const cliSessions = new Map();

function cliQueueData(kind, target, part, via = 'wimp') {
  return emulator.ccall('arc_cli_queue_data', 'number', ['number', 'number', 'number', 'array', 'number'],
    [CLI_CHANNELS[via], CLI_KINDS[kind], target, part, part.length]);
}

/*Which JSCLI modules are loaded (arcCliStatus): {callback, wimp}, and with
  JSCLIWimp, wimpIdleMs and wimpBusy*/
function cliStatus() {
  let status = ready ? emulator.ccall('arc_cli_status', 'number', []) : 0;
  let result = Object.fromEntries(Object.entries(CLI_CHANNELS).map(([name, n]) => [name, !!(status & (1 << n))]));
  if (result.wimp) {
    // JSCLIWimp checks for commands on every null event while it's idle, so a
    // long gap means the desktop is suspended (or it's running a silent command)
    result.wimpIdleMs = emulator.ccall('arc_cli_idle_ms', 'number', ['number'], [CLI_CHANNELS.wimp]);
    result.wimpBusy = !!emulator.ccall('arc_cli_busy', 'number', ['number'], [CLI_CHANNELS.wimp]);
  }
  return result;
}

/** Run a * command (arcCli). Resolves with {raw, error} */
function cliRun(command, via = 'callback', timeout = 0, onOutput = null) {
  if (!(via in CLI_CHANNELS)) {
    throw new Error(`Unknown CLI module '${via}'`);
  }
  return cliStart({ label: `arcCli (${via})`, via, onOutput,
    queue: () => emulator.ccall('arc_cli_queue', 'number', ['number', 'string'], [CLI_CHANNELS[via], command]) },
    timeout);
}

/** Put keys in the keyboard buffer through JSCLI (arcType) */
function cliKeys(data, timeout = 0) {
  return cliStart(dataRequest('keys', 'arc keys', 'callback', 0, data), timeout);
}

/*Open a session (arcCliSession): `command` (bytes) run in a TaskWindow.
  `session` is the page's id for it. Resolves with {raw, error} when it ends;
  its output goes to onOutput*/
function cliSession(session, command, onOutput) {
  return cliStart({ label: 'arcCliSession', via: 'wimp', session, onOutput,
    queue: () => cliQueueData('session', 0, command) });
}

/** Send input to a session */
function cliInput(session, data, timeout = 0) {
  let s = cliSessions.get(session);
  if (!s) {
    throw new Error(`arcCliSession: ${CLI_QUEUE_ERRORS[-5]}`);
  }
  return cliStart(dataRequest('input', 'arcCliSession', 'wimp', s.cmdId, data), timeout);
}

/*Close a session. One that hasn't started is removed from the queue; one that
  has is killed, and its cliSession call resolves when its TaskWindow has gone*/
function cliClose(session) {
  let s = cliSessions.get(session);
  if (!s) {
    return;
  }
  if (emulator.ccall('arc_cli_cancel', 'number', ['number'], [s.cmdId]) == 1) {
    self.jscliDone(s.cmdId, 1, 0, new TextEncoder().encode('Closed before it started'));
    return;
  }
  return cliStart({ label: 'arcCliSession close', via: 'wimp',
    queue: () => cliQueueData('close', s.cmdId, new Uint8Array(0)) });
}

expose({ cliStatus, cliRun, cliKeys, cliSession, cliInput, cliClose });

// A request for data, which goes in parts of at most CLI_MAX_DATA[kind] bytes
function dataRequest(kind, label, via, target, data) {
  let req = { label, via, parts: [] };
  let max = CLI_MAX_DATA[kind];
  for (let i = 0; i < data.length || i == 0; i += max) {
    req.parts.push(data.subarray(i, i + max));
  }
  req.queue = () => cliQueueData(kind, target, req.parts.shift(), via);
  return req;
}

/*Queue a request in the emulator. Resolves with {raw, error} when it's done
  (jscliDone), or rejects if it can't be queued or times out*/
function cliStart(req, timeout = 0) {
  return new Promise((resolve, reject) => {
    Object.assign(req, { output: [], parts: req.parts ?? [], resolve, reject });
    cliQueue(req);
    if (req.session) {
      cliSessions.set(req.session, req);
    }
    if (timeout) {
      req.timer = setTimeout(() => cliTimeout(req, timeout), timeout);
    }
  });
}

// Queue a request (or its next part) in the emulator
function cliQueue(req) {
  req.cmdId = ready ? req.queue() : -1;
  if (req.cmdId < 0) {
    throw new Error(`${req.label}: ${CLI_QUEUE_ERRORS[req.cmdId]}`);
  }
  cliRequests.set(req.cmdId, req);
}

/*A queued request is removed, so it never runs. One that has started in a
  TaskWindow is killed. Otherwise it can't be stopped, so it carries on, and
  its results are dropped*/
function cliTimeout(req, timeout) {
  if (cliRequests.get(req.cmdId) !== req) return;
  cliRequests.delete(req.cmdId);
  let removed = emulator.ccall('arc_cli_cancel', 'number', ['number'], [req.cmdId]) == 1;
  let killed = !removed && req.via === 'wimp' && cliQueueData('close', req.cmdId, new Uint8Array(0)) > 0;
  req.reject(new Error(`${req.label}: timed out after ${timeout} ms, ` +
    (removed ? 'before it started' : killed ? 'and it was killed' : 'and it is still running')));
}

self.jscliOutput = (cmdId, data) => {
  let req = cliRequests.get(cmdId);
  if (!req) return;
  if (!req.session) {
    req.output.push(data);
  }
  req.onOutput?.(data);
};

self.jscliDone = (cmdId, failed, errnum, msg) => {
  let req = cliRequests.get(cmdId);
  if (!req) return;
  cliRequests.delete(cmdId);
  cliSessions.delete(req.session);
  if (!failed && req.parts.length) {
    try {
      cliQueue(req);
      return;
    } catch (e) {
      clearTimeout(req.timer);
      req.reject(e);
      return;
    }
  }
  clearTimeout(req.timer);
  let raw = new Uint8Array(req.output.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (let c of req.output) {
    raw.set(c, pos);
    pos += c.length;
  }
  let error = failed ? { number: errnum, message: String.fromCharCode(...msg) } : null;
  req.resolve(transfer({ raw, error }, [raw.buffer]));
};
