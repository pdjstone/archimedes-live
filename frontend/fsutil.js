/**
 * Emscripten FS helper functions
 */

function mkdirsForFile(filePath) {
  let bits = filePath.split('/');
  bits.pop(); // remove filename
  let dirPath = '';
  for (let b of bits) {
    dirPath += b + '/';
    try {
      FS.stat(dirPath);
    } catch (e) {
      console.log('creating dir ' + dirPath);
      FS.mkdir(dirPath);
    }
  }
}
  
function baseName(path) {
  if (path.indexOf('/') >= 0)
    return path.substr(path.lastIndexOf('/')+1);
  return path;
}

function dirName(path) {
  if (path.indexOf('/') >= 0)
    return path.substr(0, path.lastIndexOf('/'));
  return '/';
}
  
function putDataAtPath(data, path, timestampMillis=0) {
  mkdirsForFile(path);
  try {
    FS.stat(path);
    console.log('Remove existing file ' + path);
    FS.unlink(path);
  } catch (e) {
    
  }
  FS.createDataFile(dirName(path), baseName(path), data, true, true);
  if (timestampMillis != 0) {
    FS.utime(path, timestampMillis, timestampMillis);
  }
}

async function putUrlAtPath(url, path) {
  let response = await fetch(url, {mode:'cors'});
  let buf = await response.arrayBuffer();
  let data = new Uint8Array(buf);
  console.log(`putting URL ${url} at FS path ${path}`);
  putDataAtPath(data, path);
}