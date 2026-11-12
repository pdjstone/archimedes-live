/**
 * Shows the music a program is playing (window.arcMusicInfo, see
 * qtm-info.js) in the OS media controls: the notification shade and lock
 * screen on phones, and media keys. Their play and pause buttons pause the
 * emulator, and next and previous track ask the program to change the song.
 *
 * Setting navigator.mediaSession.metadata isn't enough for Android, which
 * only shows the controls while an <audio> element plays at least ~5 s of
 * media from a file or blob that isn't digital silence. WebAudio doesn't
 * count, so this loops 30 s of noise at about -66 dBFS alongside it
 * (projects/mobiletests mediasession.html has the experiments).
 */

import { latin1Bytes } from './shared/latin1.js'

const NOISE_SECONDS = 30;
const NOISE_RATE = 8000;
const NOISE_LEVEL = 0.0005;
// Programs clear the song before loading the next one (QTM_Clear then
// QTM_Load), so the session is only ended if no song follows within this long.
// Pausing the <audio> element between songs can make Android treat a page in
// the background as no longer playing, and throttle it.
const CLEAR_DELAY_MS = 3000;

const hasMediaSession = 'mediaSession' in navigator;
let audioEl = null;
let album = '';
let music = null;
let paused = false;
let callbacks = null;
let clearTimer = null;

/**
 * Starts following arcmusicinfo events. pause() and resume() pause and resume
 * the emulator, and changeTrack(1) or (-1) asks the program for the next or
 * previous song; they're called from the media controls' buttons, which count
 * as a user gesture.
 */
export function initMediaSession({ pause, resume, changeTrack }) {
  if (!hasMediaSession)
    return;
  callbacks = { pause, resume, changeTrack };
  addEventListener('arcmusicinfo', event => setMusic(event.detail));
  let actions = [
    ['play', () => callbacks.resume()],
    ['pause', () => callbacks.pause()],
    // The emulator can't stop, so this pauses it like the pause button
    ['stop', () => callbacks.pause()],
    ['nexttrack', () => callbacks.changeTrack(1)],
    ['previoustrack', () => callbacks.changeTrack(-1)],
  ];
  for (let [action, fn] of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch (e) {
      console.log(`MediaSession: no "${action}" action`, e);
    }
  }
}

/** The software that's running, shown as the album */
export function setMediaSessionAlbum(title) {
  album = title || '';
  if (music)
    updateMetadata();
}

/** Called when the emulator is paused or resumed, by the media controls or otherwise */
export function setMediaSessionPaused(isPaused) {
  paused = isPaused;
  if (!music)
    return;
  if (paused)
    audioEl.pause();
  else
    playAudio();
  navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
}

function setMusic(info) {
  clearTimeout(clearTimer);
  clearTimer = null;
  if (!info) {
    if (music)
      clearTimer = setTimeout(endSession, CLEAR_DELAY_MS);
    return;
  }
  music = info;
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.loop = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.src = URL.createObjectURL(noiseWav());
    document.body.append(audioEl);
  }
  updateMetadata();
  setMediaSessionPaused(paused);
}

function endSession() {
  clearTimer = null;
  music = null;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = 'none';
  setPositionState();
  audioEl.pause();
}

function updateMetadata() {
  let title = music.title || music.filename?.replace(/^.*[.:]/, '') || 'Untitled';
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: music.author || '', album });
  // A song plays for as long as the program likes, so it has no length
  // (otherwise the controls show the looping <audio> element's 30 s)
  setPositionState({ duration: Infinity });
}

/** Sets the controls' position state, or clears it with no argument */
function setPositionState(state) {
  try {
    navigator.mediaSession.setPositionState?.(state);
  } catch (e) {
    console.log('MediaSession: can\'t set the position state', e);
  }
}

/**
 * Plays the <audio> element. Before the user has interacted with the page the
 * browser refuses, so try again on their first click or key press.
 */
function playAudio() {
  if (!audioEl.paused)
    return;
  audioEl.play().catch(() => {
    const retry = () => {
      removeEventListener('pointerdown', retry, true);
      removeEventListener('keydown', retry, true);
      if (music && !paused)
        audioEl.play().catch(e => console.log('MediaSession: <audio> won\'t play', e));
    };
    addEventListener('pointerdown', retry, true);
    addEventListener('keydown', retry, true);
  });
}

/** NOISE_SECONDS of quiet noise as a mono 16 bit WAV file */
function noiseWav() {
  let frames = NOISE_SECONDS * NOISE_RATE;
  let view = new DataView(new ArrayBuffer(44 + frames * 2));
  let text = (offset, s) => new Uint8Array(view.buffer).set(latin1Bytes(s), offset);
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, NOISE_RATE, true); view.setUint32(28, NOISE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++)
    view.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * NOISE_LEVEL * 0x7fff), true);
  return new Blob([view.buffer], { type: 'audio/wav' });
}
