/**
 * The BBC BASIC editor. Running a program always starts it on a clean
 * machine: the worker reboots into it (worker/basic-launch.js), or once
 * booted into BASIC, does a quick reset, which no program can block.
 */

let ui = null;

/**
 * @param uiFunctions - from ui.js: showModal, closeModal, showBooleanDialog,
 *   changeMachine, runBasic and getMachinePreset
 */
export function initBasicEditor(uiFunctions) {
  ui = uiFunctions;
  // Called from inline event handlers in index.html
  Object.assign(window, {
    showBasicEditor, closeBasicEditor, runProgram, updateCharCount,
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
  saveProgramToLocalStorage();
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

function saveProgramToLocalStorage() {
  let prog = document.getElementById('editor').value;
  if (prog.trim() == '')
    return;
  localStorage.basicProg = prog;
  console.log('saved program to localStorage');
}



export function showBasicEditor(program = '') {
  if (program == '') {
    if ('basicProg' in localStorage)
      program = localStorage.basicProg;
  }
  document.getElementById('editor').value = program;
  document.getElementById('editor-container').style.display = 'block';
  updateCharCount();
  setTimeout(() => {
    let editor = document.getElementById('editor');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, 20);
  return program;
}

function closeBasicEditor() {
  document.getElementById('editor-container').style.display = 'none';
}

let saveTimeout = null;

function updateCharCount() {
  let prog = document.getElementById('editor').value;
  document.getElementById('char-count').textContent = prog.length.toString() + ' characters';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveProgramToLocalStorage, 1000);
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



document.getElementById('editor').addEventListener('keypress', e => updateCharCount());