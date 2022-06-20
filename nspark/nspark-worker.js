importScripts('nspark.js');

let nsparkModule = null;
let currentTid = 0;
let currentArchive = '';
let currentDir = '';
let completedFiles = [];
let unpackQueue = [];
let printErrHandler = null;

//  filename filesize date filetype stored/compressed
const LISTING_REGEX = /^([^\s]+)\s+(\d+)\s+(\d+-\w+-\d{4} \d\d:\d\d:\d\d)\s+&(\w+)\s+(\w+)/;

function onCloseFile(path) {
    if (path == currentArchive)
        return;
    if (completedFiles.length > 0) {
        notifyFile(completedFiles.pop());
    }
    completedFiles.push(path);
}

function handlePrint(line) {
    console.log(line);
}

function handlePrintErr(line) {
    if (printErrHandler)
        printErrHandler(line);
    else
        console.warn(line);
}

function capturePrintErr(actionFn, handlerFn) {
    if (printErrHandler) {
        console.warn("print err handler already set:", printErrHandler)
    }
    printErrHandler = handlerFn;
    actionFn();
    printErrHandler = null;   
}

async function init() {
    nsparkModule = await createNSparkModule({
        noInitialRun:true, 
        printErr: handlePrintErr,
        print: handlePrint
    });
    nsparkModule.FS.trackingDelegate['onCloseFile'] = onCloseFile;
    doNext();
}

function notifyFile(path) {
    let f = nsparkModule.FS.analyzePath(path);
    let buf = f.object.contents.buffer;
    self.postMessage({
        tid: currentTid, 
        item: {
            path: path.substr(currentDir.length+1), 
            timestamp: f.object.timestamp, 
            buf: buf
        }
    }, [buf]);
    nsparkModule.FS.unlink(path);
}

function doNext() {
    if (!nsparkModule || unpackQueue.length == 0) { 
        return;
    }
    while (unpackQueue.length > 0) {
        let start = performance.now();
        let item = unpackQueue.shift();
        let tid = item.tid;
        let buf = item.buf;
        let action = item.action;

        let filename = tid + '.arc';
        let unpackdir = '/unpack' + tid;

        currentTid = tid;
        currentArchive = unpackdir+'/'+filename;
        currentDir = unpackdir;
        completedFiles = [];

        nsparkModule.FS.mkdir(unpackdir)
        nsparkModule.FS.createDataFile(unpackdir, filename, new Uint8Array(buf), true, true);
        nsparkModule.FS.chdir(unpackdir);

        if (action == 'unpack') {
            nsparkModule.callMain(['-u', '-v', '-T', filename]);
            while (completedFiles.length > 0) {
                notifyFile(completedFiles.pop());
            }
        } else if (action == 'list') {
            capturePrintErr(
                () => nsparkModule.callMain(['-l', '-v', filename]),
                line => {
                    let match = line.match(LISTING_REGEX);
                    // todo match listing for files with load/exec addresses 
                    if (match) {
                        let [all, filename, filesize, date, filetype, storage] = match;
                        self.postMessage({
                            tid: tid,
                            item: {
                                path: filename,
                                filesize: parseInt(filesize),
                                timestamp: Date.parse(date.replaceAll('-', ' ')),
                                filetype: filetype.toLowerCase()
                            }
                        });
                    } else {
                        console.log("no match", line);
                    }
                });
            
        }
        nsparkModule.FS.unlink(currentArchive);
        self.postMessage({tid:tid, done:true, buf:buf}, [buf]);
        let t = performance.now() - start;
        console.log('worker took ' + t + 'ms');
    }
}

self.onmessage = function(msg) {
    unpackQueue.push(msg.data);
    doNext();
}

init();