

const ROS_FileType_Map = Object.freeze({
  '.zip': 0xa91,
  '.arc': 0x3fb,
  '.txt': 0xfff,
  '.bas': 0xffb,
  '.jfd': 0xfce
});

const FileTypes = Object.freeze({
  UNKNOWN: {desc:'Unknown file type'},
  ZIP: {desc:'Generic ZIP archive'},
  ZIP_WITH_COMMA_FILETYPES: {desc: 'Generic ZIP with filename,xxx files', unpackFn: unpackRiscOsZipToHostfs},
  RISCOS_ZIP_ARCHIVE: {desc: 'RISC OS ZIP archive', unpackFn: unpackRiscOsZipToHostfs},
  RISCOS_SPARK_ARCHIVE: {desc: 'RISC OS Spark archive', unpackFn: unpackNsparkToHostFs},
  RISCOS_ARCFS_ARCHIVE: {desc: 'RISC OS ArcFS archive', unpackFn: unpackNsparkToHostFs},
  DISC_IMAGE: {desc: 'Disc image', loadDisc: loadDisc},
  DISC_IMAGE_ZIPPED: {desc:'Disc image in ZIP file', loadDisc: loadDiscFromZip},
  DISC_IMAGE_MULTI_ZIPPED: {desc: 'Multiple zipped disc images'},
  FILE_WITH_COMMA_FILETYPE: {desc:'File with filename,xxx name'},
  RISCOS_FILE: {desc: 'RISC OS compatible file'}
});

const RE_COMMA_EXT = /,[a-f0-9]{3}$/i; // 'filename,abc'


function getHostFSPathForZipEntry(fileHeader, dstPath = '/') {
  let hostFsPath = dstPath + fileHeader.filename;
  if (fileHeader.hasOwnProperty('extraFields') && 
    fileHeader['extraFields'].hasOwnProperty(ZIP_EXT_ACORN)) {
      let filename = fileHeader['filename'];
      let riscOsMeta = fileHeader['extraFields'][ZIP_EXT_ACORN];
      let loadAddr = riscOsMeta['loadAddr'];
      let execAddr = riscOsMeta['execAddr'];
      
      // See http://www.riscos.com/support/developers/prm/fileswitch.html
      if (loadAddr >>> 20 == 0xfff) {
        let fileType = loadAddr >>> 8 & 0xfff;
        hostFsPath = dstPath + filename + ',' + fileType.toString(16).padStart(3,'0');
      } else {
        hostFsPath = dstPath + filename + ',' + loadAddr.toString(16).padStart(8,'0') + '-' + execAddr.toString(16).padStart(8,'0');
      }
  }
  return hostFsPath;
}

function getZipEntryRiscOsTimestamp(fileHeader) {
  if (fileHeader.hasOwnProperty('extraFields') && 
    fileHeader['extraFields'].hasOwnProperty(ZIP_EXT_ACORN)) {

    let riscOsMeta = fileHeader['extraFields'][ZIP_EXT_ACORN];
    let loadAddr = riscOsMeta['loadAddr'];
    let execAddr = riscOsMeta['execAddr'];
    if (loadAddr >>> 20 == 0xfff) {
      let cs = parseInt((loadAddr & 0xff).toString(16).padStart(2,'0') + execAddr.toString(16).padStart(8,'0'), 16);
      let ts = new Date(1900,0,1).getTime() + cs*10;
      return ts;
    }
  }
  return 0;
}

/**
 * Check if the filename has a HostFS-compatible (,xxx) extension
 * or if it has an extension that can be mapped to a known RISC-OS
 * file type from ROS_FileType_Map
 */
function isRiscOsCompatibleFilename(filename) {
  if (filename.match(/,[0-9a-f]{3}$/i)) 
    return true;
  for (let ext of Object.keys(ROS_FileType_Map)) {
    if (filename.endsWith(ext))
      return true;
  }
  return false;
}
  

function convertDotExtToHostfsExt(filename) {
  for (const [ext, filetype] of Object.entries(ROS_FileType_Map)) {
    if (filename.toLowerCase().endsWith(ext)) {
      let newFilename = filename.substr(0, filename.length - ext.length) + ',' + filetype.toString(16).padStart(3, '0');
      console.log(`replacing ${ext} extension ${filename} -> ${newFilename}`);
      return newFilename;
    }
  }
  return filename;
}

async function putFileOnHostFs(filename, blob, dst='/') {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  filename = convertDotExtToHostfsExt(filename);
  console.log('putting ' + filename + ' onto HostFS at' + dst);
  FS.createDataFile('/hostfs' + dst, filename, data, true, true);
}

async function loadSoftware(filename, blob, insert=true) {
  let filetype = await identifyFileType(filename, 0, blob);
  console.log('filetype', filetype.desc);
  if ('loadDisc' in filetype) {
    return await filetype.loadDisc(filename, blob, insert);
  } else if ('unpackFn' in filetype) {
    //console.log('unpack', filetype.unpackFn);
    if (unpackArchivesToHostFS)
      await filetype.unpackFn(blob);
    else 
      await putFileOnHostFs(filename, blob);
  } else if (filetype === FileTypes.RISCOS_FILE) {
    await putFileOnHostFs(filename, blob);
  }
}


async function loadSoftwareFromUrl(url, insert=true) {
  if (url == "") return;
  let response = await fetch(url, {mode:'cors'});
  let blob = await response.blob();
  let discFilename = await loadSoftware(baseName(url), blob, insert);
  window.screenshots = 0;
  return discFilename;
}


async function unpackNsparkToHostFs(blob, dst='/') {
  let buf = await blob.arrayBuffer();
  let archive = new NSpark(buf);
  for await (const item of archive.unpack()) {
      let data = new Uint8Array(item.buf);
      putDataAtPath(data, '/hostfs' + dst + item.path, item.timestamp);
  }
}


async function unpackRiscOsZipToHostfs(blob, dst='/') {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  let zip = new RiscOsUnzip(data);

  for (let h of zip.fileHeaderList) {
    if (h.filename.endsWith('/'))
      continue;
    let hostFsPath = getHostFSPathForZipEntry(h);
    let data = zip.decompress(h.filename);
    let timestamp = getZipEntryRiscOsTimestamp(h);
    console.log('creating file at', hostFsPath);
    putDataAtPath(data, '/hostfs' + hostFsPath, timestamp);
  }
}


async function identifyZipFile(filename, size, blob) {
  console.log('Testing ZIP file');
  let header = await blob.slice(0,2).text();
  if (header != 'PK') {
    console.warn("No PK header");
    return FileTypes.UNKNOWN;
  }

  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  let zip = new RiscOsUnzip(data);
  
  let numDiskImages = 0;
  let numCommaExts = 0;
  for (const filename of zip.getFilenames()) {
    if (isDiscImageFilename(filename)) 
      numDiskImages++;
    if (filename.match(RE_COMMA_EXT))
      numCommaExts++;
    //console.log('ZIP entry: ' + filename);
  }
  if (numDiskImages == 1) {
    return FileTypes.DISC_IMAGE_ZIPPED;
  } else if (numDiskImages > 1) {
    return FileTypes.DISC_IMAGE_MULTI_ZIPPED;
  } else if (numCommaExts >= 1) {
    return FileTypes.ZIP_WITH_COMMA_FILETYPES;
  } else if (zip.isRiscOs) {
    return FileTypes.RISCOS_ZIP_ARCHIVE;
  } else {
    return FileTypes.ZIP;
  }
}


async function identifyArchiveType(filename, size, blob) {
  let header = await blob.slice(0,8).arrayBuffer();
  let data = new Uint8Array(header);
  if (data[0] == 0x1a && (data[1] & 0xf0) == 0x80) {
    return FileTypes.RISCOS_SPARK_ARCHIVE;
  }
  if (new TextDecoder().decode(header) == 'Archive\00') {
    return FileTypes.RISCOS_ARCFS_ARCHIVE;
  }
  return FileTypes.UNKNOWN;
}


async function identifyFileType(filename, size, blob) {
  let type = FileTypes.UNKNOWN;
 
  if (isDiscImageFilename(filename)) {
    return FileTypes.DISC_IMAGE;
  }
  if (filename.toLowerCase().endsWith('zip')) {
    type = await identifyZipFile(filename, size, blob);
    if (type != FileTypes.UNKNOWN)
      return type;
  }
  type = await identifyArchiveType(filename, size, blob);
  if (type != FileTypes.UNKNOWN)
      return type;

  if (isRiscOsCompatibleFilename(filename))
    return FileTypes.RISCOS_FILE;
  return type;
}


function downloadHostFSfile(path) {
  let filepath = findHostFsFilePath(path);
  if (!filepath) {
    console.error(`HostFS file not found: ${path}`);
    return;
  }
  let buf = FS.readFile(filepath, {encoding: 'binary'});
  let a = document.createElement('a');
  a.href = window.URL.createObjectURL(new Blob([buf], {type: "application/octet-stream"}));
  a.download = baseName(filepath);
  a.click(); 
}



// Disc image extensions that Arculator handles (see loaders struct in disc.c)
const validDiscExts = Object.freeze(['.adf','.adl', '.fdi', '.apd', '.hfe']);

let currentDiscFile = null;

/**
 * Check if a filename has a known disc extension
 * @param {*} filename disc filename with extension
 * @returns 
 */
 function isDiscImageFilename(filename) {
  filename = filename.toLowerCase();
  for (let ext of validDiscExts) {
    if (filename.endsWith(ext))
      return true;
  }
  return false;
}


async function loadDiscFromZip(filename, blob, insert=true) {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  let unzip = new RiscOsUnzip(data);

  let zipDiscFile = null;

  for (let filename of unzip.getFilenames()) {
    if (isDiscImageFilename(filename)) {
      zipDiscFile = filename;
      break;
    }
  }

  if (!zipDiscFile) {
    console.warn("ZIP file did not contain a disc image with a valid extension");
    return;
  }
  console.log("Extracting " + zipDiscFile);
  data = unzip.decompress(zipDiscFile);
  if (zipDiscFile.indexOf('/') >= 0) 
    zipDiscFile = baseName(zipDiscFile);
  //console.log('loadDiscFromZip', data);
  blob = new Blob([data]);
  return await loadDisc(zipDiscFile, blob, insert);
}


async function loadDisc(filename, blob, insert=true) {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  if (currentDiscFile) {
    ccall('arc_disc_eject', null, ['number'], [0]);
    FS.unlink(currentDiscFile);
  }
  currentDiscFile = filename;
  FS.createDataFile("/", currentDiscFile, data, true, true);
  if (insert) {
    ccall('arc_disc_change', null, ['number', 'string'], [0, '/' + currentDiscFile]);
  }
  return currentDiscFile;
}

const FILETYPE_OBEY = 0xfeb // normal boot
const FILETYPE_COMMAND = 0xffe // basic boot
const FILETYPE_DESKTOP = 0xfea 

function createHostfsBootFile(content, fileType) {
  try {
    for (const filename of FS.readdir('/hostfs/')) {
      if (filename.toLowerCase().startsWith('!boot,')) {
        FS.unlink('/hostfs/' + filename);
      }
    }
  } catch (e) {
    console.log(e);
  }
  putDataAtPath(content, '/hostfs/!Boot,' + fileType.toString(16));
}

// Return the full path of a file under hostfs (with ,ext)
function findHostFsFilePath(path) {
  let s = path.lastIndexOf('/');
  let dir = '/hostfs';
  let filename = path;
  if (s>=0) {
    dir += path.substring(0,s);
    filename = path.substr(s+1);
  }
  let hostfsFilename = '';
  for (const f of FS.readdir(dir)) {
    if (f.startsWith(filename+',') || f == filename) {
      hostfsFilename = dir+'/'+f;
    }
  }
  if (!hostfsFilename) {
    console.warn(`Couldn't find file ${filename} in ${dir}`);
    return null;
  }
  console.log('Found hostfs file ', hostfsFilename);
  return hostfsFilename;
}

function readHostFsTextFile(filepath) {
  let filename = findHostFsFilePath(filepath);
  if (!filename)
    return '';
  let fileBytes = FS.readFile(filename, {encoding: 'binary'});
  return new TextDecoder('iso-8859-1').decode(fileBytes);
}

function roDirname(roFilepath) {
  return roFilepath.substring(0, roFilepath.lastIndexOf('.'));
}