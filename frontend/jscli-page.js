/*The page's side of the JSCLI hooks for scripts: window.arcCli,
  arcCliStatus, arcCliSession, arcVdu and arcType. They send 'cli' messages to
  the worker, which handles them in jscli-worker.js.*/

/*Run a RISC OS * command through one of the JSCLI helper modules in the
  extension ROM (arculator-wasm/src/jscli). `via` picks the module:
  'callback' (module JSCLI) runs the command from a transient callback and
  captures what it prints from WrchV; 'wimp' (module JSCLIWimp) runs it in a
  TaskWindow, so it only works in the desktop and multitasks.
  Resolves with {output, raw, error}: raw is the VDU stream the command
  printed, output the same as plain text, and error {number, message} if the
  command failed. With 'wimp', errors are printed rather than returned, and
  error is only set if the TaskWindow couldn't be started.
  onOutput(raw) is called with each chunk of output as it arrives.
  Rejects if the module isn't loaded, or if the command hasn't finished after
  `timeout` ms. A command that times out before it starts is removed from the
  queue. One that has started is killed with 'wimp'; with 'callback' it
  carries on, and its results are dropped.*/
let cliRequests = new Map();
let cliRequestId = 0;
let arculatorWorker = null;

export function setCliWorker(worker) {
  arculatorWorker = worker;
}

/*Handle a message from the worker if it's a CLI reply or output. Returns
  whether it was*/
export function handleCliMessage(data) {
  if (data.type == 'cliReply') {
    let req = cliRequests.get(data.id);
    cliRequests.delete(data.id);
    if ('error' in data) {
      req.reject(new Error(data.error));
    } else {
      req.resolve(data.result);
    }
    return true;
  }
  if (data.type == 'cliOutput') {
    let req = cliRequests.get(data.id);
    if (req && req.onOutput) req.onOutput(data.data);
    return true;
  }
  return false;
}

function cliRequest(msg, onOutput = null, id = ++cliRequestId) {
  return new Promise((resolve, reject) => {
    cliRequests.set(id, {resolve, reject, onOutput});
    arculatorWorker.postMessage({type: 'cli', id, ...msg});
  });
}

// Parameter bytes taken by each VDU control code
const VDU_PARAMS = {1: 1, 17: 1, 18: 2, 19: 5, 22: 1, 23: 9, 24: 8, 25: 5, 28: 4, 29: 4, 31: 2};

/*Turn a VDU stream into plain text: drop control codes and their parameters,
  keep printable characters and line feeds. To convert a stream in chunks,
  pass the same `state` object each time: a control code's parameters can be
  in the next chunk*/
function vduToText(raw, state = {skip: 0}) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i];
    if (state.skip) {
      state.skip--;
    } else if (c == 10) {
      out += '\n';
    } else if (c in VDU_PARAMS) {
      state.skip = VDU_PARAMS[c];
    } else if (c >= 32 && c != 127) {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

window.arcCli = async function(command, {via = 'callback', onOutput = null, timeout = 0} = {}) {
  let {raw, error} = await cliRequest({op: 'run', command, via, timeout}, onOutput);
  return {output: vduToText(raw), raw, error};
};

/*Bytes for arcVdu and arcType: a string (one byte per character, so Latin-1),
  a Uint8Array, or an array of numbers and strings, e.g. [17, 1, 'Red', 13, 10]*/
function toBytes(data) {
  if (typeof data == 'string') {
    return Uint8Array.from(data, c => c.charCodeAt(0) & 0xff);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return Uint8Array.from(Array.from(data).flatMap(x => typeof x == 'string' ? Array.from(toBytes(x)) : [x]));
}

async function cliData(op, data, timeout) {
  let {error} = await cliRequest({op, data: toBytes(data), timeout});
  if (error) {
    throw new Error(`arc ${op}: ${error.message}`);
  }
}

/*Start a session: a TaskWindow that stays open, run by JSCLIWimp (so in the
  desktop only), for interactive use. It runs `command`, or with none gives a
  * prompt. Unlike arcCli, nothing tells when something you send has
  finished: the output is a stream, as in a terminal, so look for the prompt
  with expect(). Returns the session at once:
    send(text)   sends bytes (as for arcType) to the TaskWindow as input, e.g.
                 'Cat\r'. Resolves once sent. '\x1b' is Escape.
    read()       the output since the last read() or expect(), as text
    expect(pattern, {timeout = 10000})
                 waits for output matching `pattern` (a string or RegExp) and
                 resolves with the text up to the end of the match, which is
                 used up. Rejects on timeout, or if the session ends first
    close()      kills the TaskWindow, resolving with `done`'s result
    done         resolves with {error} when the TaskWindow exits: error is
                 null, or {number, message} if it couldn't be started
    ended        whether it has exited
  onOutput(raw) gets each chunk of output as it arrives, as a VDU stream.
  Several sessions can be open at once, and arcCli(..., {via: 'wimp'}) still
  runs commands alongside them.*/
window.arcCliSession = function(command = '', {onOutput = null} = {}) {
  let vduState = {skip: 0};
  let waiters = new Set();
  let id = ++cliRequestId;
  let session = {
    text: '',
    ended: false,
    send(data) {
      if (session.ended) {
        return Promise.reject(new Error('arcCliSession: the session has ended'));
      }
      return cliRequest({op: 'input', session: id, data: toBytes(data)});
    },
    read() {
      let text = session.text;
      session.text = '';
      return text;
    },
    expect(pattern, {timeout = 10000} = {}) {
      return new Promise((resolve, reject) => {
        let waiter = {
          check() {
            let end;
            if (typeof pattern == 'string') {
              let i = session.text.indexOf(pattern);
              end = i < 0 ? -1 : i + pattern.length;
            } else {
              let m = pattern.exec(session.text);
              end = m ? m.index + m[0].length : -1;
            }
            if (end >= 0) {
              finish();
              resolve(session.text.slice(0, end));
              session.text = session.text.slice(end);
            } else if (session.ended) {
              finish();
              reject(new Error(`arcCliSession: the session ended without printing ${pattern}`));
            }
          },
        };
        let timer = setTimeout(() => {
          finish();
          reject(new Error(`arcCliSession: ${pattern} not printed after ${timeout} ms`));
        }, timeout);
        let finish = () => {
          clearTimeout(timer);
          waiters.delete(waiter);
        };
        waiters.add(waiter);
        waiter.check();
      });
    },
    async close() {
      if (!session.ended) {
        await cliRequest({op: 'close', session: id});
      }
      return session.done;
    },
  };
  let wake = () => {
    for (let w of [...waiters]) w.check();
  };
  session.done = cliRequest({op: 'session', data: toBytes(command)}, raw => {
    session.text += vduToText(raw, vduState);
    if (onOutput) onOutput(raw);
    wake();
  }, id).then(({error}) => ({error}), e => ({error: {number: 0, message: e.message}}))
    .then(result => {
      session.ended = true;
      wake();
      return result;
    });
  return session;
};

/*Write bytes to the VDU drivers (OS_WriteN), through the JSCLI module, e.g.
  arcVdu([22, 12]) for MODE 12, or arcVdu('\x11\x01Red text'). It's drawn on
  the screen, in the desktop too (over the windows). Resolves once written.*/
window.arcVdu = function(data, {timeout = 0} = {}) {
  return cliData('vdu', data, timeout);
};

/*Type text into the keyboard buffer (OS_Byte 153) through the JSCLI module,
  as if typed: arcType('PRINT 6*7\r'). Return is '\r'; '\x1b' is Escape,
  as if pressed; codes from &80 are the function and cursor keys: F1-F9 are
  &81-&89, F10-F12 &CA-&CC (so '\xcc' opens the desktop's command line).
  Programs, the * prompt and the desktop all see them as keystrokes.
  Resolves once all are in the buffer (which is small, so long text is put in
  as the buffer empties), not once they've been read.*/
window.arcType = function(text, {timeout = 0} = {}) {
  return cliData('keys', text, timeout);
};

/*Which JSCLI modules are loaded: {callback, wimp}, each true or false.
  With JSCLIWimp loaded there's also wimpIdleMs, the emulated ms since it last
  checked for commands (it does on every null event while idle, so it stays
  under ~100 ms unless the desktop is suspended), and wimpBusy, whether it's
  running a command (when wimpIdleMs only counts since its last output).*/
window.arcCliStatus = function() {
  return cliRequest({op: 'status'});
};
