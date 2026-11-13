/*Shows notices (shared/notices.js) to the user, as toasts over the bottom of
  the display (inside #display-container, so they're seen in fullscreen too).
  Each one is also logged and dispatched as an 'arcnotice' event on window,
  with {id, params, level, text} as its detail. window.arcNotices() gives
  every notice so far, including those raised before anything listened (the
  URL's parameters are checked as the page loads).*/

import { formatNotice, noticeLevel } from './shared/notices.js'

const notices = [];

export function notify(notice) {
  let n = { id: notice.id, params: notice.params ?? {}, level: noticeLevel(notice), text: formatNotice(notice) };
  notices.push(n);
  let log = { error: console.error, warning: console.warn }[n.level] ?? console.log;
  log(`Notice (${n.level}): ${n.text}`);
  showToast(n);
  window.dispatchEvent(new CustomEvent('arcnotice', { detail: n }));
}

// How long a toast stays, by level (ms). Hovering over it keeps it.
const TOAST_MS = { success: 4000, warning: 4000, error: 6000 };
const MAX_TOASTS = 4;

let toastBox = null;

function getToastBox() {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.id = 'notice-toasts';
    toastBox.setAttribute('aria-live', 'polite');
    (document.getElementById('display-container') ?? document.body).appendChild(toastBox);
  }
  return toastBox;
}

function showToast(n) {
  let box = getToastBox();
  // The same notice again (e.g. dropping the same file twice) restarts its toast
  for (let old of box.children) {
    if (old.textContent === n.text) {
      old.remove();
    }
  }
  while (box.children.length >= MAX_TOASTS) {
    box.firstElementChild.remove();
  }

  let el = document.createElement('div');
  el.className = `notice-toast ${n.level}`;
  el.setAttribute('role', n.level === 'error' ? 'alert' : 'status');
  el.title = 'Click to dismiss';
  el.textContent = n.text;
  box.appendChild(el);

  let timer = null;
  let dismiss = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  };
  let start = () => { timer = setTimeout(dismiss, TOAST_MS[n.level] ?? TOAST_MS.error); };
  el.addEventListener('click', dismiss);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', start);
  start();
}

/*For a call that failed: show its notice if it has one (a NoticeError, from
  the worker too), or log it if it's unexpected*/
export function notifyFailure(e) {
  if (e?.notice) {
    notify(e.notice);
  } else {
    console.error(e);
  }
}

window.arcNotices = () => notices.slice();
