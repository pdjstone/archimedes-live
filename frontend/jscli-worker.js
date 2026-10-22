/**
 * The worker's side of the JSCLI page hooks in jscli-page.js (the 'cli'
 * messages). Runs * commands through the JSCLI helper modules
 * (arculator-wasm/src/jscli) for window.arcCli, sends VDU bytes and keys
 * through JSCLI for arcVdu and arcType, and runs arcCliSession's sessions in
 * JSCLIWimp. The emulator queues each request for the module serving its
 * channel, then reports output and completion through self.jscliOutput and
 * self.jscliDone (called from jscli.c).
 */
const CLI_CHANNELS = Object.freeze({callback: 0, wimp: 1});
const CLI_KINDS = Object.freeze({vdu: 1, keys: 2, session: 3, input: 4, close: 5});
// Bytes per emulator request: the modules' buffer size, and for input less
// than a TaskWindow's input buffer, which holds 63 bytes and drops the rest.
// The next part is only queued when one is done, and JSCLIWimp takes one
// request per null event, so input goes at a part every 5 cs or so, which
// programs that are reading keep up with
const CLI_MAX_DATA = Object.freeze({vdu: 256, keys: 256, input: 32});
const CLI_QUEUE_ERRORS = Object.freeze({
  '-1': 'module not loaded',
  '-2': 'too many commands queued',
  '-3': 'command too long (255 characters at most)',
  '-4': 'that module can\'t do that (VDU bytes and keys need JSCLI, sessions JSCLIWimp)',
  '-5': 'the session has ended',
});
// Emulator request id -> request: {id, label, output, parts, timer}. Long VDU
// or key data goes as several emulator requests (parts), one after another
const cliRequests = new Map();
// Page id -> request, for the open sessions
const cliSessions = new Map();

// The emulator's wasm module, once it has loaded
let arculatorModule = null;

export function setCliModule(module) {
  arculatorModule = module;
}

function cliQueueData(kind, target, part, via = 'wimp') {
  return arculatorModule.ccall('arc_cli_queue_data', 'number', ['number', 'number', 'number', 'array', 'number'],
    [CLI_CHANNELS[via], CLI_KINDS[kind], target, part, part.length]);
}

export function handleCliRequest({ id, op, command, via = 'callback', data, session, timeout }) {
  let reply = { type: 'cliReply', id };
  try {
    if (op === 'status') {
      let status = arculatorModule ? arculatorModule.ccall('arc_cli_status', 'number', []) : 0;
      reply.result = Object.fromEntries(Object.entries(CLI_CHANNELS).map(([name, n]) => [name, !!(status & (1 << n))]));
      if (reply.result.wimp) {
        // JSCLIWimp checks for commands on every null event while it's idle, so a
        // long gap means the desktop is suspended (or it's running a silent command)
        reply.result.wimpIdleMs = arculatorModule.ccall('arc_cli_idle_ms', 'number', ['number'], [CLI_CHANNELS.wimp]);
        reply.result.wimpBusy = !!arculatorModule.ccall('arc_cli_busy', 'number', ['number'], [CLI_CHANNELS.wimp]);
      }
    } else if (op === 'close') {
      // A session that hasn't started is removed from the queue; one that has
      // is killed, and finishes when its TaskWindow has gone
      let s = cliSessions.get(session);
      if (s && arculatorModule.ccall('arc_cli_cancel', 'number', ['number'], [s.cmdId]) == 1) {
        self.jscliDone(s.cmdId, 1, 0, new TextEncoder().encode('Closed before it started'));
      } else if (s) {
        cliQueue({ id, label: 'arcCliSession close', output: [], parts: [],
                   queue: () => cliQueueData('close', s.cmdId, new Uint8Array(0)) });
        return;
      }
    } else if (op === 'run' || op in CLI_KINDS) {
      if (op === 'session' || op === 'input') {
        via = 'wimp';
      }
      if (!(via in CLI_CHANNELS)) {
        throw new Error(`Unknown CLI module '${via}'`);
      }
      let req = { id, label: op === 'run' ? `arcCli (${via})` : `arc ${op}`, output: [], parts: [], via };
      if (op === 'run') {
        req.queue = () => arculatorModule.ccall('arc_cli_queue', 'number', ['number', 'string'], [CLI_CHANNELS[via], command]);
      } else if (op === 'session') {
        req.label = 'arcCliSession';
        req.session = id;
        req.queue = () => cliQueueData('session', 0, data);
      } else {
        let target = 0;
        if (op === 'input') {
          let s = cliSessions.get(session);
          if (!s) {
            throw new Error(`arcCliSession: ${CLI_QUEUE_ERRORS[-5]}`);
          }
          target = s.cmdId;
          req.label = 'arcCliSession';
        }
        let max = CLI_MAX_DATA[op];
        for (let i = 0; i < data.length || i == 0; i += max) {
          req.parts.push(data.subarray(i, i + max));
        }
        req.queue = () => cliQueueData(op, target, req.parts.shift(), via);
      }
      cliQueue(req);
      if (req.session) {
        cliSessions.set(id, req);
      }
      if (timeout) {
        req.timer = setTimeout(() => cliTimeout(req, timeout), timeout);
      }
      return;
    } else {
      throw new Error(`Unknown CLI op '${op}'`);
    }
  } catch (e) {
    reply.error = String(e.message || e);
  }
  postMessage(reply);
}

// Queue a request (or its next part) in the emulator
function cliQueue(req) {
  req.cmdId = arculatorModule ? req.queue() : -1;
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
  let removed = arculatorModule.ccall('arc_cli_cancel', 'number', ['number'], [req.cmdId]) == 1;
  let killed = !removed && req.via === 'wimp' && cliQueueData('close', req.cmdId, new Uint8Array(0)) > 0;
  let error = `${req.label}: timed out after ${timeout} ms, ` +
    (removed ? 'before it started' : killed ? 'and it was killed' : 'and it is still running');
  postMessage({ type: 'cliReply', id: req.id, error });
}

self.jscliOutput = (cmdId, data) => {
  let req = cliRequests.get(cmdId);
  if (!req) return;
  if (!req.session) {
    req.output.push(data);
  }
  postMessage({ type: 'cliOutput', id: req.id, data });
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
      postMessage({ type: 'cliReply', id: req.id, error: e.message });
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
  let error = failed ? { number: errnum, message: new TextDecoder('latin1').decode(msg) } : null;
  postMessage({ type: 'cliReply', id: req.id, result: { raw, error } }, [raw.buffer]);
};
