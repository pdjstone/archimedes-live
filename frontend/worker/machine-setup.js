/**
 * Puts a machine configuration (shared/machines.js) into the emulator's FS:
 * its config files, CMOS and ROMs, and the boot commands for software.
 */

import { putDataAtPath, putUrlAtPath } from './fsutil.js'
import { CMOS_BOOT_HOSTFS, DEFAULT_CMOS } from './cmos.js'
import { roDirname } from './hostfs.js'
import { OS_NAMES } from '../shared/machines.js'
import { emit } from '../shared/rpc.js'
import { Notice, NoticeError, reasonFor } from '../shared/notices.js'

const CLICK_ICON_BASIC = 'DQAKDd4gYiUgMTAyNA0AFCnImSAiV2ltcF9Jbml0aWFsaXNlIiwzMTAsJjRiNTM0MTU0LCIiDQAeCiFiJT0tMg0AKB/ImSAiV2ltcF9HZXRXaW5kb3dJbmZvIiwsYiUNADIN3iBtc2clIDIwDQA8E2ljb25ubyU9YiUhODgtMQ0ARgxtc2clITg9NA0AUA5tc2clITEyPS0yDQBaE21zZyUhMTY9aWNvbm5vJQ0AZCvImSAiV2ltcF9TZW5kTWVzc2FnZSIsNixtc2clLC0yLGljb25ubyUN/w==';

// `software` is the catalogue, for looking up softwareMeta's dependencies
export function getAutobootScript(softwareMeta, software) {

  let bootCmd = '';
  if ('depends' in softwareMeta) {
    for (let dep of softwareMeta['depends']) {
      console.log(`Getting autoboot script for ${softwareMeta['id']}'s dependency ${dep}`);
      bootCmd += getAutobootScript(software[dep], software);
    }
  }
  if ('autoboot' in softwareMeta) {
    bootCmd += softwareMeta['autoboot'] + '\n';
  }
  if ('app-path' in softwareMeta) {
    let appPath;
    if ('archive' in softwareMeta) { // will be unpacked to HostFS
      appPath = `HostFS:$.${softwareMeta['app-path']}`;
    } else if ('disc' in softwareMeta) {
      appPath = `ADFS::0.$.${softwareMeta['app-path']}`;
    } else {
      return '';
    }
    let dirPath = roDirname(appPath);
    bootCmd += `filer_run ${dirPath}\nfiler_run ${appPath}\n`;
    if (softwareMeta['click-icon']) { 
      console.log('auto-click iconbar icon'); 
      putDataAtPath(Uint8Array.fromBase64(CLICK_ICON_BASIC), '/hostfs/click_icon,ffb');
      bootCmd += "filer_run HostFS:$.click_icon\n";
    }
  }
  
  return bootCmd;
}

export function putConfigFile(machineConfig) {
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

export function putCmosFile(machineConfig) {
  let cmosPath = machineConfig.getMachineCmosPath();
  let cmosName = machineConfig.getCmosName();
  console.log(`cmos path=${cmosPath} cmos name=${cmosName}`)
  let cmosData = Uint8Array.fromBase64(DEFAULT_CMOS[cmosName]);
  if (machineConfig.autoboot) { 
    if (CMOS_BOOT_HOSTFS.hasOwnProperty(cmosName)) {
      console.log('using autoboot CMOS for ' + cmosName);
      cmosData = Uint8Array.fromBase64(CMOS_BOOT_HOSTFS[cmosName]);
    }  else {
      console.warn("No autoboot CMOS for " + cmosName);
      emit('notice', {id: Notice.AUTOBOOT_NEEDS_RISC_OS_3, params: {
        machine: machineConfig.getMachineName(), os: OS_NAMES[machineConfig.getOs()] ?? machineConfig.getOs()}});
    }
  }
  //if (machineConfig.getMachineType() == 'a5000')
  //  cmosData = Uint8Array.fromBase64(CMOS_A5000);

  putDataAtPath(cmosData, cmosPath);
}


export async function loadRoms(machineConfig) {
  let romUrls = machineConfig.getRomUrls();
  try {
    for (const [fsPath, romUrl] of Object.entries(romUrls)) {
      await putUrlAtPath(romUrl, fsPath);
    }
  } catch (e) {
    throw new NoticeError(Notice.ROMS_FAILED, {machine: machineConfig.getMachineName(), reason: reasonFor(e)});
  }
}
