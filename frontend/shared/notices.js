/**
 * Notices for the user: what happened when they loaded something, and what's
 * wrong with the URL's parameters. Every message's text is here, and nowhere
 * else; code refers to a notice by its id, with the values for its text:
 *
 *   {id: Notice.UNPACKED, params: {file: 'foo.zip', count: 6}}
 *
 * A notice crosses between the worker and the page in that form, and is only
 * turned into text (formatNotice) to show it, so the text can be changed here
 * without touching the code that raises it. `{name}` in a text is replaced by
 * params.name.
 *
 * level is 'success', 'warning' (it went ahead, but not quite as asked) or
 * 'error' (it didn't happen).
 */

export const NOTICES = {
  // Files the user dropped on the page or chose with the upload button
  DISC_INSERTED:                { level: 'success', text: 'Inserted {file} into drive :0' },
  DISC_INSERTED_FROM_ZIP:       { level: 'success', text: 'Inserted {disc} from {file} into drive :0' },
  DISC_INSERTED_FROM_MULTI_ZIP: { level: 'success', text: 'Inserted {disc} from {file} into drive :0 (the first of its {count} disc images)' },
  UNPACKED:                     { level: 'success', text: 'Unpacked {count} files from {file} onto HostFS' },
  COPIED_TO_HOSTFS:             { level: 'success', text: 'Copied {file} onto HostFS as {name}' },
  HOSTFS_NEEDS_RISC_OS_3:       { level: 'warning', text: "{file} is on HostFS, but {os} can't see HostFS. Switch to a RISC OS 3 machine to use it" },

  // Loading a file, from the user, a URL or the software catalogue
  FILE_TYPE_UNKNOWN:            { level: 'error', text: "{file} isn't a disc image or a RISC OS archive" },
  ZIP_NOT_RISC_OS:              { level: 'error', text: '{file} has no disc image or RISC OS files in it' },
  UNPACK_FAILED:                { level: 'error', text: "Couldn't unpack {file}: {reason}" },
  DISC_FAILED:                  { level: 'error', text: "Couldn't insert {file}: {reason}" },
  DOWNLOAD_FAILED:              { level: 'error', text: "Couldn't download {url}: {reason}" },

  // The software catalogue
  CATALOGUE_ID_UNKNOWN:         { level: 'error', text: "There's nothing called '{id}' in the software catalogue" },
  CATALOGUE_UNAVAILABLE:        { level: 'error', text: "Couldn't load the software catalogue" },
  AUTOBOOT_NO_COMMANDS:         { level: 'warning', text: "{title} has no boot commands, so it won't start by itself" },

  // Booting
  AUTOBOOT_NEEDS_RISC_OS_3:     { level: 'warning', text: "autoboot needs RISC OS 3, and the {machine} has {os}" },
  ROMS_FAILED:                  { level: 'error', text: "Couldn't load the ROMs for the {machine}: {reason}" },

  // URL parameters
  PRESET_UNKNOWN:               { level: 'warning', text: "There's no machine called '{preset}', so it's using the {machine}" },
  DISC_WITH_BASIC:              { level: 'warning', text: "disc and basic can't be used together, so basic is ignored" },
  PARAM_INVALID:                { level: 'warning', text: 'Ignored {param}={value}: {hint}' },
};

/**
 * The notice ids, for code to use instead of strings: Notice.UNPACKED is
 * 'UNPACKED'. Editors complete them from NOTICES, and a name that isn't there
 * throws rather than giving undefined. They stay strings so notices can be
 * posted between the worker and the page.
 * @type {{readonly [K in keyof typeof NOTICES]: K}}
 */
export const Notice = new Proxy(Object.freeze(Object.fromEntries(Object.keys(NOTICES).map(id => [id, id]))), {
  get(ids, name) {
    // Leave alone what generic code looks for (JSON.stringify, await)
    if (typeof name === 'string' && !(name in ids) && name !== 'toJSON' && name !== 'then') {
      throw new Error(`There's no notice called ${name}`);
    }
    return ids[name];
  },
});

// The {hint} for PARAM_INVALID, for each parameter
export const PARAM_HINTS = {
  ff: 'it should be a number of milliseconds',
  soundfilter: 'it should be 0 (the original), 1 or 2 (the least filtering)',
  dumpaudio: 'it should be duration,delay in seconds',
  'mouse-capture': 'it should be auto, force or never',
};

/** The text for a notice: {id, params} */
export function formatNotice({ id, params = {} }) {
  let notice = NOTICES[id];
  if (!notice) {
    return `${id} ${JSON.stringify(params)}`;
  }
  return notice.text.replace(/\{(\w+)\}/g, (m, name) => name in params ? String(params[name]) : m);
}

export function noticeLevel({ id }) {
  return NOTICES[id]?.level ?? 'error';
}

/**
 * A failure to tell the user about. Its message is the notice's text, so the
 * console still says what went wrong; `notice` is what to show. rpc.js passes
 * `notice` across from the worker with the error.
 */
export class NoticeError extends Error {
  constructor(id, params = {}) {
    super(formatNotice({ id, params }));
    this.name = 'NoticeError';
    this.notice = { id, params };
  }
}

/** The reason in an error's notice: its message, without a stack */
export function reasonFor(e) {
  return e?.message ?? String(e);
}
