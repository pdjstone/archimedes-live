const IS_PROD = new URL(import.meta.url).hostname == 'archi.medes.live';

export const ROM_BASE = IS_PROD ? 'https://files-archi.medes.live/roms/' : '/emu/roms/';
export const SOFTWARE_BASE = IS_PROD ? 'https://files-archi.medes.live/software/' : '/software/';
