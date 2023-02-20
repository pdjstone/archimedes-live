/**
* Software browser UI
*/

const SOFTWARE_INDEX = 'software.json?' + SOFTWARE_BUILD_TAG;
const SOFTWARE_BASE_PROD = 'https://files-archi.medes.live/software/';
const SOFTWARE_BASE_DEV = 'software/';

let SOFTWARE_BASE = (document.domain == 'archi.medes.live') ? SOFTWARE_BASE_PROD : SOFTWARE_BASE_DEV;

const SOFTWARE_CATGORIES = Object.freeze({
  'Category: All': [],
  'Demoscene': ['demoscene'],
  //'Education': ['education'],
  'Games' : ['game'],
  '(Ex) commercial games': ['game', '!demo', '!public-domain'],
  'Public Domain': ['public-domain'],
  'Music': ['music'],
  'Utilities': ['utility']
});


function showSoftware(softwareId) {
  let meta = window.software[softwareId];
  let details = document.getElementById('software-details');
  let title = meta['title'];
  //if ('year' in meta) 
  //  title += ' (' + meta['year'] + ')';
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

  let archiveButton = details.querySelector('button.archive');
  let discButton = details.querySelector('button.disc');
 

  if ('archive' in meta) {
    archiveButton.style.display = 'inline-block';
    archiveButton.onclick = () => {
      closeModal('software-browser');
      loadFromSoftwareCatalogue(softwareId);
    }
  } else {
    archiveButton.style.display = 'none';
  }

  if ('disc' in meta) {
    discButton.style.display = 'inline-block';
    discButton.onclick = () => {
      closeModal('software-browser');
      loadFromSoftwareCatalogue(softwareId);
    }
  } else {
    discButton.style.diplay = 'none';
  }
  
  details.querySelector('.autoboot').style.display = ('autoboot' in meta) ? 'inline' : 'none';
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
  if ('archive' in meta) {
    loadSoftwareFromUrl(SOFTWARE_BASE + meta['archive']);
  } else if ('disc' in meta) {
    loadSoftwareFromUrl(SOFTWARE_BASE + meta['disc'], insert);
  }
  document.title = meta['title'] + " - Archimedes Live!";
  window.currentSoftwareId = meta.id;
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

async function showSoftwareBrowser() {
  showModal('software-browser');
  await fetchSoftwareCatalogue();
  populateSoftwareList();
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