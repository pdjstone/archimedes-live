/**
 * Covers the display while the emulator fast-forwards (the arcfastforward
 * event, see fast-forward.js in the worker), which it does without drawing
 * anything. It shows a progress bar and "Loading..." or, for a boot
 * fast-forward of a software catalogue title, "Loading {title}...".
 */

let overlay, text, fill;
let active = false;

/**
 * Starts following arcfastforward events. getTitle() gives the title of the
 * software catalogue entry the machine booted, or null.
 */
export function initFastForwardOverlay(getTitle) {
  overlay = document.getElementById('ff-overlay');
  text = overlay.querySelector('.ff-text');
  fill = overlay.querySelector('.ff-progress-fill');
  window.addEventListener('arcfastforward', ({detail: status}) => {
    if (status) {
      if (!active)
        start(status.startMs == 0 ? getTitle() : null);
      setFill(status.fraction);
    } else if (active) {
      end();
    }
  });
}

function start(title) {
  active = true;
  text.textContent = title ? `Loading ${title}...` : 'Loading...';
  // Start from empty, without animating down from the last one
  fill.style.transition = 'none';
  setFill(0);
  fill.offsetWidth;
  fill.style.transition = '';
  document.body.classList.add('emu-fast-forward');
}

// Fill the bar. The overlay fades out once it has (style.css)
function end() {
  active = false;
  setFill(1);
  document.body.classList.remove('emu-fast-forward');
}

function setFill(fraction) {
  fill.style.width = `${fraction * 100}%`;
}
