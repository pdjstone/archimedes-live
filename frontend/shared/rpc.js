/**
 * Calls from the page to the worker, and events from the worker to the page.
 *
 * In the worker, expose() makes functions callable and serve() starts
 * answering; emit() sends an event. On the page, connect(worker) gives `emu`,
 * a proxy whose methods call the worker's functions and return Promises of
 * their results (or reject with their errors), and on(event, fn).
 *
 *   // worker                                  // page
 *   expose({ fsList: path => ... });           const { emu, on } = connect(worker);
 *   serve();                                   let names = await emu.fsList('/hostfs');
 *   emit('musicInfo', info);                   on('musicInfo', info => ...);
 *
 * Arguments and results are copied (structured clone). Wrap one in
 * transfer(value, [buffers]) to transfer them instead. A function passed as
 * an argument can be called by the worker until the call settles, e.g. for
 * output as it arrives.
 *
 * Messages without an `rpc` field are left to other listeners.
 */

const TRANSFER = Symbol('transfer');
const CALLBACK = '__rpcCallback';

/** Mark a value whose transferables are moved, not copied: transfer(bytes, [bytes.buffer]) */
export function transfer(value, transferables) {
  return { [TRANSFER]: transferables, value };
}

function unwrap(v) {
  return v?.[TRANSFER] ? [v.value, v[TRANSFER]] : [v, []];
}

function errorMessage(e) {
  return e?.message ?? String(e);
}

// ---- worker side ----

const handlers = new Map();

/** Make these functions (which may be async) callable from the page */
export function expose(fns) {
  for (const [name, fn] of Object.entries(fns)) {
    handlers.set(name, fn);
  }
}

/** Tell the page something happened */
export function emit(event, detail) {
  postMessage({ rpc: 'event', event, detail });
}

/** Answer calls from the page */
export function serve(port = self) {
  port.addEventListener('message', async ({ data }) => {
    if (data?.rpc !== 'call') return;
    const { id, name } = data;
    // Functions the page passed arrive as markers
    const args = data.args.map((a, i) => a?.[CALLBACK]
      ? (...cbArgs) => port.postMessage({ rpc: 'callback', id, arg: i, args: cbArgs })
      : a);
    try {
      const fn = handlers.get(name);
      if (!fn) {
        throw new Error(`The worker has no function '${name}'`);
      }
      const [result, transfers] = unwrap(await fn(...args));
      port.postMessage({ rpc: 'reply', id, result }, transfers);
    } catch (e) {
      port.postMessage({ rpc: 'reply', id, error: errorMessage(e) });
    }
  });
}

// ---- page side ----

/** Call the worker's exposed functions: `await emu.fsRead(path)` */
export function connect(worker) {
  const pending = new Map();
  const events = new EventTarget();
  let nextId = 0;

  worker.addEventListener('message', ({ data }) => {
    switch (data?.rpc) {
      case 'reply': {
        const call = pending.get(data.id);
        pending.delete(data.id);
        if ('error' in data) {
          call.reject(new Error(data.error));
        } else {
          call.resolve(data.result);
        }
        break;
      }
      case 'callback':
        pending.get(data.id)?.callbacks[data.arg]?.(...data.args);
        break;
      case 'event':
        events.dispatchEvent(new CustomEvent(data.event, { detail: data.detail }));
        break;
    }
  });

  function call(name, rawArgs) {
    const id = ++nextId;
    const callbacks = {};
    const transfers = [];
    const args = rawArgs.map((a, i) => {
      if (typeof a === 'function') {
        callbacks[i] = a;
        return { [CALLBACK]: true };
      }
      const [value, t] = unwrap(a);
      transfers.push(...t);
      return value;
    });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, callbacks });
      worker.postMessage({ rpc: 'call', id, name, args }, transfers);
    });
  }

  const emu = new Proxy({}, {
    get(_, name) {
      // Otherwise `await emu`, or returning it from an async function, would
      // call a worker function named 'then'
      if (name === 'then' || typeof name === 'symbol') return undefined;
      return (...args) => call(name, args);
    },
  });

  const on = (event, fn) => events.addEventListener(event, e => fn(e.detail));
  return { emu, on };
}
