import { putDataAtPath, baseName } from './fsutil.js'
import { emulator } from './emulator.js'
import { RiscOsUnzip } from'./riscosunzip.js'
import { NSpark } from './nspark/nspark-helper.js'
import { fetchSoftwareCatalogue } from '../shared/software-catalogue.js'
import { SOFTWARE_BASE } from '../shared/paths.js'
import { Notice, NoticeError, reasonFor } from '../shared/notices.js'

const ROS_FileType_Map = Object.freeze({
  '.zip': 0xddc, // ZIP is 0xa91, but older SparkFS/SparkPlug recognises 0xddc for ZIP
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
  DISC_IMAGE_MULTI_ZIPPED: {desc: 'Multiple zipped disc images', loadDisc: loadDiscFromZip},
  FILE_WITH_COMMA_FILETYPE: {desc:'File with filename,xxx name'},
  RISCOS_FILE: {desc: 'RISC OS compatible file'}
});

const RE_COMMA_EXT = /,[a-f0-9]{3}$/i; // 'filename,abc'


function getHostFSPathForZipEntry(entry, dstPath = '/') {
  let hostFsPath = dstPath + entry.filename;
  if (entry.hasOwnProperty('extraRiscOs')) {
      let filename = entry.filename;
      let loadAddr = entry.extraRiscOs['loadAddr'];
      let execAddr = entry.extraRiscOs['execAddr'];
      
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

function getZipEntryRiscOsTimestamp(entry) {
  if (entry.hasOwnProperty('extraRiscOs')) {
    let loadAddr = entry.extraRiscOs['loadAddr'];
    let execAddr = entry.extraRiscOs['execAddr'];
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
  console.log('Putting ' + filename + ' onto HostFS at ' + dst);
  emulator.FS.createDataFile('/hostfs' + dst, filename, data, true, true);
  return filename;
}

/**
 * Load a file: insert a disc image (or the first in a zip), or unpack an
 * archive or copy a RISC OS file onto HostFS. Resolves with {notice, disc,
 * hostfs}: notice says what was done (shared/notices.js), disc is the disc
 * image's FS name if it was one, and hostfs is set if files went on HostFS.
 * Throws a NoticeError if it can't be loaded.
 */
export async function loadSoftware(filename, blob, insert=true) {
  let filetype;
  try {
    filetype = await identifyFileType(filename, 0, blob);
  } catch (e) {
    // e.g. a corrupt zip
    throw new NoticeError(Notice.UNPACK_FAILED, {file: filename, reason: reasonFor(e)});
  }
  console.log('filetype', filetype.desc);
  if ('loadDisc' in filetype) {
    return await filetype.loadDisc(filename, blob, insert);
  }
  if ('unpackFn' in filetype) {
    let count;
    try {
      count = await filetype.unpackFn(blob);
    } catch (e) {
      throw new NoticeError(Notice.UNPACK_FAILED, {file: filename, reason: reasonFor(e)});
    }
    return {notice: {id: Notice.UNPACKED, params: {file: filename, count}}, hostfs: true};
  }
  if (filetype === FileTypes.RISCOS_FILE) {
    let name;
    try {
      name = await putFileOnHostFs(filename, blob);
    } catch (e) {
      throw new NoticeError(Notice.UNPACK_FAILED, {file: filename, reason: reasonFor(e)});
    }
    return {notice: {id: Notice.COPIED_TO_HOSTFS, params: {file: filename, name}}, hostfs: true};
  }
  if (filetype === FileTypes.ZIP) {
    throw new NoticeError(Notice.ZIP_NOT_RISC_OS, {file: filename});
  }
  throw new NoticeError(Notice.FILE_TYPE_UNKNOWN, {file: filename});
}

/** The software catalogue, or a NoticeError if it can't be fetched */
export async function requireCatalogue() {
  let software = await fetchSoftwareCatalogue();
  if (!software) {
    throw new NoticeError(Notice.CATALOGUE_UNAVAILABLE);
  }
  return software;
}

/**
 * Load a title from the software catalogue, and the titles it depends on.
 * Resolves with its disc image's FS name, if it has one
 */
export async function loadFromSoftwareCatalogue(softwareId, insert=true) {
  console.debug(`loadFromSoftwareCatalogue ${softwareId} insert=${insert}`);
  let software = await requireCatalogue();
  if (!(softwareId in software)) {
    throw new NoticeError(Notice.CATALOGUE_ID_UNKNOWN, {id: softwareId});
  }
  let meta = software[softwareId];
  let discFile = '';
  if ('archive' in meta) {
    await loadSoftwareFromUrl(SOFTWARE_BASE + meta['archive']);
  } else if ('disc' in meta) {
    discFile = (await loadSoftwareFromUrl(SOFTWARE_BASE + meta['disc'], insert)).disc;
  }
  if ('depends' in meta) {
    for (let depId of meta['depends']) {
      console.log(`${softwareId} depends on ${depId}`);
      await loadFromSoftwareCatalogue(depId);
    }
  }

  return discFile;
}

/** Download a file and load it, as loadSoftware */
export async function loadSoftwareFromUrl(url, insert=true) {
  let response;
  try {
    response = await fetch(url, {mode:'cors'});
  } catch (e) {
    throw new NoticeError(Notice.DOWNLOAD_FAILED, {url, reason: reasonFor(e)});
  }
  if (!response.ok) {
    throw new NoticeError(Notice.DOWNLOAD_FAILED, {url, reason: `${response.status} ${response.statusText}`.trim()});
  }
  let blob = await response.blob();
  return await loadSoftware(baseName(url), blob, insert);
}


async function unpackNsparkToHostFs(blob, dst='/') {
  let buf = await blob.arrayBuffer();
  let archive = new NSpark(buf);
  let count = 0;
  for await (const item of archive.unpack()) {
      let data = new Uint8Array(item.buf);
      putDataAtPath(data, '/hostfs' + dst + item.path, item.timestamp);
      count++;
  }
  return count;
}


async function unpackRiscOsZipToHostfs(blob, dst='/') {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  let zip = new RiscOsUnzip(data);
  let count = 0;

  for await (const entry of zip.getEntriesGenerator()) {
    if (entry.directory)
      continue;
    count++;
    let hostFsPath = getHostFSPathForZipEntry(entry);
    let data = await zip.extract(entry);
    let timestamp = getZipEntryRiscOsTimestamp(entry);
    console.log('creating file at', hostFsPath);
    putDataAtPath(data, '/hostfs' + hostFsPath, timestamp);
  }
  return count;
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
  for await (const entry of zip.getEntriesGenerator()) {
    if (isDiscImageFilename(entry.filename)) 
      numDiskImages++;
    if (entry.filename.match(RE_COMMA_EXT))
      numCommaExts++;
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
  const SPK_STARTBYTE = 0x1a; // From spark.h in NSpark
  if (data[0] == SPK_STARTBYTE && ((data[1] & 0xf0) == 0x80 || data[1] == 0xff)) {
    return FileTypes.RISCOS_SPARK_ARCHIVE;
  }
  if (new TextDecoder().decode(header) == 'Archive\x00') {
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

  let zipDiscEntry = null;
  let count = 0;
  for await (const entry of unzip.getEntriesGenerator()) {
    if (isDiscImageFilename(entry.filename)) {
      zipDiscEntry ??= entry;
      count++;
    }
  }
  if (!zipDiscEntry) {
    throw new NoticeError(Notice.FILE_TYPE_UNKNOWN, {file: filename});
  }
  let zipDiscFile = baseName(zipDiscEntry.filename);
  console.log(`Extracting ${zipDiscEntry.filename} (1 of ${count})`);
  try {
    data = await unzip.extract(zipDiscEntry);
  } catch (e) {
    throw new NoticeError(Notice.UNPACK_FAILED, {file: filename, reason: reasonFor(e)});
  }
  let result = await loadDisc(zipDiscFile, new Blob([data]), insert);
  result.notice = count > 1
    ? {id: Notice.DISC_INSERTED_FROM_MULTI_ZIP, params: {disc: zipDiscFile, file: filename, count}}
    : {id: Notice.DISC_INSERTED_FROM_ZIP, params: {disc: zipDiscFile, file: filename}};
  return result;
}


/**
 * Put a disc image in the FS, and in drive 0 if `insert` (otherwise the
 * machine config names it). Resolves as loadSoftware
 */
async function loadDisc(filename, blob, insert=true) {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  try {
    if (currentDiscFile) {
      emulator.ccall('arc_disc_eject', null, ['number'], [0]);
      emulator.FS.unlink(currentDiscFile);
    }
    currentDiscFile = filename;
    emulator.FS.createDataFile("/", currentDiscFile, data, true, true);
    if (insert) {
      emulator.ccall('arc_disc_change', null, ['number', 'string'], [0, '/' + currentDiscFile]);
    }
  } catch (e) {
    throw new NoticeError(Notice.DISC_FAILED, {file: filename, reason: reasonFor(e)});
  }
  return {notice: {id: Notice.DISC_INSERTED, params: {file: filename}}, disc: currentDiscFile};
}

export const FILETYPE_OBEY = 0xfeb // normal boot
export const FILETYPE_COMMAND = 0xffe // basic boot
export const FILETYPE_DESKTOP = 0xfea 

export function createHostfsBootFile(content, fileType) {
  try {
    for (const filename of emulator.FS.readdir('/hostfs/')) {
      if (filename.toLowerCase().startsWith('!boot,')) {
        emulator.FS.unlink('/hostfs/' + filename);
      }
    }
  } catch (e) {
    console.log(e);
  }
  putDataAtPath(content, '/hostfs/!Boot,' + fileType.toString(16));
}

export function roDirname(roFilepath) {
  return roFilepath.substring(0, roFilepath.lastIndexOf('.'));
}