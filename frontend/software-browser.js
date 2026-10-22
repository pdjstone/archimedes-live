/**
* Software catalogue. Imported by the worker, which loads software into its FS,
* and by the page UI (software-browser-ui.js)
*/
 
import { loadSoftwareFromUrl } from './hostfs.js'
import { recommendMachinePreset } from './machine-config.js'

let SOFTWARE_CATALOG = null;


const SOFTWARE_INDEX = 'software.json?';
const SOFTWARE_BASE_PROD = 'https://files-archi.medes.live/software/';
const SOFTWARE_BASE_DEV = 'software/';

let SOFTWARE_BASE = (new URL(import.meta.url).domain == 'archi.medes.live') ? SOFTWARE_BASE_PROD : SOFTWARE_BASE_DEV;

export async function loadFromSoftwareCatalogue(softwareId, insert=true) {
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

  //window.currentSoftwareId = meta.id;
  return discFile;
}

export async function fetchSoftwareCatalogue() {
  if (SOFTWARE_CATALOG === null) {
    try {
      let response = await fetch(SOFTWARE_BASE + SOFTWARE_INDEX);
      let json = await response.json();
      SOFTWARE_CATALOG = json;
      //populateSoftwareCategories();
    } catch (e) {
      console.error("failed to fetch software catalogue: " + e);
    }
  }
  return SOFTWARE_CATALOG;
}
