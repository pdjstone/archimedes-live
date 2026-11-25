/**
 * The BBC BASIC editor. Running a program always starts it on a clean
 * machine: the worker reboots into it (worker/basic-launch.js), or once
 * booted into BASIC, does a quick reset, which no program can block.
 *
 * The program is saved in localStorage as it's edited. A program opened from
 * a share link isn't saved until it's edited, and then the one it replaces is
 * kept, for "Restore previous program".
 */

const SAVED_KEY = 'basicProg';
const PREVIOUS_KEY = 'basicProgPrevious';
const SAVE_DELAY_MS = 500;

let ui = null;

/**
 * @param uiFunctions - from ui.js: showModal, closeModal, showBooleanDialog,
 *   changeMachine, runBasic and getMachinePreset
 */
export function initBasicEditor(uiFunctions) {
  ui = uiFunctions;
  // Called from inline event handlers in index.html
  Object.assign(window, {
    showBasicEditor, closeBasicEditor, runProgram, restorePreviousProgram,
    showShareBox, tweetProg, copyProgAsURL
  });
}

// Set by the worker each time the machine boots (setBootedToBasic)
let bootedToBasic = false;

export function setBootedToBasic(basic) {
  bootedToBasic = !!basic;
}

async function runProgram() {
  let prog = document.getElementById('editor').value;
  saveNow();
  if (!bootedToBasic) {
    let reboot = await ui.showBooleanDialog(
      'Run BASIC program', 
      'Reboot emulator to BASIC prompt?', 
      'Reboot', 'Cancel');
    if (reboot) {
      ui.changeMachine({preset: ui.getMachinePreset(), autoboot: true, basic: true,
        basicProg: prog});
    }
  } else {
    await ui.runBasic(prog);
    document.getElementById('editor').focus();
  }
}

// localStorage can refuse (private browsing, a full quota), so failing to
// save mustn't stop anything else working
function load(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn(`Couldn't save the BASIC program: ${e}`);
  }
}

// What the editor holds isn't the saved program: it came from a share link,
// and hasn't been edited
let fromLink = false;
// The editor holds what was loaded or edited, so opening it again keeps that
let loaded = false;
let saveTimeout = null;

function saveNow() {
  clearTimeout(saveTimeout);
  saveTimeout = null;
  if (fromLink)
    return;
  let prog = document.getElementById('editor').value;
  let saved = load(SAVED_KEY);
  if (saved === prog)
    return;
  store(SAVED_KEY, prog);
  updateRestoreLink();
}

function edited() {
  updateCharCount();
  if (fromLink) {
    // It becomes the saved program, so keep the one it replaces
    fromLink = false;
    let saved = load(SAVED_KEY);
    if (saved?.trim())
      store(PREVIOUS_KEY, saved);
    updateRestoreLink();
  }
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveNow, SAVE_DELAY_MS);
}

/** Swap the program with the one kept, so this can be undone the same way */
function restorePreviousProgram() {
  let editor = document.getElementById('editor');
  let previous = load(PREVIOUS_KEY);
  if (previous === null)
    return;
  let current = editor.value;
  editor.value = previous;
  saveNow();
  if (current.trim())
    store(PREVIOUS_KEY, current);
  updateCharCount();
  updateRestoreLink();
  editor.focus();
}

// Not while a share link's program is shown, as swapping it would replace the
// saved program without keeping it
function updateRestoreLink() {
  let previous = load(PREVIOUS_KEY);
  document.getElementById('restore-prog').hidden = fromLink ||
    previous === null || previous === document.getElementById('editor').value;
}

/**
 * Show the editor. With a program (from a share link) it holds that, without
 * one what it held before, or the saved program.
 */
export function showBasicEditor(program = '') {
  let editor = document.getElementById('editor');
  if (program) {
    let saved = load(SAVED_KEY);
    fromLink = saved !== null && saved.trim() !== '' && saved !== program;
    editor.value = program;
    loaded = true;
    if (!fromLink)
      saveNow();
  } else if (!loaded) {
    editor.value = load(SAVED_KEY) ?? '';
    loaded = true;
  }
  program = editor.value;
  document.getElementById('editor-container').style.display = 'block';
  updateCharCount();
  updateRestoreLink();
  setTimeout(() => {
    let editor = document.getElementById('editor');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, 20);
  return program;
}

function closeBasicEditor() {
  saveNow();
  document.getElementById('editor-container').style.display = 'none';
}

function updateCharCount() {
  let prog = document.getElementById('editor').value;
  document.getElementById('char-count').textContent = prog.length.toString() + ' characters';
}

// -- Sharing UI ------------------------------------------------------------------

function showShareBox() {
  ui.showModal('share-box');
  document.getElementById('share-url').value = getBasicShareUrl();
  setTimeout(() => {
    document.getElementById('share-url').select();
    document.getElementById('share-url').focus();
  }, 5);
}


function getBasicShareUrl() {
  let prog = document.getElementById('editor').value;
  let param = encodeURIComponent(prog)
    .replace(/[(]/g, "%28")
    .replace(/[)]/g, "%29");
  return location.protocol + '//' + location.host + location.pathname + '#basic=' + param;
}


function tweetProg() {
  let prog = document.getElementById('editor').value;
  let url = "https://twitter.com/intent/tweet?screen_name=ARM2bot&text=" + encodeURIComponent(prog);
  window.open(url);
  ui.closeModal('share-box');
}


function copyProgAsURL() {
  navigator.clipboard.writeText(getBasicShareUrl()).then(function() {
    console.log('clipboard write ok');
  }, function() {
    console.log('clipboard write failed');
  });
  ui.closeModal('share-box');
}



// Every change, including deleting, pasting, undo and phone keyboards
document.getElementById('editor').addEventListener('input', edited);
// Don't lose the last edit if the page is closed before the save is due
document.addEventListener('visibilitychange', () => {
  if (document.hidden && saveTimeout)
    saveNow();
});
addEventListener('pagehide', () => {
  if (saveTimeout)
    saveNow();
});