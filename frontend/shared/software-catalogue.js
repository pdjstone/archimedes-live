/**
* The software catalogue, used by the page (software-browser-ui.js) and by
* the worker, which loads software into its FS (worker/hostfs.js)
*/

import { SOFTWARE_BASE } from './paths.js'

let SOFTWARE_CATALOG = null;


const SOFTWARE_INDEX = 'software.json?';

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
