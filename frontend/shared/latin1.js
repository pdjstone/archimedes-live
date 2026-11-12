/*Converts between JS strings and bytes, one character per byte, as RISC OS
  text is (and the four-character tags in file formats). Not
  TextDecoder('latin1'), which browsers treat as Windows-1252, so &80-&9F
  would come out as other characters; nor TextEncoder, which only gives UTF-8*/

/** The string with one character per byte */
export function latin1String(bytes) {
  let s = '';
  // In chunks, as spreading a large array would pass too many arguments
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

/** A byte per character. Characters above &FF keep only their low byte */
export function latin1Bytes(s) {
  return Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
}
