const ROM_BASE_PROD = 'https://files-archi.medes.live/roms/';
const ROM_BASE_DEV = 'emu/roms/';

let ROM_BASE = (document.domain == 'archi.medes.live') ? ROM_BASE_PROD : ROM_BASE_DEV;

// These constants match Arculator
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


let OS_NAMES = {
  'arthur030': 'Arthur 0.3',
  'arthur120': 'Arthur 1.2',
  'riscos311': 'RISC OS 3.11',
  'riscos201': 'RISC OS 2.01'
};
Object.freeze(OS_NAMES);

let machineInfo = {
  'a310': {name: 'Archimedes 310', released: 'July 1987', price: '£875'},
  'a410/1': {name: 'Archimedes 410/1', released: 'June 1989', price: '£999'},
  'a3000': {name: 'A3000', released: 'May 1989', price: '£649'},
  'a5000': {name: 'A5000', released: 'September 1991', price: '£999 (25 MHz) or £1,499 (33 MHz) including monitor'},
  'a3010': {name: 'A3010', released: 'September 1992', price: '£499'},
  'a3020': {name: 'A3020', released: 'September 1992', price: '£800 including monitor'},
  'a4': {name: 'A4', released: 'June 1992', price: '£1399'}
}
Object.freeze(machineInfo)

let CPU_DESCRIPTIONS = {};
CPU_DESCRIPTIONS[CPU_ARM2] = "ARM2 @ 8 MHz";
CPU_DESCRIPTIONS[CPU_ARM250] ="ARM250 @ 12 MHz";
CPU_DESCRIPTIONS[CPU_ARM3_25] = "ARM3 @ 25 MHz";
CPU_DESCRIPTIONS[CPU_ARM3_26] = "ARM3 @ 26 MHz";
CPU_DESCRIPTIONS[CPU_ARM3_33] = "ARM3 @ 33 MHz";
CPU_DESCRIPTIONS[CPU_ARM3_24] = "ARM3 @ 24 MHz";
Object.freeze(CPU_DESCRIPTIONS);


let MEM_SIZE_NAMES = {
  512: '512 KB',
  1024: '1 MB',
  2048: '2 MB',
  4096: '4 MB',
  8192: '8 MB'
};
Object.freeze(MEM_SIZE_NAMES);


// TODO auto-generate this at build time
var rom_list = [
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
Object.freeze(rom_list);


// Configurations available in the Machine Config dialog
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
    .memory(4096)
    .memc(MEMC_MEMC1A_12)
    .rom('riscos311'),
  /*'a4': () => new MachineConfigBuilder('a4', "A4 Laptop")
    .cpu(CPU_ARM3_24)
    .memory(2048)
    .memc(MEMC_MEMC1A_12)
    .rom('riscos311')
    .monitor('lcd')*/
};
Object.freeze(presetMachines);

function recommendMachinePreset(req) {
  
  let mem = 0;
  let os = 'riscos311';
  let cpu = null;

  if ('min-mem' in req) mem = req['min-mem'];
  if ('best-os' in req) os = req['best-os'];
  if ('best-cpu' in req) cpu = req['best-cpu'];

  if (cpu == 'arm2' || cpu == null) {
    if (os == 'arthur120' && mem <= 1024) return 'a310-arthur';
    if (os == 'riscos201' && mem <= 2048) return 'a310-ro2';
  }

  if (os == 'riscos311') {
    if ((cpu == null || cpu == 'arm2') && mem <= 2048)
      return 'a3000';
    if ((cpu == null || cpu == 'arm250') && mem <= 4096)
      return 'a3020';
    if (cpu == 'arm3' && mem <= 4096)
      return 'a5000';
  }
  let reqStr = JSON.stringify({mem:mem, os:os, cpu:cpu});
  console.error(`No machine recommendation for ${reqStr}`);
  return null;
}

const CLICK_ICON_BASIC = 'DQAKDd4gYiUgMTAyNA0AFCnImSAiV2ltcF9Jbml0aWFsaXNlIiwzMTAsJjRiNTM0MTU0LCIiDQAeCiFiJT0tMg0AKB/ImSAiV2ltcF9HZXRXaW5kb3dJbmZvIiwsYiUNADIN3iBtc2clIDIwDQA8E2ljb25ubyU9YiUhODgtMQ0ARgxtc2clITg9NA0AUA5tc2clITEyPS0yDQBaE21zZyUhMTY9aWNvbm5vJQ0AZCvImSAiV2ltcF9TZW5kTWVzc2FnZSIsNixtc2clLC0yLGljb25ubyUN/w==';

function getAutobootScript(softwareMeta) {
  if ('autoboot' in softwareMeta) {
    return softwareMeta['autoboot'];
  }
  
  if ('app-path' in softwareMeta) {
    let bootCmd = 'desktop filer_run ';
    if ('archive' in softwareMeta) { // will be unpacked to HostFS
      bootCmd += `HostFS:$.${softwareMeta['app-path']}\n`;
    } else if ('disc' in softwareMeta) {
      bootCmd += `ADFS::0.$.${softwareMeta['app-path']}\n`;
    } else{
      return null;
    }
    if (softwareMeta['click-icon']) { 
      console.log('auto-click iconbar icon'); 
      putDataAtPath(atob(CLICK_ICON_BASIC), '/hostfs/click,ffb');
      putDataAtPath(bootCmd + "filer_run HostFS:$.click\n", "/hostfs/deskboot,feb");
      bootCmd = 'desktop -file HostFS:$.deskboot';
    }
    return bootCmd;
  }
  
  return null;
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
    disc: '',
    autoboot: false,
    fast_forward: 0,
    sound_filter: 0,
    monitor_type: 'multisync'
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
    return this;
  }

  monitor(monitor) {
    this.params['monitor_type'] = monitor;
    return this;
  }

  fastForward(fastForward = 0) {
    this.params['fast_forward'] = fastForward;
  }

  soundFilter(soundFilter = 0) {
    this.params['sound_filter'] = soundFilter;
  }

  build() {
    return new MachineConfig(this.configName, this.params);
  }
}
  

class MachineConfig {
  constructor(configName, params) {
    this.configName = configName;
    this.configParams = params;
    this.autoboot = params.autoboot;
    this.fastForward = params.fast_forward;
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

  getCpuName() { // should match the 'best-cpu' field from software meta
    let cpuId = this.getProcessor();
    if (cpuId == CPU_ARM2) return 'arm2';
    if (cpuId == CPU_ARM250) return 'arm250';
    if (cpuId >= CPU_ARM3_20 && cpuId <= CPU_ARM3_35) return 'arm3';
    return null;
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
    if (this.configParams['machine'] == 'a4')
      romUrls['roms/A4 5th Column.rom'] = ROM_BASE + 'A4 5th Column.rom';
    return romUrls;
  }

  getArcConfigFile() {
    let soundFilter = this.configParams['sound_filter'];
    return `
sound_enable = 1
first_fullscreen = 0
stereo = 1
sound_gain = 0
sound_filter = ${soundFilter}
disc_noise_gain = 0
`;
  }

  getMachineConfigFile() {
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
  monitor_type = ${c['monitor_type']}
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
  

function putConfigFile(machineConfig) {
  let configName = machineConfig.getMachineType();
  let machineConfigFileData = machineConfig.getMachineConfigFile();
  let configPath = '/configs/' + configName + '.cfg';
  console.log('Creating machine config file at', configPath);
  //console.log(machineConfigFileData);
  putDataAtPath(machineConfigFileData, configPath);
  let arcCfgFileData = machineConfig.getArcConfigFile();
  console.log('Creating arc.cfg');
  //console.log(arcCfgFileData);
  putDataAtPath(arcCfgFileData, 'arc.cfg');
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


async function loadRoms(machineConfig) {
  let romUrls = machineConfig.getRomUrls();
  for (const [fsPath, romUrl] of Object.entries(romUrls)) {
   await putUrlAtPath(romUrl, fsPath);
  }
}
