/**
 * Emscripten FS helper functions
 */

import { emulator } from './emulator.js'

function mkdirsForFile(filePath) {
  let bits = filePath.split('/');
  bits.pop(); // remove filename
  let dirPath = '';
  for (let b of bits) {
    dirPath += b + '/';
    try {
      emulator.FS.stat(dirPath);
    } catch (e) {
      console.log('creating dir ' + dirPath);
      emulator.FS.mkdir(dirPath);
    }
  }
}
  
export function baseName(path) {
  if (path.indexOf('/') >= 0)
    return path.substr(path.lastIndexOf('/')+1);
  return path;
}

function dirName(path) {
  if (path.indexOf('/') >= 0)
    return path.substr(0, path.lastIndexOf('/'));
  return '/';
}
  
export function putDataAtPath(data, path, timestampMillis=0) {
  mkdirsForFile(path);
  try {
    emulator.FS.stat(path);
    console.log('Remove existing file ' + path);
    emulator.FS.unlink(path);
  } catch (e) {
    
  }
  emulator.FS.createDataFile(dirName(path), baseName(path), data, true, true);
  if (timestampMillis != 0) {
    emulator.FS.utime(path, timestampMillis, timestampMillis);
  }
}

export async function putUrlAtPath(url, path) {
  let response = await fetch(url, {mode:'cors'});
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`.trim());
  }
  let buf = await response.arrayBuffer();
  let data = new Uint8Array(buf);
  console.log(`putting URL ${url} at FS path ${path}`);
  putDataAtPath(data, path);
}
/** Delete everything in a directory, leaving the directory itself */
export function emptyDir(dir) {
  for (let name of emulator.FS.readdir(dir)) {
    if (name == '.' || name == '..')
      continue;
    let path = dir + '/' + name;
    if (emulator.FS.isDir(emulator.FS.stat(path).mode)) {
      emptyDir(path);
      emulator.FS.rmdir(path);
    } else {
      emulator.FS.unlink(path);
    }
  }
}
