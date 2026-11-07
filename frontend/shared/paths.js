/**
 * Where data outside the code's directory lives. The code is served from
 * v/<build tag>/ (see the Makefile), and this module from its shared/
 * subdirectory, so the top level of the site is three levels up.
 */

export const SITE_ROOT = new URL('../../../', import.meta.url).href;

// URL has no `domain`, so this is never true and the files always come from
// the site itself. Fixing it would fetch them cross-origin from
// files-archi.medes.live, which needs CORS and CORP headers there.
const IS_PROD = new URL(import.meta.url).domain == 'archi.medes.live';

export const ROM_BASE = IS_PROD ? 'https://files-archi.medes.live/roms/' : SITE_ROOT + 'emu/roms/';
export const SOFTWARE_BASE = IS_PROD ? 'https://files-archi.medes.live/software/' : SITE_ROOT + 'software/';
