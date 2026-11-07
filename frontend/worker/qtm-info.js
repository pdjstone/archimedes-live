/**
 * What music is playing, for programs that play it with the QTMTracker
 * module (QTM). Watches for SWI QTM_Load (see swi-hook.js) and reads the
 * song's header from emulated memory as it's loaded, so it works while a demo
 * has taken over the machine. Posts {type: 'musicInfo', info} to the page
 * (window.arcMusicInfo in ui.js), with info null once the song is cleared.
 *
 * The song name, author and format follow QTM v1.49c, so they're what
 * *QTMInfo and QTM_Info report: the format detection and 'author detector'
 * are ported from its code (see qtmAuthor). QTM's documentation describes
 * the header (Documents/Technical/FileFormat). A song loaded from a file
 * isn't in memory when QTM_Load is called, so for that only the file name is
 * known.
 */
import { addSwiHook, readMemory, readString } from './swi-hook.js'
import { emit } from '../shared/rpc.js'

const QTM_LOAD = 0x47E40;
const QTM_CLEAR = 0x47E44;

// Format tags at offset 1080: [name, QTM_Info's origin value, channels]
const TAGS = {
  'M.K.': ['ProTracker', 2, 4],
  'FLT4': ['StarTrekker', 3, 4],
  'FLT8': ['StarTrekker', 3, 8],
  '4CHN': ['FastTracker', 4, 4],
  '6CHN': ['FastTracker', 4, 6],
  '8CHN': ['FastTracker', 4, 8],
  'CD61': ['Octalyser', 5, 6],
  'CD81': ['Octalyser', 5, 8],
};
// Tags QTM refuses to play
const UNSUPPORTED_TAGS = ['FLT2', '16CH', '24CH', '32CH'];
const AUTHOR_KEYWORDS = ['by', 'of', 'copyright', '(c)', '#', '/'];

/** Latin-1 text of bytes, up to the first NUL, with other control characters as spaces (as QTM copies names) */
function qtmText(bytes) {
  let end = bytes.indexOf(0);
  return String.fromCharCode(...(end < 0 ? bytes : bytes.subarray(0, end)).map(c => c < 32 ? 32 : c));
}

/**
 * Parses a song's header as QTM does when it's loaded. Returns
 * {title, author, samples, format, tag, origin, channels}, or null if QTM
 * wouldn't play it. samples holds every sample's name (15 or 31 of them).
 */
export function parseQtmHeader(hdr) {
  let word = offset => hdr[offset] | hdr[offset + 1] << 8 | hdr[offset + 2] << 16 | hdr[offset + 3] << 24;
  if (hdr.length < 600)
    return null;
  // Formats QTM recognises and refuses
  if ((word(8) === 0x464e4954 && word(12) === 4) || word(0) === 0x02011313)
    return null;

  // Sound Tracker modules have 15 samples, and 120 at offset 471
  let samples = hdr[471] === 120 ? 15 : 31;
  let sequences = samples === 15 ? 472 : 952;
  if (hdr.length < (samples === 15 ? 600 : 1084))
    return null;
  // The sequence length and table entries must all be under 128
  for (let i = -2; i < 128; i++) {
    if (i !== -1 && hdr[sequences + i] > 127)
      return null;
  }

  let tag = null, format = 'Sound Tracker compatible', origin = 0, channels = 4;
  if (samples === 31) {
    tag = String.fromCharCode(...hdr.subarray(1080, 1084));
    if (UNSUPPORTED_TAGS.includes(tag))
      return null;
    // Any other tag (e.g. M!K!, or none) is played as 4 channel ProTracker
    [format, origin, channels] = TAGS[tag] || ['Sound Tracker compatible', 1, 4];
  }

  let names = [];
  for (let i = 0; i < samples; i++)
    names.push(qtmText(hdr.subarray(20 + i * 30, 42 + i * 30)).trimEnd());
  return {
    title: qtmText(hdr.subarray(0, 20)).trimEnd(),
    author: qtmAuthor(hdr, samples),
    samples: names,
    format, tag, origin, channels,
  };
}

/**
 * QTM's 'author detector': the first sample name holding one of
 * AUTHOR_KEYWORDS (anywhere, ignoring case) followed by a character above
 * ':' (e.g. "by SoDa7"). If the keyword has nothing like that after it (e.g.
 * "composed by"), the next sample name holding such a character is used, or
 * the last one. Returns the name, or null.
 *
 * Ported from QTM v1.49c with its quirks: a keyword cut off by the end of the
 * 22 byte name counts as found if it started at an odd position, and the name
 * is all 22 bytes, so a NUL doesn't end it.
 */
export function qtmAuthor(hdr, samples = 31) {
  let lower = c => c >= 65 && c <= 90 ? c + 32 : c;
  let name = i => hdr.subarray(20 + i * 30, 42 + i * 30);
  let isLetter = c => c > 58;   // QTM skips space, digits and . / :

  // Where the keyword ends in the name, true for a cut-off match QTM accepts, or -1
  function findKeyword(bytes, keyword) {
    for (let start = 0; start < 22; start++) {
      let i = 0;
      while (i < keyword.length && start + i < 22 && lower(bytes[start + i]) === keyword.charCodeAt(i))
        i++;
      if (i === keyword.length)
        return start + i;
      if (start + i >= 22)
        return start % 2 === 1 ? true : -1;
    }
    return -1;
  }

  for (let i = 0; i < samples; i++) {
    for (let keyword of AUTHOR_KEYWORDS) {
      let end = findKeyword(name(i), keyword);
      if (end === true)
        return authorText(name(i));
      if (end < 0)
        continue;
      if (name(i).subarray(end).some(isLetter))
        return authorText(name(i));
      for (let j = i + 1; j < samples; j++) {
        if (name(j).some(isLetter))
          return authorText(name(j));
      }
      return authorText(name(samples - 1));
    }
  }
  return null;
}

function authorText(bytes) {
  // QTM_Info gives no author if the name starts with a NUL, and spaces if it's blank
  return qtmText(bytes).trimEnd() || null;
}

/** Reports a song loaded, or null when it's gone */
function report(info) {
  if (info)
    console.log('Music:', JSON.stringify(info.title ?? info.filename), info.author ? `author ${JSON.stringify(info.author)}` : '', info.format ? `(${info.format})` : '');
  emit('musicInfo', info);
}

/** Forget the song, e.g. when the machine is reset (which removes QTM) */
export function clearMusicInfo() {
  report(null);
}

// QTM_Load: R0 = 0 plays the song at R1 where it is, -1 copies it from R1,
// otherwise R0 is a file name. Either way the header is read before QTM
// converts the song or frees the memory it was copied from
addSwiHook(QTM_LOAD, regs => {
  let from = regs[0] | 0;
  if (from === 0 || from === -1) {
    let info = parseQtmHeader(readMemory(regs[1], 1084));
    if (info)
      report({ ...info, address: regs[1], loadedFrom: from === 0 ? 'memory' : 'copy' });
  } else {
    report({ title: null, author: null, samples: [], format: null, tag: null, origin: null, channels: null,
             filename: readString(regs[0]), loadedFrom: 'file' });
  }
});

addSwiHook(QTM_CLEAR, () => report(null));
