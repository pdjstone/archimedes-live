/**
 * Launches the BASIC editor's programs. The text is saved to HostFS, and a
 * !Boot (a Command file, so it's *Exec'd) loads and runs it with BASIC -chain.
 * That numbers programs without line numbers, counting blank lines, so
 * 'at line 30' is the editor's third line.
 */
import { putHostfsFile, createHostfsBootFile, FILETYPE_COMMAND, FILETYPE_BASIC_TEXT } from './hostfs.js'
import { addSwiHook, readString } from './swi-hook.js'
import { arc_fast_forward } from './fast-forward.js'

const OS_CLI = 0x05;
const PROG_NAME = 'BasicProg';
// The * command that starts the program
const CHAIN = `BASIC -chain HostFS:$.${PROG_NAME}`;
// Give up fast-forwarding by then, if the program hasn't started. The slowest
// hard boot (A540) takes about 11 s of emulated time
const START_TIMEOUT_MS = 15000;

/** Write the files that run prog at the next boot */
export function putBasicProgram(prog) {
  let lines = prog.split(/\r\n?|\n/);
  let used = lines.filter(line => line.trim());
  // A blank line makes BASIC renumber a program, so a numbered one can't have any
  if (used.every(line => /^\s*\d/.test(line)))
    lines = used;
  // Tabs are only allowed in strings, and the last line must end with a newline
  let text = lines.map(line => line.replace(/"[^"]*"?|\t/g, s => s === '\t' ? ' ' : s)).join('\n') + '\n';
  putHostfsFile(PROG_NAME, text, FILETYPE_BASIC_TEXT);
  createHostfsBootFile(`*${CHAIN}\n`, FILETYPE_COMMAND);
}

let removeHook = null;

/**
 * Fast-forward from a reset until the program starts. The emulator only looks
 * at the end point between slices, so up to 500 ms of emulated time
 * (MAX_TICKS_PER_FRAME) of the program can be skipped.
 */
export function skipToProgram(getEmulationMs) {
  cancelSkipToProgram();
  removeHook = addSwiHook(OS_CLI, regs => {
    let command = readString(regs[0]);
    if (!command.includes(CHAIN))
      return;
    cancelSkipToProgram();
    let now = Number(getEmulationMs()); // a BigInt
    if (now < START_TIMEOUT_MS)
      arc_fast_forward(Math.max(now, 1), {quiet: true}); // 0 would mean no fast-forward
  });
  arc_fast_forward(START_TIMEOUT_MS, {quiet: true});
}

/** Something else now says how far to fast-forward */
export function cancelSkipToProgram() {
  removeHook?.();
  removeHook = null;
}
