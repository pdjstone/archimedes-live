/**
 * Builds the Archimedes extension ROM (roms/arcrom_ext) from RISC OS module
 * files, so a machine's support ROM holds only the modules it asks for
 * (getSupportModules in shared/machines.js).
 *
 * A port of build_rom() in arculator-wasm/scripts/make_extnrom.py, which
 * builds the native build's ROM; `make check` tests they give the same bytes.
 * The layout follows extnrom_load() in ArcEm's arch/extnrom.c:
 *
 *   0x00  Extended expansion card identity (8 bytes, product type 0x0087)
 *   0x08  Interrupt status pointers (8 zero bytes)
 *   0x10  Chunk directory: one 8-byte entry per chunk, then a zero word
 *         - a device description chunk (OS identity byte 0xF5)
 *         - one RISC OS module chunk (OS identity byte 0x81) per module
 *   ....  Description string, then each module preceded by the
 *         undocumented size prefix word (module size + 4)
 *   end   16-byte extension ROM footer: ROM size, checksum, "ExtnROM0"
 *
 * The checksum is the 32-bit sum of every word except the last three.
 */

import { latin1Bytes } from '../shared/latin1.js'

const PRODUCT_TYPE_EXTENSION_ROM = 0x0087;
const MANUFACTURER_CODE = 0x0000;
const COUNTRY_CODE = 0x00;
const OS_ID_BYTE_RISCOS_MODULE = 0x81;
const OS_ID_BYTE_DEVICE_DESCR = 0xF5;
const MAXIMUM_CHUNK_SIZE = 0xFFFFFF;
// All Arculator loads into rom_arcrom (rom_load_arc_support_extrom)
export const EXTNROM_MAX_SIZE = 0x10000;

const roundUp = (x, n) => (x + n - 1) & ~(n - 1);

/**
 * @param {Uint8Array[]} modules the module files, in the order they go in the ROM
 * @returns {Uint8Array} the ROM image, a multiple of 64K
 */
export function buildExtnRom(modules, description = 'ArcEm Support') {
  if (!modules.length)
    throw new Error('extension ROM: no modules given');
  for (let m of modules) {
    if (m.length > MAXIMUM_CHUNK_SIZE)
      throw new Error('extension ROM: module too large for a chunk directory entry');
  }
  let descr = latin1Bytes(description + '\0');

  let chunks = [{osId: OS_ID_BYTE_DEVICE_DESCR, data: descr, prefix: false},
    ...modules.map(data => ({osId: OS_ID_BYTE_RISCOS_MODULE, data, prefix: true}))];

  // Header (16 bytes), chunk directory, terminator word
  let pos = 16 + 8 * chunks.length + 4;
  for (let c of chunks) {
    if (c.prefix)
      pos += 4;
    c.offset = pos;
    pos += roundUp(c.data.length, 4);
  }

  let romSize = roundUp(pos + 16, 0x10000);
  let rom = new Uint8Array(romSize);
  let v = new DataView(rom.buffer);

  // Extended expansion card identity: Acorn conformant, no interrupts;
  // flags 0x03 = 8-bit wide, interrupt status pointers and chunk directory
  // present. The interrupt status pointers are left as zero
  v.setUint32(0, (0x00 | (0x03 << 8) | (0x00 << 16) |
    ((PRODUCT_TYPE_EXTENSION_ROM & 0xFF) << 24)) >>> 0, true);
  v.setUint32(4, ((PRODUCT_TYPE_EXTENSION_ROM >> 8) |
    (MANUFACTURER_CODE << 8) | (COUNTRY_CODE << 24)) >>> 0, true);

  let entry = 16;
  for (let c of chunks) {
    v.setUint32(entry, (c.osId | (c.data.length << 8)) >>> 0, true);
    v.setUint32(entry + 4, c.offset, true);
    entry += 8;
    if (c.prefix) // the size prefix includes the size word itself
      v.setUint32(c.offset - 4, c.data.length + 4, true);
    rom.set(c.data, c.offset);
  }
  // The chunk directory terminator is already zero

  // Footer: ROM size, checksum, "ExtnROM0"
  v.setUint32(romSize - 16, romSize, true);
  let sum = 0;
  for (let i = 0; i < romSize - 12; i += 4)
    sum = (sum + v.getUint32(i, true)) >>> 0;
  v.setUint32(romSize - 12, sum, true);
  rom.set(latin1Bytes('ExtnROM0'), romSize - 8);
  return rom;
}
