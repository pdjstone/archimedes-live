/**
 * CMOS RAM images for Arculator, built from the configured settings.
 *
 * Arculator's cmos.bin is the PCF8583's 256 bytes of RAM by physical address.
 * RISC OS addresses it by logical location (OS_Byte 161/162, and the PRM's
 * CMOS allocation table, Vol 5a ch. 104):
 *   logical &00-&BF are physical &40-&FF
 *   logical &C0-&EF are physical &10-&3F
 *   physical &00-&0F are the clock registers, which the emulator fills in when
 *   it loads the file, so they're left 0 here.
 * RISC OS 3 keeps a checksum at logical &EF: the low byte of 1 + the sum of
 * logical &00-&EE. If it's wrong, RISC OS 3 ignores the settings. RISC OS 2 and
 * Arthur have no checksum.
 *
 * These are the settings of the blobs this file used to hold (Arculator's
 * defaults for each OS). The RISC OS 3 ones were the same for old and new
 * machines apart from the time. Meanings are from the PRM's tables for RISC OS
 * 3.1 and 2 (Memory Management chapter); the RISC OS 3 ones match what *Status
 * reports on RISC OS 3.11. Some settings are stored offset (e.g. Baud and the
 * SoundDefault voice are stored minus 1), so the comments give what *Status
 * shows.
 */

// Logical CMOS locations, in decimal as in the PRM's table (its names, RISC OS 3.1
// meanings unless noted)
export const CMOS = Object.freeze({
  NET_FS_STATION:     1,   // Econet file server station
  NET_PS_STATION:     3,   // Econet printer server station
  FILESYSTEM:         5,   // FileSystem number
  SCREEN:             10,  // TV; on RISC OS 2 bits 0-3 are the low bits of the configured mode
  KEYBOARD:           11,  // Caps mode (bits 3-5), NoDir (bit 6)
  KEY_DELAY:          12,
  KEY_REPEAT:         13,
  PRINTER_IGNORE:     14,  // Ignore character
  PRINTER:            15,  // Print, Baud, Ignore/NoIgnore
  MISC_FLAGS:         16,  // Data, Boot, Scroll, Loud
  NETFILER:           17,
  FILESWITCH:         28,  // Truncate etc.
  YEAR_LO:            128, // year % 100
  YEAR_HI:            129, // year / 100
  DUMP_FORMAT:        132,
  MONITOR:            133, // Sync, MonitorType; on RISC OS 2 bit 1 is mode bit 4
  FONT_SIZE:          134, // FontSize in 4K
  ADFS_DRIVES:        135, // Floppies, IDEDiscs
  ADFS_STEP:          136,
  ADFS_BUFFERS:       137,
  CDROMFS:            138,
  TIMEZONE:           139,
  DESKTOP_FEATURES:   140, // PrinterDP state on RISC OS 2
  SELECTED_PRINTER:   141,
  RMA_SIZE:           146, // in pages
  SPRITE_SIZE:        147, // in pages
  SOUND_DEFAULT:      148,
  LANGUAGE:           185, // ROM module number
  COUNTRY:            186,
  MOUSE_STEP:         194,
  SYSTEM_FLAGS:       195, // last reset type, auto Mode/WimpMode, cache...
  MODE:               196, // Mode and WimpMode; RISC OS 2 stores WimpMode EOR &0C
  WIMP_FLAGS:         197,
  DESKTOP_STATE:      198, // Filer options
  CHECKSUM:           239, // RISC OS 3
});

// Bits
const MISC_FLAGS_BOOT = 0x10;
const SYSTEM_FLAGS_CMOS_RESET = 0x04;
const SYSTEM_FLAGS_MODE_AUTO = 0x10;

export const FS_ADFS = 8;
export const FS_HOSTFS = 153;

// Logical location -> value. Everything else is 0.
const COMMON = {
  [CMOS.NET_FS_STATION]:   0xfe,
  [CMOS.NET_PS_STATION]:   0xeb,
  [CMOS.FILESYSTEM]:       FS_ADFS,
  [CMOS.SCREEN]:           0x10,  // TV 0,1 (bit 4: interlace)
  [CMOS.KEY_DELAY]:        0x20,  // Delay 32
  [CMOS.KEY_REPEAT]:       0x08,  // Repeat 8
  [CMOS.PRINTER_IGNORE]:   0x0a,  // Ignore 10
  [CMOS.PRINTER]:          0x2c,  // Print 1, Baud 4, Ignore
  [CMOS.MISC_FLAGS]:       0x80,  // Data 4, NoBoot, Quiet, Scroll
  [CMOS.ADFS_DRIVES]:      0x01,  // Floppies 1
  [CMOS.ADFS_STEP]:        0xff,  // Step 3 for every drive
  [CMOS.SOUND_DEFAULT]:    0xf0,  // SoundDefault 1 7 1 (speaker on, loudness 7, voice 1)
  [CMOS.COUNTRY]:          0x01,  // UK
};

const RISC_OS_2 = {
  ...COMMON,
  [CMOS.KEYBOARD]:         0x60,  // NoDir, Caps
  [CMOS.MONITOR]:          0x01,  // Sync 1, MonitorType 0, mode bit 4 clear
  [CMOS.FONT_SIZE]:        0x06,  // 24K
  // Not documented for RISC OS 2
  [CMOS.CDROMFS]:          0x08,
  [CMOS.TIMEZONE]:         0xff,
  [CMOS.SELECTED_PRINTER]: 0xff,
  [CMOS.DESKTOP_FEATURES]: 0xff,  // PrinterDP state
  [CMOS.RMA_SIZE]:         0x02,
  [CMOS.SPRITE_SIZE]:      0x01,
  [CMOS.LANGUAGE]:         0x03,
  // MODE is 0: WimpMode 12
};

const SETTINGS = {
  'arthur': RISC_OS_2,
  'riscos2': {
    ...RISC_OS_2,
    [CMOS.NETFILER]:       0x02,  // library $.ArthurLib
    [CMOS.DUMP_FORMAT]:    0x04,  // DumpFormat 4
    [CMOS.ADFS_BUFFERS]:   0x01,
  },
  'riscos3': {
    ...COMMON,
    [CMOS.KEYBOARD]:       0x50,  // NoDir, NoCaps
    [CMOS.NETFILER]:       0x02,  // library $.ArthurLib
    [CMOS.FILESWITCH]:     0x01,  // Truncate on
    [CMOS.DUMP_FORMAT]:    0x04,  // DumpFormat 4
    [CMOS.MONITOR]:        0xfd,  // MonitorType Auto, Sync Auto
    [CMOS.FONT_SIZE]:      0x08,  // 32K
    [CMOS.ADFS_BUFFERS]:   0x01,  // *Status shows ADFSbuffers 8
    [CMOS.LANGUAGE]:       0x0a,  // Desktop
    [CMOS.MOUSE_STEP]:     0x03,
    [CMOS.SYSTEM_FLAGS]:   SYSTEM_FLAGS_MODE_AUTO | SYSTEM_FLAGS_CMOS_RESET,
    [CMOS.WIMP_FLAGS]:     0x6f,  // 111
    [CMOS.DESKTOP_STATE]:  0x40,  // Filer verbose
  },
};

// The year each ROM was built (from its MOS Utilities date), for the CMOS year,
// which the clock's date is in: the clock chip itself has no year
const ROM_YEARS = {
  arthur030: 1987, arthur120: 1987,
  riscos200: 1988, riscos201: 1990,
  riscos300: 1991, riscos310: 1992, riscos311: 1992, riscos319: 1993,
};

export function romYear(romSet) {
  return ROM_YEARS[romSet.replace(/_a500$/, '')];
}

const BOOT_FILESYSTEMS = {adfs: FS_ADFS, hostfs: FS_HOSTFS};

// 'riscos3_old' and 'riscos3_new' (MachineConfig.getCmosName()) are both RISC OS 3
function family(cmosName) {
  return cmosName.startsWith('riscos3') ? 'riscos3' : cmosName;
}

export function hasChecksum(cmosName) {
  return family(cmosName) == 'riscos3';
}

// Whether the OS can boot from bootFs ('adfs' or 'hostfs')
export function canBootFrom(cmosName, bootFs) {
  if (bootFs == 'hostfs')  // HostFS is in the extension ROM, which only RISC OS 3 loads
    return family(cmosName) == 'riscos3';
  return bootFs in BOOT_FILESYSTEMS && family(cmosName) in SETTINGS;
}

function physical(logical) {
  return logical < 0xc0 ? (logical + 0x40) & 0xff : logical - 0xb0;
}

/** Reads logical CMOS location `logical` from a 256-byte image */
export function readCmos(cmos, logical) {
  return cmos[physical(logical)];
}

/** Writes logical CMOS location `logical`; call updateChecksum after */
export function writeCmos(cmos, logical, value) {
  cmos[physical(logical)] = value & 0xff;
}

export function updateChecksum(cmos) {
  let sum = 1;
  for (let logical = 0; logical < CMOS.CHECKSUM; logical++)
    sum += readCmos(cmos, logical);
  writeCmos(cmos, CMOS.CHECKSUM, sum);
}

/**
 * Builds a cmos.bin for an OS ('arthur', 'riscos2', 'riscos3_old' or
 * 'riscos3_new', as from MachineConfig.getCmosName()).
 * bootFs is 'adfs' or 'hostfs' to configure Boot and FileSystem to it, so the
 * machine runs that filing system's !Boot at power-on; or null for NoBoot,
 * with FileSystem ADFS.
 * year (e.g. from romYear()) is the year the clock starts in; without it the
 * year is 0, which RISC OS shows as 1900.
 */
export function makeCmos(cmosName, {bootFs = null, year = null} = {}) {
  let settings = SETTINGS[family(cmosName)];
  if (!settings)
    throw new Error(`No CMOS settings for ${cmosName}`);
  if (bootFs && !canBootFrom(cmosName, bootFs))
    throw new Error(`${cmosName} can't boot from ${bootFs}`);

  let cmos = new Uint8Array(256);
  for (let [logical, value] of Object.entries(settings))
    writeCmos(cmos, Number(logical), value);
  if (year) {
    writeCmos(cmos, CMOS.YEAR_LO, year % 100);
    writeCmos(cmos, CMOS.YEAR_HI, Math.floor(year / 100));
  }
  if (bootFs) {
    writeCmos(cmos, CMOS.FILESYSTEM, BOOT_FILESYSTEMS[bootFs]);
    writeCmos(cmos, CMOS.MISC_FLAGS, readCmos(cmos, CMOS.MISC_FLAGS) | MISC_FLAGS_BOOT);
  }
  if (hasChecksum(cmosName))
    updateChecksum(cmos);
  return cmos;
}
