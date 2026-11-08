/*Shows notices (shared/notices.js) to the user. For now each one is logged
  and dispatched as an 'arcnotice' event on window, with {id, params, level,
  text} as its detail, for the UI to show. window.arcNotices() gives every
  notice so far, including those raised before anything listened (the URL's
  parameters are checked as the page loads).*/

import { formatNotice, noticeLevel } from './shared/notices.js'

const notices = [];

export function notify(notice) {
  let n = { id: notice.id, params: notice.params ?? {}, level: noticeLevel(notice), text: formatNotice(notice) };
  notices.push(n);
  let log = { error: console.error, warning: console.warn }[n.level] ?? console.log;
  log(`Notice (${n.level}): ${n.text}`);
  window.dispatchEvent(new CustomEvent('arcnotice', { detail: n }));
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
