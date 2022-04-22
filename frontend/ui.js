var statusElement = document.getElementById('status');
var progressElement = document.getElementById('progress');
var spinnerElement = document.getElementById('spinner');

var Module = {
  noInitialRun: true,
  onRuntimeInitialized: function() {
    console.log('runtime initialised');
    preload.then(() => {
      console.log('calling main...(' + fps + ',' + machinePreset + ')');
      callMain([fps.toString(), machinePreset]);
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

if (searchParams.has('ff')) {
  Module.postRun.push(function() {
    let ff_ms = parseInt(searchParams.get('ff'));
    console.log(`UI: postRun - fast forward to ${ff_ms} ms`);
    ccall('arc_fast_forward', null, ['number'], [ff_ms]);
  });
}

if (searchParams.has('autoboot')) {
  Module.preRun.push(function() {
    let autoboot = searchParams.get('autoboot');
    console.log('UI: preRun - create !boot:' + autoboot);
    putDataAtPath(autoboot, '/hostfs/!boot,feb');
  }); 
  autoboot = true;
} else if (searchParams.has('basic')) {
  let prog = searchParams.get('basic');

  Module.preRun.push(function() {
    console.log('UI: preRun - create !boot and prog');
    putDataAtPath(wrapProg(prog), '/hostfs/!boot,ffe');
  });
  Module.postRun.push(function() {
    //ccall('arc_fast_forward', null, ['number'], [6000]);
  });
  showEditor();
  document.getElementById('editor').value = prog;
  updateCharCount();
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


// Disc image extensions that Arculator handles (see loaders struct in disc.c)
let validDiscExts = ['.ssd','.dsd','.adf','.adl', '.fdi', '.apd', '.hfe'];


async function loadDisc(url, insert=true) {
    if (url == "") return;
    let response = await fetch(url, {mode:'cors'});
    let buf = await response.arrayBuffer();
    let data = new Uint8Array(buf);
    let discFilename = url.substr(url.lastIndexOf('/')+1);
    var preamble = new TextDecoder().decode(data.slice(0, 2));

    if (preamble == 'PK') {
      console.log("Extracting ZIP file to find disc image");
      let unzip = new JSUnzip();
      unzip.open(data);
      let zipDiscFile = null;
      for (const n in unzip.files) {
        for (let ext of validDiscExts) {
          if (n.toLowerCase().endsWith(ext))
            zipDiscFile = n;
        }
        if (zipDiscFile)
          break;
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
        zipDiscFile = zipDiscFile.substr(zipDiscFile.lastIndexOf('/')+1);
      discFilename = zipDiscFile;
      
    }
    if (currentDiscFile) {
      if (insert)
        ccall('arc_disc_eject', null, ['number'], [0]);
      FS.unlink(currentDiscFile);
    }
    currentDiscFile = discFilename;
    FS.createDataFile("/", currentDiscFile, data, true, true);
    if (insert)
      ccall('arc_disc_change', null, ['number', 'string'], [0, '/' + currentDiscFile]);
    return currentDiscFile;
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

function runProgram() {
  let prog = document.getElementById('editor').value;
  putDataAtPath(wrapProg(prog), '/hostfs/!boot,ffe');
  rerunProg();
}

KEY_ESCAPE = 27;
KEY_F1 = 112;

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
  if (event && (event.target.classList.contains('modal')  || event.target.classList.contains('modal-content')))
    document.getElementById(id).style.display = 'none';

}

function getBasicShareUrl() {
  let prog = document.getElementById('editor').value;
  return location.protocol + '//' + location.host + location.pathname + '?basic=' + encodeURIComponent(prog);
}

function showShareBox() {
  document.getElementById('share-box').style.display = 'block';
  document.getElementById('share-url').value = getBasicShareUrl();
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

function showEditor() {
  document.getElementById('editor-container').style.display = 'block';
  updateCharCount();
  setTimeout(() => {
    let editor = document.getElementById('editor');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, 20);
}

function updateCharCount() {
  let prog = document.getElementById('editor').value;
  document.getElementById('char-count').textContent = prog.length.toString() + ' characters';
}

function tryCapture() {
  if (document.pointerLockElement)
    return;
  document.getElementById('canvas').requestPointerLock();
}

document.addEventListener('pointerlockchange', lockChangeAlert, false);


function lockChangeAlert() {
  if(document.pointerLockElement === canvas) {
    console.log('The pointer lock status is now locked');
    sdl_enable_mouse_capture();
  } else {
    console.log('The pointer lock status is now unlocked');
    sdl_disable_mouse_capture();
  }
}


document.getElementById('editor').addEventListener('keypress', e => updateCharCount());

async function loadMachineConfig() {
  console.log('loading preset machine: ' + machinePreset);
  let builder = presetMachines[machinePreset]();

  if (searchParams.has('disc')) {
      let discUrl = searchParams.get('disc')
      console.log('UI: load disc URL ' + discUrl);
      let diskFile = await loadDisc(discUrl, false);
      builder.disc(diskFile);
  }
  let machineConfig = builder.build();
  putConfigFile(machineConfig);
  putCmosFile(machineConfig);
  await loadRoms(machineConfig);
  try {
    FS.mkdir('/hostfs');
  } catch (e) {
    console.log('hostfs dir already exists');
  }
  
  console.log('machine config loaded');
  return machineConfig;
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
  let configName = machineConfig.configName;
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
  let cmosData = atob(DEFAULT_CMOS[cmosName]);
  if (autoboot) { 
    if (CMOS_BOOT_HOSTFS.hasOwnProperty(cmosName)) {
      console.log('using autoboot CMOS for ' +cmosName);
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
  'a310':  () => new MachineConfigBuilder('a310')
    .cpu(CPU_ARM2)
    .memory(1024)
    .memc(MEMC_MEMC1)
    .rom('arthur120'),
  'a3000': () => new MachineConfigBuilder('a3000')
    .cpu(CPU_ARM2)
    .memory(2048)
    .memc(MEMC_MEMC1A_8)
    .fdc(FDC_WD1770)
    .rom('riscos311'),
  'a5000': () => new MachineConfigBuilder('a5000')
    .cpu(CPU_ARM3_25)
    .memory(4096)
    .memc(MEMC_MEMC1A_12)
    .rom('riscos311'),
  'a3020': () => new MachineConfigBuilder('a3020')
    .cpu(CPU_ARM250)
    .memory(2048)
    .memc(MEMC_MEMC1A_12)
    .rom('riscos311')
}

let machineNames = {
  'a310': 'Archimedes 310',
  'a410/1': 'Archimedes 410/1',
  'a3000': 'A3000',
  'a540': 'Archimedes 540',
  'a5000': 'A5000',
  'a3010': 'A3010',
  'a3020': 'A3020',
  'a5000a': 'A5000a'
}

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
    disc: ''
  }

  constructor(machine, configName) {
    if (machine)
      this.params['machine'] = machine;
    if (!configName)
      configName = machine;
    this.configName = configName;  
  }

  memory(memSize) {
    this.params['mem_size'] = memSize;
    return this;
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

function putDataAtPath(data, path) {
  mkdirsForFile(path);
  try {
    FS.stat(path);
    console.log('Remove existing file ' + path);
    FS.unlink(path);
  } catch (e) {
    
  }
  FS.createDataFile(dirName(path), baseName(path), data, true, true);
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
  }

  getMachineName() {
    return machineNames[this.configParams['machine']];
  }

  getMachineType() {
    return this.configParams['machine'];
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
    return `cmos/${this.configName}.${cmos}.cmos.bin`;
  }

  getDefaultCmosPath() {
    let cmos = this.getCmosName();
    return `cmos/${cmos}/cmos.bin`;
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
        romUrls['roms/'+path] = 'emu/roms/' + path;
        break;
      }
    }
    if (romUrls.length == 0) {
      console.warn("Did not find ROM path for " + romSet);
    }
    if (this.configParams['support_rom'])
      romUrls['roms/arcrom_ext'] = 'emu/roms/arcrom_ext';
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
  'arthur120/ROM120',
  'riscos311/ros311',
  'arthur120_a500/A500_Arthur_ROM.rom',
  'riscos300/ROM300',
  'riscos201/ROM201',
  'riscos200/ROM200',
  'A4 5th Column.rom',
  'riscos310_a500/a500_riscos310',
  'arthur030/ROM030',
  'arcrom_ext',
  'riscos319/ROM319',
  'riscos200_a500/ROM200.A500Build',
  'riscos310/ROM310',
];


function arrayBufferToBase64(buffer) {
  var binary = '';
  var bytes = [].slice.call(new Uint8Array(buffer));
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return window.btoa(binary);
};

