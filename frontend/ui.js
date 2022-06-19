var statusElement = document.getElementById('status');
var progressElement = document.getElementById('progress');
var spinnerElement = document.getElementById('spinner');

const ROM_BASE_PROD = 'https://files-archi.medes.live/roms/';
const ROM_BASE_TEST = 'emu/roms/';

const ROM_BASE = ROM_BASE_TEST;

var Module = {
  noInitialRun: true,
  onRuntimeInitialized: function() {
    console.log('runtime initialised');
    preload.then(() => {
      let configName = currentMachineConfig.getMachineType();
      console.log('calling main...(' + fps + ',' + configName + ')');
      callMain([fps.toString(), configName]);
      console.log('calling main done');
    })
  },
  preRun: [],
  postRun: [],
  logReadFiles: true,
  print: (function() {
    var element = document.getElementById('output');
    if (element) element.value = ''; // clear browser cache
    return function(text) {
      if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
      // These replacements are necessary if you render to raw HTML
      //text = text.replace(/&/g, "&amp;");
      //text = text.replace(/</g, "&lt;");
      //text = text.replace(/>/g, "&gt;");
      //text = text.replace('\n', '<br>', 'g');
      console.log(text);
      if (element) {
        element.value += text + "\n";
        element.scrollTop = element.scrollHeight; // focus on bottom
      }
    };
  })(),

  canvas: (function() {
    var canvas = document.getElementById('canvas');

    // As a default initial behavior, pop up an alert when webgl context is lost. To make your
    // application robust, you may want to override this behavior before shipping!
    // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
    canvas.addEventListener("webglcontextlost", function(e) { alert('WebGL context lost. You will need to reload the page.'); e.preventDefault(); }, false);

    return canvas;
  })(),

  setStatus: function(text) {
    if (!Module.setStatus.last) Module.setStatus.last = { time: Date.now(), text: '' };
    if (text === Module.setStatus.last.text) return;
    var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
    var now = Date.now();
    if (m && now - Module.setStatus.last.time < 30) return; // if this is a progress update, skip it if too soon
    Module.setStatus.last.time = now;
    Module.setStatus.last.text = text;
    if (m) {
      text = m[1];
      progressElement.value = parseInt(m[2])*100;
      progressElement.max = parseInt(m[4])*100;
      progressElement.hidden = false;
      spinnerElement.hidden = false;
    } else {
      progressElement.value = null;
      progressElement.max = null;
      progressElement.hidden = true;
      if (!text) spinnerElement.style.display = 'none';
    }
    statusElement.innerHTML = text;
  },

  totalDependencies: 0,

  monitorRunDependencies: function(left) {
    this.totalDependencies = Math.max(this.totalDependencies, left);
    Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
  }

};

let queryString = '';
if (location.hash)
  queryString = '?' + location.hash.substr(1);

let searchParams = new URLSearchParams(queryString);
let machinePreset = 'a3000';
let autoboot = false;
let unpackArchivesToHostFS = true;

let fps = 0;

if (searchParams.has('fixedfps')) {
  fps = searchParams.get('fixedfps');
  if (fps != null) {
    fps = parseInt(fps);
  } else {
    fps = 60;
  }
  console.log('UI: Fixing frame rate to ' + fps + ' FPS');
}
if (searchParams.has('preset')) {
  machinePreset = searchParams.get('preset');
}

/*if (searchParams.has('ff')) {
  Module.postRun.push(function() {
    let ff_ms = parseInt(searchParams.get('ff'));
    console.log(`UI: postRun - fast forward to ${ff_ms} ms`);
    ccall('arc_fast_forward', null, ['number'], [ff_ms]);
  });
}*/


if (searchParams.has('autoboot')) {
  Module.preRun.push(function() {
    let autoboot = searchParams.get('autoboot');
    console.log('UI: preRun - create !boot:' + autoboot);
    putDataAtPath(autoboot, '/hostfs/!boot,feb');
  }); 
  autoboot = true;
} else if (searchParams.has('basic')) {
  let prog = searchParams.get('basic');
  prog = showEditor(prog);
  Module.preRun.push(function() {
    console.log('UI: preRun - create !boot and prog');
    putDataAtPath(wrapProg(prog), '/hostfs/!boot,ffe');
  });
  Module.postRun.push(function() {
    //ccall('arc_fast_forward', null, ['number'], [6000]);
  });
  
  autoboot = true;
}

Module.preRun.push(function() {
  ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT ="#canvas";
});

Module.arguments = [fps.toString()];
if (machinePreset) {
  console.log('UI: Using preset machine config ' + machinePreset);
  Module.arguments.push(machinePreset); // we use config file name == machine name
  Module.preRun.push(() => preload = loadMachineConfig());
  
}

Module.setStatus('Downloading...');

window.onerror = function(event) {
    // TODO: do not warn on ok events like simulating an infinite loop or exitStatus
    Module.setStatus('Exception thrown, see JavaScript console');
    spinnerElement.style.display = 'none';
    Module.setStatus = function(text) {
    if (text) Module.printErr('[post-exception status] ' + text);
    };
};

let currentDiscFile = null;

const ZIP_EXT_ACORN = 0x4341; // 'AC' - SparkFS / Acorn
const ZIP_ID_ARC0 = 0x30435241; // 'ARC0'

function parseRiscOsZipField(offset, len) {
  // See https://www.davidpilling.com/wiki/index.php/SparkFS "A Comment on Zip files"
  if (len == 24) len = 20;
  let id2 = this.getInt(offset + 4, 4);
  if (id2 != ZIP_ID_ARC0)
    return null;
  this.isRiscOs = true;
  return {
    len: len,
    loadAddr: this.getInt(offset + 8, 4) >>> 0,
    execAddr: this.getInt(offset + 12, 4) >>> 0,
    attr: this.getInt(offset + 16, 4) >>> 0
  };
}

function getHostFSPathForZipEntry(fileName, fileMeta, dstPath = '/') {
  let hostFsPath = dstPath + fileName;
  if (fileMeta.hasOwnProperty('extraFields') && 
      fileMeta['extraFields'].hasOwnProperty(ZIP_EXT_ACORN)) {
      
        let riscOsMeta = fileMeta['extraFields'][ZIP_EXT_ACORN];
        let loadAddr = riscOsMeta['loadAddr'];
        let execAddr = riscOsMeta['execAddr'];
        
        // See http://www.riscos.com/support/developers/prm/fileswitch.html
        if (loadAddr >>> 20 == 0xfff) {
          let fileType = loadAddr >>> 8 & 0xfff;
          hostFsPath = dstPath + fileName + ',' + fileType.toString(16).padStart(3, '0');
        } else {
          hostFsPath = dstPath + fileName + ',' + loadAddr.toString(16).padStart(8,'0') + '-' + execAddr.toString(16).padStart(8,'0');
        }
     }
     return hostFsPath;
}

// Disc image extensions that Arculator handles (see loaders struct in disc.c)
let validDiscExts = ['.ssd','.dsd','.adf','.adl', '.fdi', '.apd', '.hfe'];

function isDiscImageFilename(filename) {
  filename = filename.toLowerCase();
  for (let ext of validDiscExts) {
    if (filename.endsWith(ext))
      return true;
  }
  return false;
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

async function t() {
  let response = await fetch('discs/Liquid.zip', {mode:'cors'});
  let buf = await response.arrayBuffer();
  
  
  let zip = new JSUnzip();
  zip.open(data);
  let result = zip.readBinary('!Dreams/End/PerP');
  if (!result.status) {
    console.error("failed to extract file", result);
  } else {
    console.log('worked', result);
  }

}
// Unpack an archive file to HostFS
async function loadArchive(url, dstPath='/') {
    let response = await fetch(url, {mode:'cors'});
    let buf = await response.arrayBuffer();
    let data = new Uint8Array(buf);
    var preamble = new TextDecoder().decode(data.slice(0, 2));
    if (preamble == 'PK') {
      console.log("Extracting ZIP file to find disc image");
      let zip = new JSUnzip();
      zip.registerExtension(ZIP_EXT_ACORN, parseRiscOsZipField);
      zip.open(data);
      // TODO: loop asynchronously?
      for (const fileName in zip.files) {
        let hostFsPath = getHostFSPathForZipEntry(fileName, zip.files[fileName]);
        let result = zip.readBinary(fileName);
        if (!result.status) {
          console.error("failed to extract file: " + fileName, result);
        } else {
          putDataAtPath(result.data, '/hostfs' + hostFsPath);
        }
      }
    } else {
      console.error('unknown archive filetype - not zip?');
    }
}

function arc_set_display_mode(display_mode) {
  ccall('arc_set_display_mode', null, ['number'], display_mode);
}

function arc_set_dblscan(dbl_scan) {
  ccall('arc_set_dblscan', null, ['number'], dbl_scan);
}

function arc_enter_fullscreen() {
  ccall('arc_enter_fullscreen', null, []);
}

function arc_renderer_reset() {
  ccall('arc_renderer_reset', null, []);
}

function arc_do_reset() {
  ccall('arc_do_reset', null, []);
}

function arc_load_config_and_reset(configName) {
  ccall('arc_load_config_and_reset', null, ['string'], [configName]);
}

function arc_set_sound_filter(filter) {
  ccall('arc_set_sound_filter', null, ['number'], [filter]);
}

function sdl_enable_mouse_capture() {
  ccall('sdl_enable_mouse_capture', null, []);
}

function sdl_disable_mouse_capture() {
  ccall('sdl_disable_mouse_capture', null, []);
}


async function* makeTextFileLineIterator(fileURL) {
    const utf8Decoder = new TextDecoder('utf-8');
    const response = await fetch(fileURL);
    const reader = response.body.getReader();
    let { value: chunk, done: readerDone } = await reader.read();
    chunk = chunk ? utf8Decoder.decode(chunk) : '';

    const re = /\n|\r|\r\n/gm;
    let startIndex = 0;
    let result;

    for (;;) {
        let result = re.exec(chunk);
        if (!result) {
        if (readerDone) {
            break;
        }
        let remainder = chunk.substr(startIndex);
        ({ value: chunk, done: readerDone } = await reader.read());
        chunk = remainder + (chunk ? utf8Decoder.decode(chunk) : '');
        startIndex = re.lastIndex = 0;
        continue;
        }
        yield chunk.substring(startIndex, result.index);
        startIndex = re.lastIndex;
    }
    if (startIndex < chunk.length) {
        // last line didn't end in a newline char
        yield chunk.substr(startIndex);
    }
}

async function setupDiscPicker() {
    let dropdown = document.getElementById('discs');
    for await (let discUrl of makeTextFileLineIterator('disc_index.txt')) {
        let discName = discUrl.substr(discUrl.lastIndexOf('/')+1);
        dropdown.add(new Option(discName, discUrl));
    }
}

function simulateKeyEvent(eventType, keyCode, charCode) {
  var e = document.createEventObject ? document.createEventObject() : document.createEvent("Events");
  if (e.initEvent) e.initEvent(eventType, true, true);

  e.keyCode = keyCode;
  e.which = keyCode;
  e.charCode = charCode;

  // Dispatch directly to Emscripten's html5.h API (use this if page uses emscripten/html5.h event handling):
  if (typeof JSEvents !== 'undefined' && JSEvents.eventHandlers && JSEvents.eventHandlers.length > 0) {
    for(var i = 0; i < JSEvents.eventHandlers.length; ++i) {
      if ((JSEvents.eventHandlers[i].target == Module['canvas'] || JSEvents.eventHandlers[i].target == window)
       && JSEvents.eventHandlers[i].eventTypeString == eventType) {
         JSEvents.eventHandlers[i].handlerFunc(e);
      }
    }
  } else {
    // Dispatch to browser for real (use this if page uses SDL or something else for event handling):
    Module['canvas'].dispatchEvent ? Module['canvas'].dispatchEvent(e) : Module['canvas'].fireEvent("on" + eventType, e);
  }
}

function sendKeyCode(keycode) {
  simulateKeyEvent('keydown', keycode, 0);
  setTimeout(() => simulateKeyEvent('keyup', keycode, 0), 100);
}

function rerunProg() {
  sendKeyCode(KEY_ESCAPE);
  setTimeout(() => sendKeyCode(KEY_F1), 200);
  setTimeout(() => document.getElementById('editor').focus(), 200);
}

function wrapProg(prog) {
  return '*KEY1 *!boot |M\n*basic\n' + prog + '\nRUN\n';
}

async function runProgram() {
  let prog = document.getElementById('editor').value;
  if (!currentMachineConfig.autoboot) {
    let reboot = await showBooleanDialog('Run BASIC program', 'Reboot emulator to BASIC prompt?', 'Reboot', 'Cancel');
    if (reboot) {
      autoboot = true;
      await changeMachine(machinePreset);
    }
  }
  putDataAtPath(wrapProg(prog), '/hostfs/!boot,ffe');
  rerunProg();
  saveProgramToLocalStorage();
}

function saveProgramToLocalStorage() {
  let prog = document.getElementById('editor').value;
  if (prog.trim() == '')
    return;
  localStorage.basicProg = prog;
  console.log('saved program to localStorage');
}

const KEY_ESCAPE = 27;
const KEY_F1 = 112;

setupDiscPicker();

function setClipboard(text) {
  var type = "text/plain";
  var blob = new Blob([text], { type });
  var data = [new ClipboardItem({ [type]: blob })];

  navigator.clipboard.write(data).then(
      function () {
      /* success */
      },
      function () {
      /* failure */
      }
  );
}

function closeModal(id, event = null) {
  if (!event || event && (event.target.classList.contains('modal')  || event.target.classList.contains('modal-content')))
    document.getElementById(id).style.display = 'none';
}

function getBasicShareUrl() {
  let prog = document.getElementById('editor').value;
  return location.protocol + '//' + location.host + location.pathname + '#basic=' + encodeURIComponent(prog);
}

function showShareBox() {
  showModal('share-box');
  document.getElementById('share-url').value = getBasicShareUrl();
  setTimeout(() => {
    document.getElementById('share-url').select();
    document.getElementById('share-url').focus();
  }, 5);
}

function tweetProg() {
  let prog = document.getElementById('editor').value;
  let url = "https://twitter.com/intent/tweet?screen_name=ARM2bot&text=" + encodeURIComponent(prog);
  window.open(url);
  closeModal('share-box');
}

function copyProgAsURL() {
  navigator.clipboard.writeText(getBasicShareUrl()).then(function() {
    console.log('clipboard write ok');
  }, function() {
    console.log('clipboard write failed');
  });
  closeModal('share-box');
}

function showEditor(program = '') {
  if (program == '') {
    if ('basicProg' in localStorage)
      program = localStorage.basicProg;
  }
  document.getElementById('editor').value = program;
  document.getElementById('editor-container').style.display = 'block';
  updateCharCount();
  setTimeout(() => {
    let editor = document.getElementById('editor');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, 20);
  return program;
}

function updateCharCount() {
  let prog = document.getElementById('editor').value;
  document.getElementById('char-count').textContent = prog.length.toString() + ' characters';
  if (window.saveBasicTimeout)
    clearTimeout(window.saveBasicTimeout)
  window.saveBasicTimeout = setTimeout(saveProgramToLocalStorage, 1000);
}

function tryCapture(event) {
  if (document.pointerLockElement)
    return;
  document.getElementById('canvas').requestPointerLock();
  if (event.ctrlKey)
    document.getElementById('display-container').requestFullscreen();
}

document.addEventListener('pointerlockchange', lockChangeAlert, false);


function lockChangeAlert() {
  if (document.pointerLockElement === canvas) {
    console.log('The pointer lock status is now locked');
    sdl_enable_mouse_capture();
  } else {
    console.log('The pointer lock status is now unlocked');
    sdl_disable_mouse_capture();
  }
}

function updateConfigUI(config) {
  let el = document.getElementById('machine-status');
  el.querySelector('.name').textContent = config.getMachineName();
  el.querySelector('.memory').textContent = MEM_SIZE_NAMES[config.getMemory()];
  el.querySelector('.os').textContent = OS_NAMES[config.getOs()];
  el.querySelector('.processor').textContent = CPU_DESCRIPTIONS[config.getProcessor()];
}

document.getElementById('editor').addEventListener('keypress', e => updateCharCount());

async function loadMachineConfig() {
  console.log('loading preset machine: ' + machinePreset);
  let builder = presetMachines[machinePreset]();

  if (searchParams.has('disc')) {
      let discUrl = searchParams.get('disc')
      console.log('UI: load disc URL ' + discUrl);
      let discFile = await loadSoftwareFromUrl(discUrl, false);
      builder.disc(discFile);
  }
  if (autoboot) {
    builder.autoboot();
  }

  let machineConfig = builder.build();
  updateConfigUI(machineConfig);
  putConfigFile(machineConfig);
  putCmosFile(machineConfig);
  await loadRoms(machineConfig);
  try {
    FS.mkdir('/hostfs');
  } catch (e) {
    console.log('hostfs dir already exists');
  }
  window.currentMachineConfig = machineConfig;
  console.log('machine config loaded');
  return machineConfig;
}


function showModal(id) {
  let el = document.getElementById(id);
  el.style.display = 'flex';
  return el;
}

async function showBooleanDialog(title, text, trueText='OK', falseText='Cancel') {
  let modal = showModal('generic-dialog');
  modal.querySelector('h2').textContent = title;
  modal.querySelector('p').textContent = text;
  let buttons = modal.querySelectorAll('button');
  let trueButton = buttons[1];
  let falseButton = buttons[0];

  trueButton.textContent = trueText;
  falseButton.textContent = falseText;
  let promise = new Promise((resolve, reject) => {
    trueButton.onclick = () => resolve(true);
    falseButton.onclick = () => resolve(false);
  });
  let val = await promise;
  closeModal('generic-dialog');
  console.log('clicked', val);
  return val;
}

async function changeMachine(presetName) {
  machinePreset = presetName;
  let config = await loadMachineConfig();
  arc_load_config_and_reset(config.getMachineType());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function putConfigFile(machineConfig) {
  let configName = machineConfig.getMachineType();
  let configFileData = machineConfig.getConfigFile();
  console.log('creating machine config file at /configs/' + configName + '.cfg');
  try {
    let path = '/configs/' + configName + '.cfg';
    FS.stat(path);
    FS.unlink(path);
    console.log('removed existing config file at ' + path);
  } catch (e) {
    
  }
  
  try {
    FS.mkdir('/configs');
  } catch(e) {
    console.log('dir /configs already exists?');
  }
  
  FS.createDataFile('/configs', configName + '.cfg', configFileData, true, true);
  //console.log(configFileData);
}

function putCmosFile(machineConfig) {
  let cmosPath = machineConfig.getMachineCmosPath();
  let cmosName = machineConfig.getCmosName();
  console.log(`cmos path=${cmosPath} cmos name=${cmosName}`)
  let cmosData = atob(DEFAULT_CMOS[cmosName]);
  if (machineConfig.autoboot) { 
    if (CMOS_BOOT_HOSTFS.hasOwnProperty(cmosName)) {
      console.log('using autoboot CMOS for ' + cmosName);
      cmosData = atob(CMOS_BOOT_HOSTFS[cmosName]);
    }  else {
      console.warn("No autoboot CMOS for " + cmosName);
    }
  }
  putDataAtPath(cmosData, cmosPath);
}




const CPU_ARM2 = 0;
const CPU_ARM250 = 1;
const CPU_ARM3_20 = 2;
const CPU_ARM3_25 = 3;
const CPU_ARM3_26 = 4;
const CPU_ARM3_30 = 5;
const CPU_ARM3_33 = 6;
const CPU_ARM3_35 = 7;
const CPU_ARM3_24 = 8;

const MEMC_MEMC1 = 0;
const MEMC_MEMC1A_8 = 1;
const MEMC_MEMC1A_12 = 2;
const MEMC_MEMC1A_16 = 3;

const FDC_WD1770 = 0;
const FDC_82C711 = 1;
const FDC_WD1793_A500 = 2;


let presetMachines = {
  'a310-arthur':  () => new MachineConfigBuilder('a310', "A310 (Arthur 1.20)")
    .cpu(CPU_ARM2)
    .memory(1024)
    .memc(MEMC_MEMC1)
    .fdc(FDC_WD1770)
    .rom('arthur120'),
  'a310-ro2':  () => new MachineConfigBuilder('a310', "A310 (RISC OS 2)")
    .cpu(CPU_ARM2)
    .memory(1024)
    .memc(MEMC_MEMC1)
    .fdc(FDC_WD1770)
    .rom('riscos201'),
  'a3000': () => new MachineConfigBuilder('a3000', "A3000 (RISC OS 3)")
    .cpu(CPU_ARM2)
    .memory(2048)
    .memc(MEMC_MEMC1A_8)
    .fdc(FDC_WD1770)
    .rom('riscos311'),
  'a5000': () => new MachineConfigBuilder('a5000', "A5000")
    .cpu(CPU_ARM3_25)
    .memory(4096)
    .memc(MEMC_MEMC1A_12)
    .rom('riscos311'),
  'a3020': () => new MachineConfigBuilder('a3020', "A3020")
    .cpu(CPU_ARM250)
    .memory(2048)
    .memc(MEMC_MEMC1A_12)
    .rom('riscos311')
}

let OS_NAMES = {
  'arthur030': 'Arthur 0.3',
  'arthur120': 'Arthur 1.2',
  'riscos311': 'RISC OS 3.11',
  'riscos201': 'RISC OS 2.01'
};

let machineInfo = {
  'a310': {name: 'Archimedes 310', released: 'July 1987', price: '£875'},
  'a410/1': {name: 'Archimedes 410/1', released: 'June 1989', price: '£999'},
  'a3000': {name: 'A3000', released: 'May 1989', price: '£649'},
  'a5000': {name: 'A5000', released: 'September 1991', price: '£999 (25 MHz) or £1,499 (33 MHz) including monitor'},
  'a3010': {name: 'A3010', released: 'September 1992', price: '£499'},
  'a3020': {name: 'A3020', released: 'September 1992', price: '£800 including monitor'},
}

let CPU_DESCRIPTIONS = {};

CPU_DESCRIPTIONS[CPU_ARM2]= "ARM2 @ 8 MHz";
CPU_DESCRIPTIONS[CPU_ARM250]="ARM250 @ 12 MHz";
CPU_DESCRIPTIONS[CPU_ARM3_25]= "ARM3 @ 25 MHz";
CPU_DESCRIPTIONS[CPU_ARM3_26]= "ARM3 @ 26 MHz";
CPU_DESCRIPTIONS[CPU_ARM3_33]="ARM3 @ 33 MHz";

let MEM_SIZE_NAMES = {
  512: '512 KB',
  1024: '1 MB',
  2048: '2 MB',
  4096: '4 MB',
  8192: '8 MB'
};

class MachineConfigBuilder {
  params = {
    machine: 'a3000',
    mem_size: 4096,
    cpu_type: 0,
    memc_type: 0,
    fpa_enabled: 0,
    fpa_type: 1,
    rom_set: 'riscos311',
    fdc_type: 1,
    support_rom: 1,
    disc: '',
    autoboot: false
  }

  constructor(machine, configName) {
    if (machine)
      this.params['machine'] = machine;
    if (!configName)
      configName = machine;
    this.configName = configName;  
  }

  getMemory() {
    return this.params['mem_size'];
  }

  memory(memSize) {
    this.params['mem_size'] = memSize;
    return this;
  }

  getMachine() {
    return this.params['machine'];
  }

  getCpu() {
    return this.params['cpu_type'];
  }

  cpu(cpuType) { 
    this.params['cpu_type'] = cpuType;
    return this;
  }

  memc(memcType) {
    this.params['memc_type'] = memcType;
    return this;
  }

  fdc(fdcType) { 
    this.params['fdc_type'] = fdcType;
    return this;
  }

  getRom() {
    return this.params['rom_set'];
  }

  rom(romSet) {
    this.params['rom_set'] = romSet;
    return this;
  }

  disc(discPath) { 
    this.params['disc'] = discPath;
    return this;
  }

  supportRom(supportRom = true) { 
    if (!supportRom)
      supportRom = false;

    this.params['support_rom'] = supportRom;
    return this;
  }

  autoboot(autoboot = true) {
    this.params['autoboot'] = autoboot;
  }

  build() {
    return new MachineConfig(this.configName, this.params);
  }
}

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

function putDataAtPath(data, path, timestamp=0) {
  mkdirsForFile(path);
  try {
    FS.stat(path);
    console.log('Remove existing file ' + path);
    FS.unlink(path);
  } catch (e) {
    
  }
  FS.createDataFile(dirName(path), baseName(path), data, true, true);
  if (timestamp != 0) {
    FS.utime(path, timestamp * 1000);
  }
}

async function putUrlAtPath(url, path) {
  let response = await fetch(url, {mode:'cors'});
  let buf = await response.arrayBuffer();
  let data = new Uint8Array(buf);
  console.log(`putting URL ${url} at FS path ${path}`);
  putDataAtPath(data, path);
}

async function loadRoms(machineConfig) {
  let romUrls = machineConfig.getRomUrls();
  for (const [fsPath, romUrl] of Object.entries(romUrls)) {
   await putUrlAtPath(romUrl, fsPath);
  }
}


class MachineConfig {
  constructor(configName, params) {
    this.configName = configName;
    this.configParams = params;
    this.autoboot = params.autoboot;
  }

  getMachineName() {
    return machineInfo[this.configParams['machine']].name;
  }

  getMachineType() {
    return this.configParams['machine'];
  }

  getMemory() {
    return this.configParams['mem_size'];
  }

  getProcessor() {
    return this.configParams['cpu_type'];
  }

  getCmosName() {
    let romset = this.configParams['rom_set'];
    let cmos = '';
    if (romset.startsWith('arthur'))
      cmos = 'arthur';
    else if (romset.startsWith('riscos2'))
      cmos = 'riscos2';
    else if (romset.startsWith('riscos3')) {
      if (this.configParams['fdc_type'] == FDC_82C711)
        cmos = 'riscos3_new';
      else 
        cmos = 'riscos3_old';
    }
    return cmos;
  }

  getMachineCmosPath() {
    let cmos = this.getCmosName();
    let configName = this.configParams['machine'];
    return `cmos/${configName}.${cmos}.cmos.bin`;
  }

  getDefaultCmosPath() {
    let cmos = this.getCmosName();
    return `cmos/${cmos}/cmos.bin`;
  }

  getOs() {
    return this.configParams['rom_set'];
  }

  /**
   * Get ROMS required for machine
   * @returns Dictionary of (FS path : URL) mappings
   */
  getRomUrls() {
    let romSet = this.configParams['rom_set'];
    let romUrls = {};
    for (let path of rom_list) {
      if (path.startsWith(romSet + '/')) {
        romUrls['roms/'+path] = ROM_BASE + path;
        break;
      }
    }
    if (romUrls.length == 0) {
      console.warn("Did not find ROM path for " + romSet);
    }
    if (this.configParams['support_rom'])
      romUrls['roms/arcrom_ext'] = ROM_BASE + 'arcrom_ext';
    return romUrls;
  }

  getConfigFile() {
    let c = this.configParams;
    let fpaEnabled = c['fpa_enabled'] ? 1 : 0;
    let supportRom = c['support_rom'] ? 1 : 0;
    return `
  machine = ${c['machine']}
  disc_name_0 = ${c['disc']}
  disc_name_1 = 
  disc_name_2 = 
  disc_name_3 = 
  mem_size = ${c['mem_size']}
  cpu_type = ${c['cpu_type']}
  memc_type = ${c['memc_type']}
  fpa = ${fpaEnabled}
  fpu_type = ${c['fpa_type']}
  display_mode = 0
  double_scan = 1
  video_scale = 1
  video_fullscreen_scale = 0
  video_linear_filtering = 0
  fdc_type = ${c['fdc_type']}
  st506_present = 1
  rom_set = ${c['rom_set']}
  monitor_type = multisync
  joystick_if = none
  unique_id = -490017344
  hd4_fn = 
  hd4_sectors = 63
  hd4_heads = 16
  hd4_cylinders = 100
  hd5_fn = 
  hd5_sectors = 63
  hd5_heads = 16
  hd5_cylinders = 100
  renderer_driver = auto
  podule_0 = arculator_rom
  podule_1 = 
  podule_2 = 
  podule_3 = 
  5th_column_fn = 
  support_rom_enabled = ${supportRom}
  
  [Joysticks]
  joystick_0_nr = 0
  joystick_1_nr = 0
  `;
  }

}

// TODO auto-generate this at build time
rom_list = [
  'arthur030/ROM030',
  'arthur120/ROM120',
  'riscos200/ROM200',
  'riscos201/ROM201',
  'riscos300/ROM300',
  'riscos310/ROM310',
  'riscos311/ros311',
  'riscos319/ROM319',
  'arthur120_a500/A500_Arthur_ROM.rom',
  'riscos200_a500/ROM200.A500Build',
  'riscos310_a500/a500_riscos310',
  'A4 5th Column.rom',
  'arcrom_ext'
];


function arrayBufferToBase64(buffer) {
  var binary = '';
  var bytes = [].slice.call(new Uint8Array(buffer));
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return window.btoa(binary);
};

function populateMachinePresets() {
  let list = document.getElementById('machine-list');
  list.innerHTML = '';
  for (const [presetId, builderFn] of Object.entries(presetMachines)) {
    let li = document.createElement('li');
    let builder = builderFn();
    li.textContent = builder.configName;
    li.setAttribute('machine-id', presetId);
    if (presetId == machinePreset)
      li.classList.add('selected');
    list.appendChild(li);
  }

}

function downloadHostFSfile(path) {
  let f = FS.analyzePath('/hostfs/' + path);
  if (!f.exists) {
    console.error("path not found: " + path);
    return
  }
  var a = document.createElement("a");
  a.href = window.URL.createObjectURL(new Blob([f.object.contents.buffer], {type: "application/octet-stream"}));
  a.download = baseName(path);
  a.click(); 
}

function previewMachine(e) {
  if (!e.target.nodeName == 'LI' || !e.target.hasAttribute('machine-id'))
    return;
  let liEl = e.target;
  let machineId = liEl.getAttribute('machine-id');
  let pv = document.getElementById('machine-preview');
  document.querySelector('#machine-list .selected').classList.remove('selected');
  liEl.classList.add('selected');
  
  let builder = presetMachines[machineId]();
  let machineType = builder.getMachine()
  pv.querySelector('h3').textContent = builder.configName;
  pv.querySelector('.cpu').textContent = CPU_DESCRIPTIONS[builder.getCpu()];
  pv.querySelector('.os').textContent = OS_NAMES[builder.getRom()];
  pv.querySelector('.memory').textContent = MEM_SIZE_NAMES[builder.getMemory()];
  pv.querySelector('.release-date').textContent = machineInfo[machineType].released;
  pv.querySelector('.price').textContent = machineInfo[machineType].price;
}

function bootSelected() {
  let presetId = document.querySelector('#machine-list .selected').getAttribute('machine-id');
  machinePreset = presetId;
  changeMachine(machinePreset);
  closeModal('machine-picker');
}

document.ondragenter = function(e) {
  console.log('dragenter', e);
  //e.preventDefault();
}

document.ondragleave = function(e) {
  console.log('dragleave', e);
  //e.preventDefault();
}

document.ondragend = function(e) {
  console.log('dragend', e);
}

document.ondragover = e => e.preventDefault();

document.ondrop = function(ev) {
  console.log('drop', ev);
  ev.preventDefault();
  if (ev.dataTransfer.items) {
    for (var i = 0; i < ev.dataTransfer.items.length; i++) {
      if (ev.dataTransfer.items[i].kind === 'file') {
        var file = ev.dataTransfer.items[i].getAsFile();
        console.log('... file[' + i + '].name = ' + file.name, file);
        loadSoftware(file.name, file).then(() => console.log('done loading file'));
      }
    }
  } 
}
populateMachinePresets();

async function unpackNsparkToHostFs(blob, dst='/') {
  let buf = await blob.arrayBuffer();
  let archive = new NSpark(buf);
  for await (const item of archive.unpack()) {
      console.log(item);
      let data = new Uint8Array(item.buf)
      putDataAtPath(data, '/hostfs' + dst + item.path, item.timestamp);
  }
}

async function unpackRiscOsZipToHostfs(blob, dst='/') {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  let zip = new JSUnzip();
  zip.registerExtension(ZIP_EXT_ACORN, parseRiscOsZipField);
  zip.open(data);
  console.log(zip.files);
  for (const fileName in zip.files) {
    if (fileName.endsWith('/'))
      continue;
    let hostFsPath = getHostFSPathForZipEntry(fileName, zip.files[fileName]);
    let result = zip.readBinary(fileName);
    if (!result.status) {
      console.error("failed to extract file: " + fileName, result);
    } else {
      console.log('creating file at', hostFsPath);
      putDataAtPath(result.data, '/hostfs' + hostFsPath);
    }
  }
}

async function loadDiscFromZip(filename, blob, insert=true) {
  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  let unzip = new JSUnzip();
  unzip.open(data);
  let zipDiscFile = null;
  for (const filename in unzip.files) {
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
  let result = unzip.readBinary(zipDiscFile);
  if (!result.status) {
    console.error("failed to extract file: " + result.error)
  }
  data = result.data;

  if (zipDiscFile.indexOf('/') >= 0) 
    zipDiscFile = baseName(zipDiscFile);
  console.log('loadDiscFromZip', data);
  blob = new Blob([data]);
  await loadDisc(zipDiscFile, blob, insert);
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
  if (insert)
    ccall('arc_disc_change', null, ['number', 'string'], [0, '/' + currentDiscFile]);
  return currentDiscFile;
}


function replaceExtWithFileType(filename, ext, filetype) {
  return filename.substr(0, filename.length - ext.length) + ',' + filetype.toString(16).padStart(3, '0')
}

function convertDotExtToHostfsExt(filename) {
  for (const [ext, filetype] of Object.entries(ROS_FileType_Map)) {
    if (filename.toLowerCase().endsWith(ext)) {
      let newFilename = replaceExtWithFileType(filename, ext, filetype);
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

async function loadSoftware(filename, blob) {
  let filetype = await identifyFileType(filename, 0, blob);
  console.log('filetype', filetype.desc);
  if ('loadDisc' in filetype) {
    console.log('load disc', filetype.loadDisc);
    await filetype.loadDisc(filename, blob, true);
  } else if ('unpackFn' in filetype) {
    console.log('unpack', filetype.unpackFn);
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
  let discFilename = baseName(url);
  await loadSoftware(discFilename, blob);
  return discFilename;
}



const ROS_FileType_Map = {
  '.zip': 0xddc,
  '.arc': 0x3fb,
  '.txt': 0xfff,
  '.bas': 0xffb,
  '.jfd': 0xfce
}

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

const RE_COMMA_EXT = /,[a-f0-9]{3}$/i;

async function identifyDiscImage(filename, data) {

}

async function identifyZipFile(filename, size, blob) {
  console.log('testing zip');
  let header = await blob.slice(0,2).text();
  if (header != 'PK') {
    console.warn("No PK header");
    return FileTypes.UNKNOWN;
  }

  let buf = await blob.arrayBuffer();
  let data = new Uint8Array(buf);
  let zip = new JSUnzip();
  zip.registerExtension(ZIP_EXT_ACORN, parseRiscOsZipField);
  zip.open(data);
  if (zip.isRiscOs) {
    console.log('RISC OS ZIP archive');
    return FileTypes.RISCOS_ZIP_ARCHIVE;
  }
  let numDiskImages = 0;
  let numCommaExts = 0;
  for (const filename in zip.files) {
    if (isDiscImageFilename(filename)) 
      numDiskImages++;
    if (filename.match(RE_COMMA_EXT))
      numCommaExts++;
    console.log(filename);
  }
  if (numDiskImages == 1) {
    return FileTypes.DISC_IMAGE_ZIPPED;
  } else if (numDiskImages > 1) {
    return FileTypes.DISC_IMAGE_MULTI_ZIPPED;
  } else if (numCommaExts > 1) {
    return FileTypes.ZIP_WITH_COMMA_FILETYPES;
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


function fullscreen() {
  //tryCapture();
  document.getElementById('display-container').requestFullscreen();
  if ('keyboard' in navigator) {
    navigator.keyboard.lock().then(() => console.log('keyboard locked'));
  }
}

document.getElementById('display-container').addEventListener('fullscreenchange', function(e) {
  console.log('fullscreen', document.fullscreenElement);
  let el = document.getElementById('display-container');
  if (el == document.fullscreenElement) {
    el.classList.add('fullscreen');
    tryCapture();
  } else {
    el.classList.remove('fullscreen');
  }
});