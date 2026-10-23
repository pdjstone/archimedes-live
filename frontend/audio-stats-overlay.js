/*Audio stats over the emulator display (#audiostats), for checking audio on
  browsers without a console, e.g. on a phone. Tap it to switch between one
  line and the full panel.

  It reads emuAudio.stats() without resetting anything, so window.arcAudioStats
  works as before: the fill extremes it shows are its own, from sampling the
  fill several times a second. Counters are totals since the page loaded (or
  Reset), with how much each went up in the last RECENT_MS.*/

import { SAMPLE_RATE } from './audio-ring.js';

const UPDATE_MS = 250;
const RECENT_MS = 10000;

// Counters that mean audio was lost or damaged: [stats key, label]
const GLITCHES = [
  ['underruns', 'underruns'], ['silentFrames', 'silent frames'], ['overflows', 'overflows'],
  ['framesDropped', 'frames dropped'], ['recordsDropped', 'records dropped'],
  ['eventsDropped', 'events dropped'], ['clips', 'clips'], ['ddUnderruns', 'disc noise underruns'],
];

export function startAudioStatsOverlay(emuAudio) {
  const el = document.createElement('div');
  el.id = 'audio-stats-overlay';
  el.innerHTML = '<div class="summary"></div><div class="details"></div>' +
                 '<div class="buttons"><button type="button" class="reset">Reset</button></div>';
  document.getElementById('display-container').appendChild(el);
  const summary = el.querySelector('.summary');
  const details = el.querySelector('.details');

  let expanded = false;
  try { expanded = localStorage.getItem('audioStatsOverlayExpanded') == '1'; } catch (e) {}
  const show = () => el.classList.toggle('expanded', expanded);
  show();
  el.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    expanded = !expanded;
    try { localStorage.setItem('audioStatsOverlayExpanded', expanded ? '1' : '0'); } catch (e) {}
    show();
  });

  let baseline = null;    // stats at the last Reset
  let history = [];       // {t, stats, fillMs} for the last RECENT_MS
  el.querySelector('.reset').addEventListener('click', () => {
    baseline = emuAudio.stats();
    history = [];
  });

  function update() {
    const s = emuAudio.stats();
    if (!s) {
      summary.textContent = 'Audio: not set up yet';
      details.textContent = '';
      return;
    }
    const now = performance.now();
    // Output frames the emulator has made that the worklet hasn't played
    const fillMs = Math.max(0, s.frameWatermark - s.framesRead) / SAMPLE_RATE * 1000;
    history.push({t: now, s, fillMs});
    while (history.length > 1 && now - history[0].t > RECENT_MS) history.shift();
    const old = history[0];
    if (!baseline) baseline = s;

    const total = k => s[k] - baseline[k];
    const recent = k => s[k] - old.s[k];
    const fills = history.map(h => h.fillMs);
    const span = (now - old.t) / 1000;
    // Speed from how fast the emulator makes output frames (a stream reset restarts the count)
    const rate = (k, scale) => span >= 1 && s.resets == old.s.resets ? Math.round((s[k] - old.s[k]) / span / scale * 100) : null;
    const emuSpeed = rate('frameWatermark', SAMPLE_RATE);
    const playSpeed = rate('framesRead', SAMPLE_RATE);

    const recentGlitches = GLITCHES.reduce((n, [k]) => n + (k == 'silentFrames' ? 0 : recent(k)), 0);
    const running = s.ctxState == 'running';
    el.classList.toggle('bad', recentGlitches > 0 || !running);
    summary.textContent =
      `${running ? '♪' : '♪ ' + s.ctxState} · ${total('underruns')} underruns` +
      (recent('underruns') ? ` (+${recent('underruns')})` : '') +
      ` · fill ${Math.round(fillMs)} ms` + (emuSpeed !== null ? ` · ${emuSpeed}%` : '');

    const n = x => x === null || x === undefined ? '-' : x;
    const r = x => Math.round(x);
    const rows = [
      ['Context', `${s.ctxState}, ${s.sampleRate} Hz, latency ${n(s.baseLatencyMs)} + ${n(s.outputLatencyMs)} ms`],
      ['Fill', `${r(fillMs)} ms now, ${r(Math.min(...fills))}–${r(Math.max(...fills))} in ${RECENT_MS / 1000} s, ` +
               `target ${n(s.targetFillMs)}, trim ${n(s.trimFillMs)}`],
      ['Speed', `emulator ${n(emuSpeed)}%, playback ${n(playSpeed)}% (${RECENT_MS / 1000} s)`],
      ...GLITCHES.map(([k, label]) => [label, `${total(k)}` + (recent(k) ? ` (+${recent(k)})` : ''), recent(k) && k != 'silentFrames']),
      ['Late loops', `${total('loopLate')}` + (recent('loopLate') ? ` (+${recent('loopLate')})` : '')],
      ['Worst loop', `gap ${s.loopGapMaxMs} ms, run ${s.runMaxMs} ms (since load)`],
      ['Stream resets', `${total('resets')}`],
    ];
    details.innerHTML = '<table>' + rows.map(([k, v, bad]) =>
      `<tr${bad ? ' class="bad"' : ''}><th>${k}</th><td>${v}</td></tr>`).join('') + '</table>';
  }

  update();
  setInterval(update, UPDATE_MS);
}
