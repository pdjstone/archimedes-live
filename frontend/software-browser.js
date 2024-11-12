/**
* Software browser UI
*/

const SOFTWARE_INDEX = 'software.json?' + SOFTWARE_BUILD_TAG;
const SOFTWARE_BASE_PROD = 'https://files-archi.medes.live/software/';
const SOFTWARE_BASE_DEV = 'software/';

let SOFTWARE_BASE = (document.domain == 'archi.medes.live') ? SOFTWARE_BASE_PROD : SOFTWARE_BASE_DEV;

const SOFTWARE_CATGORIES = {
  'Category: All': [],
  'Demoscene': ['demoscene'],
  //'Education': ['education'],
  'Games' : ['game'],
  '(Ex) commercial games': ['game', '!demo', '!public-domain'],
  'Public Domain': ['public-domain'],
  'Music': ['music'],
  'Utilities': ['utility']
};

for (let [k,v] of Object.entries(SOFTWARE_CATGORIES))
  v.push('!hidden')
Object.freeze(SOFTWARE_CATGORIES);

function showSoftware(softwareId) {
  let meta = window.software[softwareId];
  let details = document.getElementById('software-details');
  let title = meta['title'];
  details.querySelector('h3').textContent = title;

  let dl = details.querySelector('dl');
  removeAllChildNodes(dl);

  if ('author' in meta) appendDl(dl, 'Author', meta['author']);
  if ('publisher' in meta) appendDl(dl, 'Publisher', meta['publisher']);
  if ('year' in meta) appendDl(dl, 'Year', meta['year'].toString());

  if ('description' in meta) {
    details.querySelector('.description').style.display = 'block';
    details.querySelector('.description').textContent = meta['description'];
  } else {
    details.querySelector('.description').style.display = 'none';
  }

  let canAutoBoot = 'autoboot' in meta || 'app-path' in meta;
  let archiveButton = details.querySelector('button.archive');
  let discButton = details.querySelector('button.disc');
  let launchButton = details.querySelector('button.launch');

  let currentOs = currentMachineConfig.getOs();
  let currentCpu = currentMachineConfig.getCpuName();
  let currentMem = currentMachineConfig.getMemory();
  let bootRecommended = document.querySelector('.boot-recommended');
  let changeMachineCheckbox = bootRecommended.querySelector('input[type=checkbox]');
  let changeMachineLabel = bootRecommended.querySelector('label');
  let autoBootLabel = details.querySelector('.autoboot');
  let autoBootCheckbox = details.querySelector('.autoboot input');
  
  let bestPreset = '';

  let updateActionButtonLabel = () => {
    let checked = changeMachineCheckbox.checked;
    discButton.textContent = checked ? 'Change machine and insert disc' : 'Insert disc';
    archiveButton.textContent = checked ? 'Change machine and unpack onto HostFS' : 'Unpack onto HostFS';
  };

  if ((currentOs != 'riscos311' && (!'best-os' in meta || meta['best-os'] != currentOs)) ||
      ('best-os' in meta && meta['best-os'] != currentOs) ||
      ('best-cpu' in meta && meta['best-cpu'] != currentCpu) ||
      ('min-mem' in meta && meta['min-mem'] > currentMem))  {
  
    let recommendStr = '';
    if ('best-os' in meta) {
      recommendStr += ' in ' + OS_NAMES[meta['best-os']];
    }
    if ('best-cpu' in meta) {
      recommendStr += ' with an ' + meta['best-cpu'].toUpperCase() + ' CPU';
    }
    if ('min-mem' in meta) {
      recommendStr += ' with ' + MEM_SIZE_NAMES[meta['min-mem']] + ' RAM';
    }
    if (recommendStr == '' && currentOs != 'riscos311') {
      recommendStr = ' in RISC OS 3';
    }
    bestPreset = recommendMachinePreset(meta);
    let configBuilder = presetMachines[bestPreset]();
    let warning = `This software works best${recommendStr}, change machine to ${configBuilder.configName}?`;
    changeMachineLabel.textContent = warning;

    bootRecommended.style.display = 'block';
    changeMachineCheckbox.onchange = updateActionButtonLabel;
    changeMachineCheckbox.checked = true;
    
  } else {
    bootRecommended.style.display = 'none';
    changeMachineCheckbox.checked = false;
  }

  updateActionButtonLabel();

  let loadFn = async () => {
    closeModal('software-browser');
    if (changeMachineCheckbox.checked) {
      console.log(`Rebooting to ${bestPreset}`);
      await changeMachine({preset:bestPreset, disc:softwareId});
    } else {
      await loadFromSoftwareCatalogue(softwareId);
    }
  }

  let updateManualLoadButtons = () => {
    if (!canAutoBoot || canAutoBoot && !autoBootCheckbox.checked) {
      if ('archive' in meta) {  
        archiveButton.style.display = 'inline-block';
        discButton.style.display = 'none';
        archiveButton.onclick = loadFn;
      } 

      if ('disc' in meta) {
        discButton.style.display = 'inline-block';
        archiveButton.style.display = 'none';
        discButton.onclick = loadFn;
      } 
      launchButton.style.display = 'none';
      bootRecommended.style.display = bestPreset == '' ? 'none' : 'block';
    } else {
      launchButton.style.display = 'inline-block';
      discButton.style.display = 'none';
      archiveButton.style.display = 'none';
      bootRecommended.style.display = 'none';
    }
  }

  if (canAutoBoot) {
    launchButton.onclick = async () => {
      closeModal('software-browser');
      let machineConfig = await changeMachine({disc:softwareId, autoboot:true});
      if (machineConfig.fastForward) {
        arc_fast_forward(machineConfig.fastForward);
      }
    }
    autoBootCheckbox.onchange = updateManualLoadButtons;
    autoBootLabel.style.display = 'inline';
    autoBootCheckbox.checked = true;
  } else {
    autoBootLabel.style.display = 'none';
  }
  
  updateManualLoadButtons();

  details.style.display = 'block';
  document.getElementById('software-intro').style.display = 'none';
}

async function loadFromSoftwareCatalogue(softwareId, insert=true) {
  console.debug(`loadFromSoftwareCatalogue ${softwareId} insert=${insert}`);
  let software = await fetchSoftwareCatalogue();
  if (!softwareId in software) {
    console.error(`Unknown software ID ${softwareId}`);
    return;
  }
  let meta = software[softwareId];
  let discFile = '';
  if ('archive' in meta) {
    await loadSoftwareFromUrl(SOFTWARE_BASE + meta['archive']);
  } else if ('disc' in meta) {
    discFile = await loadSoftwareFromUrl(SOFTWARE_BASE + meta['disc'], insert);
  }
  if ('depends' in meta) {
    for (let depId of meta['depends']) {
      console.log(`${softwareId} depends on ${depId}`);
      await loadFromSoftwareCatalogue(depId);
    }
  }

  window.currentSoftwareId = meta.id;
  return discFile;
}

async function fetchSoftwareCatalogue() {
  if (typeof window.software == 'undefined') {
    try {
      let response = await fetch(SOFTWARE_BASE + SOFTWARE_INDEX);
      let json = await response.json();
      window.software = json;
      populateSoftwareCategories();
    } catch (e) {
      console.error("failed to fetch software catalogue: " + e);
    }
  }
  return window.software;
}

var softwareBrowserFirstOpen = true;

async function showSoftwareBrowser() {
  showModal('software-browser');
  await fetchSoftwareCatalogue();
  filterSoftware();
  if (softwareBrowserFirstOpen) {
    softwareBrowserFirstOpen = false;
    if (window.currentSoftwareId) {
      showSoftware(currentSoftwareId)
    }
  }
}

function populateSoftwareCategories() {
  let sel = document.getElementById('software-category');
  removeAllChildNodes(sel);
  for (const [title, tags] of Object.entries(SOFTWARE_CATGORIES)) {
    let opt = document.createElement('option');
    opt.text = title;
    opt.value = tags.join(',');
    sel.add(opt);
  }
}

function populateSoftwareList(search = '', tags=null) {
  let ul = document.querySelector('#software-browser-cols ul');
  removeAllChildNodes(ul);
  search = search.toLowerCase();
  let titles = [];
  for (const [softwareId, meta] of Object.entries(window.software)) {
    let title = meta['title'];
    if ('year' in meta) 
      title += ' (' + meta['year'] + ')';
    let searchMatch = search == '' || title.toLowerCase().includes(search);
    let tagsMatch = true;
    if (tags) {
      for (let t of tags) {
        if (t.startsWith('!')) { 
          if (meta.tags.indexOf(t.substr(1)) >= 0)
            tagsMatch = false;
        } else if (meta.tags.indexOf(t) < 0) 
          tagsMatch = false;
      }
    }
    if (searchMatch && tagsMatch)
      titles.push([softwareId, title]);
  }
  titles.sort((a,b) => { return (a[1] > b[1]) ? 1 : -1});
  for (const [softwareId, title] of titles) {
    let li = document.createElement('li');
    li.setAttribute('tabindex', '0');
    li.textContent = title;
    li.onclick = (e) => {
      ul.querySelector('.selected')?.classList.remove('selected');
      e.target.classList.add('selected');
      showSoftware(softwareId);
    }
    ul.appendChild(li);
  }
}

function filterSoftware() {
  let searchText = document.querySelector('#software-browser .search').value;
  let tags = document.getElementById('software-category').selectedOptions[0].value;
  if (tags == '') {
    tags = null;
  } else {
    tags = tags.split(',');
  }
  populateSoftwareList(searchText, tags);

}

function handleFileButton() {
  if (!this.files || this.files.length == 0)
    return;
  let file = this.files[0];
  console.log("upload via file button", file.name);
  loadSoftware(file.name, file).then(() => {
    closeModal('software-browser');
    console.log('done loading file');
  });
}

document.getElementById('filebutton').addEventListener('change', handleFileButton, false);