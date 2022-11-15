
function rerunProg() {
    sendKeyCode(KEY_ESCAPE);
    setTimeout(() => sendKeyCode(KEY_F1), 200);
    setTimeout(() => document.getElementById('editor').focus(), 200);
  }
  
function wrapProg(prog) {
  return '*KEY1 *!boot |M\n*basic\n' + prog + '\nRUN\n';
}
  
async function runProgram() {
  let prog = document.getElementById('editor').value;
  if (!currentMachineConfig.autoboot) {
    let reboot = await showBooleanDialog(
      'Run BASIC program', 
      'Reboot emulator to BASIC prompt?', 
      'Reboot', 'Cancel');
    if (reboot) {
      autoboot = true;
      await changeMachine(machinePreset);
    }
  }
  putDataAtPath(wrapProg(prog), '/hostfs/!boot,ffe');
  rerunProg();
  saveProgramToLocalStorage();
}

function saveProgramToLocalStorage() {
  let prog = document.getElementById('editor').value;
  if (prog.trim() == '')
    return;
  localStorage.basicProg = prog;
  console.log('saved program to localStorage');
}



function showEditor(program = '') {
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

function updateCharCount() {
  let prog = document.getElementById('editor').value;
  document.getElementById('char-count').textContent = prog.length.toString() + ' characters';
  if (window.saveBasicTimeout)
    clearTimeout(window.saveBasicTimeout)
  window.saveBasicTimeout = setTimeout(saveProgramToLocalStorage, 1000);
}

// -- Sharing UI ------------------------------------------------------------------

function showShareBox() {
  showModal('share-box');
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
  closeModal('share-box');
}


function copyProgAsURL() {
  navigator.clipboard.writeText(getBasicShareUrl()).then(function() {
    console.log('clipboard write ok');
  }, function() {
    console.log('clipboard write failed');
  });
  closeModal('share-box');
}



document.getElementById('editor').addEventListener('keypress', e => updateCharCount());