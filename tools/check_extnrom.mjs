// Checks that frontend/worker/extnrom.js builds the same support ROM as
// arculator-wasm/scripts/make_extnrom.py: from the modules the submodule puts
// in roms/arcrom_ext, in the same order, it must give the same bytes.
// Run by `make check`: node tools/check_extnrom.mjs ROM MODULE...
import { readFileSync } from 'node:fs';
import { buildExtnRom } from '../frontend/worker/extnrom.js';

const [romPath, ...modulePaths] = process.argv.slice(2);
const expected = readFileSync(romPath);
const built = buildExtnRom(modulePaths.map(p => new Uint8Array(readFileSync(p))));
if (Buffer.compare(Buffer.from(built), expected) != 0) {
  let i = built.findIndex((b, i) => b != expected[i]);
  console.error(`extnrom.js and ${romPath} differ: ${built.length} and ${expected.length} bytes, first at 0x${i.toString(16)}`);
  process.exit(1);
}
console.log(`extnrom.js matches ${romPath} (${built.length} bytes, ${modulePaths.length} modules)`);
