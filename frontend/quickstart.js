/**
 * The Quick Start panel beside the emulator: a reminder of a catalogue
 * title's controls and gameplay, from its Markdown's "Quick Start" section
 * (meta.quickstart, HTML made by arclive-software's toml2json.py).
 *
 * It's shown when a title with one boots, unless the user has closed it for
 * that title; the header's "Quick start" button brings it back.
 */

import { SOFTWARE_BASE } from './shared/paths.js'

const HIDDEN_KEY = 'quickstartHidden';     // localStorage: IDs whose panel was closed

let current = null;     // the booted title's meta, if it has a quick start

function hiddenIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'));
  } catch (e) {
    return new Set();
  }
}

function rememberHidden(id, hidden) {
  let ids = hiddenIds();
  hidden ? ids.add(id) : ids.delete(id);
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
  } catch (e) {
    // Not remembered, e.g. storage blocked
  }
}

function setVisible(visible) {
  document.getElementById('quickstart').hidden = !visible;
  document.getElementById('quickstart-button').hidden = !current || visible;
}

/** The title that's booted (its catalogue meta), or null */
export function setQuickstartSoftware(meta) {
  current = meta?.quickstart ? meta : null;
  if (!current) {
    setVisible(false);
    return;
  }
  let panel = document.getElementById('quickstart');
  panel.querySelector('.quickstart-title').textContent = `${current.title} - Quick start`;
  // The app's icon, from its !Sprites (meta.icon, relative to the catalogue)
  let icon = panel.querySelector('.quickstart-icon');
  icon.hidden = !current.icon;
  if (current.icon)
    icon.src = SOFTWARE_BASE + current.icon;
  else
    icon.removeAttribute('src');
  // HTML from the catalogue's own Markdown, like the description
  panel.querySelector('.quickstart-content').innerHTML = current.quickstart;
  setVisible(!hiddenIds().has(current.id));
}

export function showQuickstart() {
  if (!current) return;
  rememberHidden(current.id, false);
  setVisible(true);
}

export function closeQuickstart() {
  if (current) rememberHidden(current.id, true);
  setVisible(false);
}
