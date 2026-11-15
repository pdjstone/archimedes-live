/**
* The software catalogue, used by the page (software-browser-ui.js) and by
* the worker, which loads software into its FS (worker/hostfs.js)
*/

import { SOFTWARE_BASE } from './paths.js'

let SOFTWARE_CATALOG = null;

/**
 * A hash of software.json (SOFTWARE_BUILD_TAG in the Makefile), so each
 * version of the catalogue has its own URL. The page has it in index.html's
 * software-tag meta tag, and gives it to the worker in the fragment of the
 * worker's URL (#sw=..., see ui.js), which the server never sees, so the
 * worker's script is cached the same whatever it is. '' if there isn't one
 */
export const catalogueTag = globalThis.document
  ? document.querySelector('meta[name="software-tag"]')?.content || ''
  : new URLSearchParams(self.location.hash.slice(1)).get('sw') || '';

// Without a tag, revalidate rather than risk a stale copy
const CATALOGUE_URL = SOFTWARE_BASE + 'software.json' +
  (catalogueTag ? '?v=' + encodeURIComponent(catalogueTag) : '');
const CATALOGUE_FETCH_OPTIONS = catalogueTag ? {} : { cache: 'no-cache' };

export async function fetchSoftwareCatalogue() {
  if (SOFTWARE_CATALOG === null) {
    try {
      let response = await fetch(CATALOGUE_URL, CATALOGUE_FETCH_OPTIONS);
      let json = await response.json();
      SOFTWARE_CATALOG = json;
      //populateSoftwareCategories();
    } catch (e) {
      console.error("failed to fetch software catalogue: " + e);
    }
  }
  return SOFTWARE_CATALOG;
}
