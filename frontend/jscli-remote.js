/*Lets a command line client on this machine (tools/arcterm.py) use the JSCLI
  hooks in jscli-page.js, over a WebSocket. The page can't listen for
  connections, so it connects to the client, at the URL in the jscli
  parameter (e.g. #jscli=ws://127.0.0.1:8765/<token>), and reconnects if the
  connection drops. Only loopback addresses are allowed, so a link can't
  connect the emulator to another machine.

  Messages are JSON. Byte strings (commands, input, output) are Latin-1
  strings, one character per byte. The client sends requests with an id:
    {id, op: 'cli', command, via}   -> result {output, error}
    {id, op: 'open', command}       -> result {session}; then events
                                       {event: 'output', session, data} and
                                       {event: 'ended', session, error}
    {id, op: 'input', session, data}, {id, op: 'close', session}
    {id, op: 'type', data}
    {id, op: 'status'}, {id, op: 'screenshot'} -> result: PNG as base64
  and gets {id, result} or {id, error: message} back. The page sends
  {event: 'status', status} when it connects and whenever arcCliStatus()'s
  callback or wimp changes, so the client knows when the modules are there.

  Sessions outlive the connection, so a program running in one isn't lost
  if the client restarts. When it connects, before the status, the page sends
    {event: 'sessions', page, sessions: [{session, command, tail, unsent,
                                          ended, error}]}
  `page` is different each time the page loads (session ids start again).
  `unsent` is what a session printed while nobody was connected (the end of
  it, if there's a lot), and `tail` the end of everything it printed, e.g. to
  show its prompt. A session that ended meanwhile is listed once, with
  `ended` set.*/

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const STATUS_POLL_MS = 1000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;
const UNSENT_MAX = 65536;
const TAIL_MAX = 1024;
const PAGE_ID = Math.random().toString(36).slice(2);
// Close code from the client when another page has connected in our place
const CLOSE_REPLACED = 4000;

/*Bytes as a string, one character per byte. Not TextDecoder('latin1'), which
  browsers treat as Windows-1252, so &80-&9F would come out as other characters*/
function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return s;
}

let socket = null;
let sessions = new Map();     // session id -> {s: arcCliSession, command, tail, unsent, ended, error}
let nextSessionId = 1;
let lastStatus = null;
let badge = null;

/*Send msg if connected. Returns whether it was sent*/
function send(msg) {
  if (socket && socket.readyState == WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function setConnected(connected) {
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'jscli-remote-badge';
    badge.textContent = 'JSCLI remote';
    badge.title = 'A command line client on this machine is connected to the emulator';
    document.body.appendChild(badge);
  }
  badge.classList.toggle('connected', connected);
}

async function handleRequest(req) {
  switch (req.op) {
  case 'cli': {
    let {raw, error} = await window.arcCli(req.command, {via: req.via || 'callback', timeout: req.timeout || 0});
    return {output: latin1(raw), error};
  }
  case 'open': {
    let id = nextSessionId++;
    let rec = {command: req.command || '', tail: '', unsent: '', ended: false, error: null};
    rec.s = window.arcCliSession(rec.command, {
      onOutput: raw => {
        let data = latin1(raw);
        rec.tail = (rec.tail + data).slice(-TAIL_MAX);
        if (!send({event: 'output', session: id, data})) {
          rec.unsent = (rec.unsent + data).slice(-UNSENT_MAX);
        }
      },
    });
    sessions.set(id, rec);
    rec.s.done.then(({error}) => {
      if (send({event: 'ended', session: id, error})) {
        sessions.delete(id);
      } else {
        // Reported when the client next connects
        rec.ended = true;
        rec.error = error;
      }
    });
    return {session: id};
  }
  case 'input':
  case 'close': {
    let s = sessions.get(req.session)?.s;
    if (!s || s.ended) {
      throw new Error('No such session');
    }
    if (req.op == 'input') {
      await s.send(req.data);
    } else {
      await s.close();
    }
    return null;
  }
  case 'type':
    await window.arcType(req.data);
    return null;
  case 'status':
    return await window.arcCliStatus();
  case 'screenshot':
    return await window.arcScreenshot({base64: true});
  }
  throw new Error(`Unknown op '${req.op}'`);
}

async function pollStatus() {
  if (!socket || socket.readyState != WebSocket.OPEN) return;
  try {
    let status = await window.arcCliStatus();
    if (!lastStatus || status.callback != lastStatus.callback || status.wimp != lastStatus.wimp) {
      lastStatus = status;
      send({event: 'status', status});
    }
  } catch (e) {
    // the worker isn't ready yet
  }
}

function connect(url, retryMs) {
  socket = new WebSocket(url);
  socket.onopen = () => {
    console.log(`JSCLI remote: connected to ${url}`);
    retryMs = RETRY_MIN_MS;
    lastStatus = null;
    setConnected(true);
    let list = [];
    for (let [id, rec] of sessions) {
      let {command, tail, unsent, ended, error} = rec;
      list.push({session: id, command, tail, unsent, ended, error});
      rec.unsent = '';
      if (ended) sessions.delete(id);
    }
    send({event: 'sessions', page: PAGE_ID, sessions: list});
    pollStatus();
  };
  socket.onmessage = async event => {
    let req;
    try {
      req = JSON.parse(event.data);
      send({id: req.id, result: await handleRequest(req)});
    } catch (e) {
      send({id: req?.id, error: String(e.message || e)});
    }
  };
  socket.onclose = event => {
    if (badge?.classList.contains('connected')) {
      console.log('JSCLI remote: disconnected');
    }
    setConnected(false);
    // Sessions carry on, for the client to pick up when it reconnects
    if (event.code == CLOSE_REPLACED) {
      // Otherwise two pages would keep taking the connection from each other
      console.log('JSCLI remote: another page has connected to the client, so not reconnecting. Reload to connect again');
      return;
    }
    setTimeout(() => connect(url, Math.min(retryMs * 2, RETRY_MAX_MS)), retryMs);
  };
}

/*Connect to the client at `url`, which must be a ws: or wss: URL on a
  loopback address. Returns whether it's allowed*/
export function startJscliRemote(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    console.warn(`JSCLI remote: bad URL ${url}`);
    return false;
  }
  if (!['ws:', 'wss:'].includes(u.protocol) || !LOOPBACK_HOSTS.includes(u.hostname)) {
    console.warn(`JSCLI remote: ${url} isn't a ws: URL on this machine (localhost, 127.0.0.1 or [::1]), so not connecting`);
    return false;
  }
  connect(url, RETRY_MIN_MS);
  setInterval(pollStatus, STATUS_POLL_MS);
  return true;
}
