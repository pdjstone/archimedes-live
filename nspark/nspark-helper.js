
let worker = null;
let nextTid = 0;
let archiveQueues = {};

class AsyncQueue {

  constructor(doFirst = null) {
    this.buffer = [];
    this.resolve = null;
    this.finished = false;
    this.doFirst = doFirst;
    this.finishCallback = null;
  }

  onFinish(callback) {
    this.finishCallback = callback;
    return this;
  }

  push(item) {
      if (this.resolve) {
        this.resolve(item);
        this.resolve = null;
      } else {
        this.buffer.push(item);
      }
  }
  
  close(finalData) {
      this.finished = true;
      if (this.resolve)
        this.resolve();
      if (this.finishCallback) {
        this.finishCallback(finalData);
      }
  }
    
  [Symbol.asyncIterator]() {
     let self = this;
     return {
        async next() { 
          if (self.doFirst) {
            await self.doFirst();
            self.doFirst = null;
          }
          let item = null;
          if (self.buffer.length > 0) {
            console.log('take from buffer');
            item = self.buffer.shift();
          } else { 
            item = await new Promise(resolve => {
              if (self.resolve)
                console.warning('resolve should be null');
              self.resolve = resolve;
            });
          }
          if (!self.finished) {
            return { done: false, value: item };
          } else {
            return { done: true };
          }
        } 
      }
  }
}


function setupWorker(timeout) {
  let thisUrl = import.meta.url;
  let basePath = thisUrl.substring(0, thisUrl.lastIndexOf('/'));
  worker = new Worker(basePath + '/nspark-worker.js');
  setTimeout(() => checkTerminate(timeout), timeout);
}

function checkTerminate(timeout) {
  if (Object.keys(archiveQueues).length == 0) {
    worker.terminate();
    console.log("terminating nspark worker");
    worker = null;
  } else {
    setTimeout(checkTerminate, timeout);
  }
}

function getWorker(timeout = 5000) {
  if (!worker)
    setupWorker(timeout);
  return worker;
}

export class NSpark {
  constructor(buf) {
    this.buf = buf;
  }

  static async fromUrl(url) {
    let buf = await fetchArchiveUrl(url);
    return new NSpark(buf);
  }

  list() {
    return submitBufferToNsparkWorker(this.buf, 'list', buf => this.buf = buf);
  }
  unpack() {
    return submitBufferToNsparkWorker(this.buf, 'unpack', buf => this.buf = buf);
  }
}

async function fetchArchiveUrl(url) {
  let response = await fetch(url, {mode:'cors'});
  let buf = await response.arrayBuffer();
  return buf;
}

function submitBufferToNsparkWorker(buf, action, bufReturnFn) {
  let tid = nextTid++;
  let q = new AsyncQueue().onFinish(bufReturnFn);
  archiveQueues[tid] = q;
  let worker = getWorker(300000);
  worker.onmessage = function(msg) {
    let tid = msg.data.tid;
    if (!archiveQueues[tid]) {
      console.error('no queue for tid ' + tid);
    } else {
      let q = archiveQueues[tid];
      if (msg.data.hasOwnProperty('done')) {
        q.close(msg.data.buf);
        delete archiveQueues[tid];
      } else {
        q.push(msg.data.item);
      }
    }
  }
  worker.postMessage({
    buf: buf, 
    tid: tid, 
    action: action}, [buf]);
  return q;
}
