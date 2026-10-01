import { extractChapter, buildChunks } from './textproc.js';
import { loadSettings, saveSettings, VOICES } from './settings.js';

const AUTOPLAY_KEY = 'csn:autoplay';
const EXPORT_KEY = 'exportJob';
const EXPORT_MAX_AGE = 60 * 60 * 1000;

let chapter, chunks, settings, port, ui;
let siteDisabled = false; // set when the user turns the extension off for this site
let state = { playing: false, ready: false, current: -1, status: 'Idle' };
let engineGen = 0;
const logs = [];
const LOG_MAX = 2000;
function clog(level, text, data) {
  logs.push({ t: new Date().toISOString().slice(11, 23), src: 'page', level, text, data });
  if (logs.length > LOG_MAX) logs.shift();
  ui?.renderLogs?.();
}

async function main() {
  // Chrome's built-in PDF viewer: the text lives inside a plugin we can't read.
  // Tell the background so the toolbar icon offers the PDF reader instead.
  if (document.contentType === 'application/pdf') {
    try { chrome.runtime.sendMessage({ type: 'csn-pdf-page' }); } catch {}
    return;
  }
  try { chrome.runtime.sendMessage({ type: 'csn-alive' }); } catch {}
  settings = await loadSettings();
  injectPageStyles();
  watchNavigation();
  await initChapter();
}

async function initChapter() {
  if (siteDisabled) return;
  for (let i = 0; i < 25; i++) {
    chapter = extractChapter();
    if (chapter && chapter.paragraphs.length) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!chapter || !chapter.paragraphs.length) return;
  chunks = buildChunks(chapter);
  chapter.paragraphs.forEach((p, i) => { try { p.el.dataset.csnPara = i; } catch {} });
  clog('info', 'chapter extracted', { site: chapter.site, title: chapter.title, paragraphs: chapter.paragraphs.length, chunks: chunks.length, next: chapter.nextUrl, version: chrome.runtime.getManifest().version });
  state = { ...state, current: -1 };
  ui = buildUI();
  bindParagraphClicks();

  const stamp = +sessionStorage.getItem(AUTOPLAY_KEY) || 0;
  sessionStorage.removeItem(AUTOPLAY_KEY);
  if (stamp && Date.now() - stamp < 30000) start(0);
  resumeExportIfPending();
}

function teardownChapter() {
  send({ type: 'stop' });
  stopWordTimer();
  wrapped.clear();
  activeEl?.classList.remove('csn-active');
  activeWord?.classList.remove('csn-w-on');
  activeEl = null;
  activeWord = null;
  ui?.destroy();
  ui = null;
  chapter = null;
  chunks = [];
  state = { ...state, playing: false, current: -1, status: 'Idle' };
}

// SPA sites (Bright Novels) navigate without a page load; re-init on URL change.
function watchNavigation() {
  let last = location.href;
  setInterval(() => {
    if (siteDisabled || location.href === last) return;
    last = location.href;
    clog('info', 'navigation detected', location.href);
    teardownChapter();
    initChapter();
  }, 700);
}

// ---------- messaging ----------

async function connect() {
  if (port) return port;
  const res = await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
  if (!res?.ok) throw new Error(res?.error || 'offscreen failed');
  port = chrome.runtime.connect({ name: 'csn-reader' });
  port.onMessage.addListener(onEngineMessage);
  clog('info', 'connected to engine');
  port.onDisconnect.addListener(() => {
    clog('warn', 'engine port disconnected (offscreen document closed or extension reloaded)', chrome.runtime.lastError?.message);
    port = null;
    if (state.exporting) setState({ exporting: false, exportText: null, status: 'Export lost: engine closed' });
    setState({ playing: false, ready: false, status: 'Engine disconnected' });
  });
  return port;
}

function send(msg) {
  if (port) port.postMessage(msg);
}

function onEngineMessage(msg) {
  switch (msg.type) {
    case 'log':
      logs.push({ t: '+' + (msg.t / 1000).toFixed(2) + 's', src: 'engine', level: msg.level, text: msg.text, data: msg.data });
      if (logs.length > LOG_MAX) logs.shift();
      ui?.renderLogs?.();
      break;
    case 'status':
      setState({ status: msg.text, ready: msg.ready ?? state.ready, progress: msg.progress });
      break;
    case 'chunk':
      setState({ current: msg.index, playing: true, status: 'Reading · ' + (msg.engine || '') });
      highlight(msg.index);
      startWordTimer(msg.index, msg.dur);
      savePosition(msg.index);
      break;
    case 'state':
      setState({ playing: msg.playing });
      if (!msg.playing) stopWordTimer();
      break;
    case 'ended':
      stopWordTimer();
      setState({ playing: false, status: 'Chapter finished' });
      clearPosition();
      clog('info', 'chapter ended', { autoNext: settings.autoNext, next: chapter.nextUrl || (chapter.nextEl ? 'button' : null) });
      if (settings.autoNext && (chapter.nextUrl || chapter.nextEl)) {
        sessionStorage.setItem(AUTOPLAY_KEY, String(Date.now()));
        setState({ status: 'Next chapter…' });
        setTimeout(gotoNext, 600);
      }
      break;
    case 'error':
      setState({ playing: false, status: 'Error: ' + msg.text });
      clog('error', 'engine error', msg.text);
      break;
    case 'export-progress':
      setState({ exporting: true, exportText: `Exporting ch ${msg.chapter}/${msg.chapters} · ${msg.pct}% · ${(msg.seconds / 60).toFixed(1)} min audio · ~${fmtEta(msg.eta)} left`, exportPct: msg.pct });
      break;
    case 'export-done':
      clog('info', 'export done', { filename: msg.filename, MB: +(msg.bytes / 1048576).toFixed(1), minutes: +(msg.seconds / 60).toFixed(1) });
      setState({ exporting: false, exportText: null, status: `Saved ${msg.filename} (${(msg.bytes / 1048576).toFixed(1)} MB)` });
      break;
    case 'export-cancelled':
      setState({ exporting: false, exportText: null, status: 'Export cancelled' });
      break;
    case 'export-error':
      clog('error', 'export error', msg.text);
      setState({ exporting: false, exportText: null, status: 'Export failed: ' + msg.text });
      break;
  }
}

// ---------- control ----------

async function start(fromIndex) {
  try {
    await connect();
    setState({ status: 'Starting engine…' });
    send({ type: 'play', gen: ++engineGen, chunks, startIndex: fromIndex, settings, title: chapter.title });
  } catch (e) {
    clog('error', 'start failed: ' + e.message, e.stack);
    setState({ status: 'Error: ' + e.message });
  }
}

async function togglePlay() {
  if (!port || !state.ready) {
    const saved = await getSavedPosition();
    return start(saved != null && saved < chunks.length - 1 ? saved : 0);
  }
  send({ type: state.playing ? 'pause' : 'resume' });
}

function seekChunk(index) {
  index = Math.max(0, Math.min(chunks.length - 1, index));
  if (!port || !state.ready) return start(index);
  send({ type: 'seek', index });
}

function seekParagraphDelta(delta) {
  const cur = chunks[state.current] || chunks[0];
  let target = cur.para + delta;
  const found = chunks.find((c) => c.para === target) || (delta < 0 ? chunks[0] : chunks[chunks.length - 1]);
  seekChunk(found.index);
}

function applySettings(patch) {
  clog('info', 'settings changed', patch);
  settings = { ...settings, ...patch };
  saveSettings(settings);
  send({ type: 'settings', settings });
}

// ---------- export (multi-chapter MP3) ----------

function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return '?';
  return sec < 90 ? `${sec}s` : `${Math.round(sec / 60)} min`;
}

function safeName(str) {
  return String(str).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function gotoNext() {
  if (chapter?.nextUrl) location.href = chapter.nextUrl;
  else if (chapter?.nextEl) chapter.nextEl.click(); // SPA router button (Novelpia)
}

// origin+path is enough to recognise a chapter page; the PDF reader keeps its
// chapter in the query string, so keep that there.
const normUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, '') + (x.protocol === 'chrome-extension:' ? x.search : '');
  } catch { return u; }
};

// Export = visit each chapter page in turn (real navigations, so Cloudflare sees a
// normal reader), collect text into chrome.storage, then synthesize once at the end.
async function startExport(count) {
  if (state.exporting) return;
  count = Math.max(1, Math.min(200, Math.floor(count) || 1));
  const job = { total: count, novel: chapter.novel || '', site: chapter.site, startedAt: Date.now(), chapters: [], expected: null };
  clog('info', 'export: start', { total: count, from: chapter.title });
  await appendAndContinue(job);
}

async function resumeExportIfPending() {
  const { [EXPORT_KEY]: job } = await chrome.storage.local.get(EXPORT_KEY);
  if (!job) return;
  if (Date.now() - job.startedAt > EXPORT_MAX_AGE) {
    clog('warn', 'export: stale job discarded', { chapters: job.chapters.length, total: job.total });
    return chrome.storage.local.remove(EXPORT_KEY);
  }
  const here = normUrl(location.href);
  const ok = job.expected
    ? here === job.expected
    : here !== job.fromUrl && !(job.collected || []).includes(here); // button-nav sites: any new chapter page on this host
  if (!ok) {
    clog('warn', 'export: landed on a different page than expected, cancelling', { expected: job.expected ?? '(next via button)', from: job.fromUrl, got: here });
    setState({ status: 'Export cancelled (navigated away)' });
    return chrome.storage.local.remove(EXPORT_KEY);
  }
  clog('info', 'export: resumed on chapter', { n: job.chapters.length + 1, total: job.total, title: chapter.title });
  await appendAndContinue(job);
}

async function appendAndContinue(job) {
  job.chapters.push({ title: chapter.title, chunks });
  job.collected = (job.collected || []).concat(normUrl(location.href));
  const n = job.chapters.length;
  const hasNext = chapter.nextUrl || chapter.nextEl;
  if (n >= job.total || !hasNext) {
    if (n < job.total) clog('warn', 'export: no next chapter link, finishing with ' + n);
    await chrome.storage.local.remove(EXPORT_KEY);
    return finishExport(job);
  }
  job.expected = chapter.nextUrl ? normUrl(chapter.nextUrl) : null; // null = next via SPA button
  job.fromUrl = normUrl(location.href);
  await chrome.storage.local.set({ [EXPORT_KEY]: job });
  setState({ exporting: true, exportPct: Math.round((n / job.total) * 100), exportText: `Collecting chapter ${n}/${job.total} · opening next…` });
  clog('info', 'export: collected, navigating', { n, total: job.total, next: chapter.nextUrl || 'button' });
  send({ type: 'stop' });
  setTimeout(gotoNext, 1200);
}

async function finishExport(job) {
  const list = job.chapters;
  const first = safeName(list[0].title), last = safeName(list[list.length - 1].title);
  const filename = safeName(job.novel || location.hostname) + ' - ' + (list.length > 1 ? `${first} to ${last}` : first) + '.mp3';
  const totalChars = list.reduce((s, c) => s + c.chunks.reduce((a, k) => a + k.text.length, 0), 0);
  clog('info', 'export: all chapters collected, sending to engine', { chapters: list.length, chars: totalChars, estMinutes: Math.round(totalChars / 900), filename });
  setState({ exporting: true, exportPct: 0, exportText: `Synthesizing ${list.length} chapter(s)…` });
  try {
    await connect();
    send({ type: 'export', chapters: list, settings, filename });
  } catch (e) {
    clog('error', 'export: engine connect failed', e.message);
    setState({ exporting: false, exportText: null, status: 'Error: ' + e.message });
  }
}

async function cancelExport() {
  await chrome.storage.local.remove(EXPORT_KEY);
  send({ type: 'export-cancel' });
  clog('info', 'export: cancelled by user');
  setState({ exporting: false, exportText: null, status: 'Export cancelled' });
}

// ---------- persistence ----------

// PDF reader chapters all share one pathname, so they carry their own id.
const posKey = () => 'pos:' + (chapter?.posId || location.pathname);
let posTimer;
function savePosition(i) {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => chrome.storage.local.set({ [posKey()]: i }), 500);
}
async function getSavedPosition() {
  const r = await chrome.storage.local.get(posKey());
  return r[posKey()];
}
function clearPosition() {
  chrome.storage.local.remove(posKey());
}

// ---------- page highlight ----------

let activeEl = null;
function highlight(index) {
  const c = chunks[index];
  if (!c) return;
  const el = c.para >= 0 ? chapter.paragraphs[c.para]?.el : chapter.titleEl;
  if (el === activeEl) return;
  activeEl?.classList.remove('csn-active');
  activeWord?.classList.remove('csn-w-on');
  activeEl = el;
  if (el) {
    el.classList.add('csn-active');
    if (settings.autoScroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ---------- word-level highlight ----------
// Kokoro gives no word timestamps; we spread the (silence-trimmed) chunk duration
// across its words weighted by length and punctuation. Good to ~100ms.

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
const wrapped = new Map(); // paragraph el -> [span]
let activeWord = null, wordRaf = 0;

function wrapWords(el) {
  if (wrapped.has(el)) return wrapped.get(el);
  const spans = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement.closest('.cs-copy-watermark, .cs-paragraph-comment-trigger, button, script, style')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    let last = 0, m, frag = null;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      frag ??= document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const sp = document.createElement('span');
      sp.className = 'csn-w';
      sp.textContent = m[0];
      frag.appendChild(sp);
      spans.push(sp);
      last = m.index + m[0].length;
    }
    if (!frag) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  wrapped.set(el, spans);
  return spans;
}

function chunkWords(text) {
  return text.match(WORD_RE) || [];
}

function wordWeight(word, follow) {
  let w = 0.9 + word.length * 0.55; // rough syllable proxy
  if (/[.!?]/.test(follow)) w += 3.2;
  else if (/[,;:]/.test(follow)) w += 1.6;
  else if (/\.\.\./.test(follow)) w += 3.5;
  return w;
}

/** Word timing table for a chunk: [{span, at}] with `at` in seconds from chunk start. */
function wordTimeline(index, dur) {
  const c = chunks[index];
  const el = c.para >= 0 ? chapter.paragraphs[c.para]?.el : chapter.titleEl;
  if (!el) return null;
  const spans = wrapWords(el);
  // words of this chunk + its position among all chunks of the same paragraph
  const sameParaBefore = chunks.filter((x) => x.para === c.para && x.index < c.index);
  const offset = sameParaBefore.reduce((n, x) => n + chunkWords(x.text).length, 0);
  const words = chunkWords(c.text);
  if (!words.length) return null;
  // sanity: paragraph DOM words should match total chunk words; if not, bail to paragraph-only highlight
  const total = chunks.filter((x) => x.para === c.para).reduce((n, x) => n + chunkWords(x.text).length, 0);
  if (Math.abs(total - spans.length) > Math.max(2, total * 0.1)) return null;

  const weights = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(c.text))) {
    const follow = c.text.slice(m.index + m[0].length, m.index + m[0].length + 3);
    weights.push(wordWeight(m[0], follow));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return words.map((w, i) => {
    const at = (acc / sum) * dur;
    acc += weights[i];
    return { span: spans[offset + i], at };
  }).filter((x) => x.span);
}

function startWordTimer(index, dur) {
  stopWordTimer();
  if (!settings.wordHighlight || !dur) return;
  const tl = wordTimeline(index, dur);
  if (!tl) return;
  const t0 = performance.now();
  let k = 0;
  const tick = () => {
    const t = (performance.now() - t0 - (Number(settings.wordOffset) || 0)) / 1000;
    while (k < tl.length && tl[k].at <= t) {
      activeWord?.classList.remove('csn-w-on');
      activeWord = tl[k].span;
      activeWord.classList.add('csn-w-on');
      k++;
    }
    if (k < tl.length) wordRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopWordTimer() {
  cancelAnimationFrame(wordRaf);
  wordRaf = 0;
}

function injectPageStyles() {
  if (document.getElementById('csn-styles')) return;
  const s = document.createElement('style');
  s.id = 'csn-styles';
  s.textContent = `
    .csn-active {
      background: rgba(224,160,64,.14); box-shadow: -6px 0 0 0 rgba(224,160,64,.9);
      border-radius: 4px; transition: background .25s;
    }
    .csn-w-on { background: rgba(224,160,64,.55); border-radius: 3px; box-shadow: 0 0 0 2px rgba(224,160,64,.55); color: inherit; }
    [data-csn-para] { cursor: pointer; }
    body[data-csn-open] { padding-bottom: 92px !important; }
  `;
  document.head.appendChild(s);
}

function bindParagraphClicks() {
  chapter.container?.addEventListener('click', (e) => {
    if (!ui) return;
    if (e.target.closest('a, button, ins, iframe')) return;
    const p = e.target.closest('[data-csn-para]');
    if (!p) return;
    const pi = +p.dataset.csnPara;
    const chunk = chunks.find((c) => c.para === pi);
    if (chunk) seekChunk(chunk.index);
  });
}

// ---------- UI ----------

function setState(patch) {
  state = { ...state, ...patch };
  ui?.render();
}

function buildUI() {
  const host = document.createElement('div');
  host.id = 'csn-host';
  // Some sites (Novel Live) bind document-level hotkeys (arrows / A / D flip
  // chapters); keep keystrokes inside the player from reaching the page.
  for (const t of ['keydown', 'keyup', 'keypress']) {
    host.addEventListener(t, (e) => e.stopPropagation());
  }
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
        z-index: 2147483000; display: flex; align-items: center; gap: 8px;
        background: #1b1b1f; color: #eee; border: 1px solid #3a3a44; border-radius: 14px;
        padding: 8px 12px; font: 13px/1.3 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.5);
        max-width: calc(100vw - 24px); box-sizing: border-box;
      }
      button { background: #2a2a31; color: #eee; border: 1px solid #44444f; border-radius: 9px;
        padding: 6px 10px; cursor: pointer; font: inherit; }
      button:hover { background: #363640; }
      button.play { background: #c8433c; border-color: #c8433c; font-weight: 600; min-width: 74px; }
      button.play:hover { background: #d9524b; }
      .status { min-width: 160px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bbb; }
      .status b { color: #fff; font-weight: 600; }
      .bar.min .status, .bar.min .nav, .bar.min .gear { display: none; }
      .panel { position: fixed; left: 50%; bottom: 70px; transform: translateX(-50%); z-index: 2147483000;
        background: #1b1b1f; color: #eee; border: 1px solid #3a3a44; border-radius: 14px; padding: 12px 14px;
        font: 13px system-ui, sans-serif; display: grid; grid-template-columns: auto auto; gap: 8px 12px;
        align-items: center; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
      .panel[hidden] { display: none; }
      select, input[type=range] { font: inherit; background: #2a2a31; color: #eee; border: 1px solid #44444f; border-radius: 7px; padding: 4px 6px; }
      label { color: #bbb; }
      .prog { position: absolute; left: 12px; right: 12px; bottom: 3px; height: 2px; background: #333; border-radius: 2px; overflow: hidden; }
      .prog > i { display: block; height: 100%; background: #e0a040; width: 0; transition: width .2s; }
      .ic { font-size: 14px; }
      .logs { position: fixed; right: 12px; bottom: 70px; width: min(640px, calc(100vw - 24px)); height: 46vh; z-index: 2147483000;
        background: #121216; color: #ddd; border: 1px solid #3a3a44; border-radius: 12px; display: flex; flex-direction: column;
        font: 11.5px/1.45 ui-monospace, Menlo, monospace; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
      .logs[hidden] { display: none; }
      .logs header { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #2a2a31; font-family: system-ui, sans-serif; font-size: 12px; }
      .logs header span { flex: 1; color: #999; }
      .logs pre { flex: 1; margin: 0; padding: 8px 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
      .l-warn { color: #e8b54a; } .l-error { color: #ff6b6b; } .l-src { color: #6a8; } .l-t { color: #777; }
    </style>
    <div class="logs" hidden>
      <header><b>Novel Narrator logs</b><span data-logcount></span>
        <button data-a="copylogs">Copy</button><button data-a="clearlogs">Clear</button><button data-a="closelogs">✕</button></header>
      <pre data-logs></pre>
    </div>
    <div class="panel" hidden>
      <label>Narrator</label><select data-k="narratorVoice"></select>
      <label>Dialogue voice</label><select data-k="dialogueVoice"></select>
      <label>【System】 voice</label><select data-k="systemVoice"></select>
      <label>Speed <span data-speedval></span></label><input type="range" min="0.7" max="1.6" step="0.05" data-k="speed">
      <label>Engine</label><select data-k="device"><option value="auto">Auto</option><option value="webgpu">WebGPU</option><option value="wasm">CPU (WASM)</option></select>
      <label>Auto-next chapter</label><input type="checkbox" data-k="autoNext">
      <label>Auto-scroll</label><input type="checkbox" data-k="autoScroll">
      <label>Highlight words</label><input type="checkbox" data-k="wordHighlight">
      <label>Word sync <span data-offsetval></span></label><input type="range" min="-600" max="600" step="10" data-k="wordOffset" title="Negative = highlight earlier, positive = later">
      <label style="grid-column:1/-1;color:#888;font-size:11px">Voice/engine changes apply from the current sentence. Click any paragraph to jump there. Alt+P = play/pause.</label>
    </div>
    <div class="panel dl" hidden>
      <label>Chapters to include<br><small style="color:#888">starting from this one</small></label>
      <input type="number" min="1" max="200" step="1" value="5" data-dlcount style="width:80px">
      <label style="grid-column:1/-1;color:#888;font-size:11px">The extension visits each chapter page in turn (you'll see it navigate), collects the text, then synthesizes one MP3 at the end with the current voices &amp; speed. Playback stops while collecting. ~1 min of audio per 900 characters; synthesis ≈7× realtime on GPU. You can keep reading while it synthesizes.</label>
      <button data-a="dlstart" style="grid-column:1/-1;background:#c8433c;border-color:#c8433c;font-weight:600">Start download</button>
      <button data-a="dlcancel" style="grid-column:1/-1" hidden>Cancel export</button>
      <div data-dlstatus style="grid-column:1/-1;color:#bbb;font-size:12px"></div>
    </div>
    <div class="bar">
      <button class="play" data-a="toggle">▶ Play</button>
      <span class="nav"><button data-a="prev" title="Previous paragraph">⏮</button>
      <button data-a="next" title="Next paragraph">⏭</button></span>
      <span class="status"><b data-title></b> <span data-status></span></span>
      <button class="gear" data-a="gear" title="Settings">⚙</button>
      <button data-a="dl" title="Download chapters as one MP3">⬇</button>
      <button data-a="logs" title="Logs">📋</button>
      <button data-a="min" title="Minimise">—</button>
      <button data-a="close" title="Close and stop">✕</button>
      <div class="prog"><i data-prog></i></div>
    </div>`;

  const bar = root.querySelector('.bar');
  const panel = root.querySelector('.panel');
  const logbox = root.querySelector('.logs');
  const dlbox = root.querySelector('.panel.dl');
  const fmtLogs = () => {
    const head = `Novel Narrator v${chrome.runtime.getManifest().version} — ${location.href}\nUA: ${navigator.userAgent}\nsettings: ${JSON.stringify(settings)}\n`;
    return head + logs.map((l) => `${l.t} [${l.src}] ${l.level.toUpperCase()} ${l.text}${l.data !== undefined ? ' ' + (typeof l.data === 'string' ? l.data : JSON.stringify(l.data)) : ''}`).join('\n');
  };
  const $ = (s) => root.querySelector(s);

  // voice selects
  const fill = (sel, extra) => {
    (extra || []).concat(VOICES).forEach(([v, n]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = n; sel.appendChild(o);
    });
  };
  fill($('[data-k=narratorVoice]'));
  fill($('[data-k=dialogueVoice]'), [['same', 'Same as narrator']]);
  fill($('[data-k=systemVoice]'), [['same', 'Same as narrator']]);

  root.querySelectorAll('[data-k]').forEach((inp) => {
    const k = inp.dataset.k;
    if (inp.type === 'checkbox') inp.checked = !!settings[k];
    else inp.value = settings[k];
    const onChange = () => {
      const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? parseFloat(inp.value) : inp.value;
      applySettings({ [k]: v });
      ui.render();
    };
    inp.addEventListener('change', onChange);
    if (k === 'wordOffset') inp.addEventListener('input', () => { settings.wordOffset = parseFloat(inp.value); ui.render(); });
  });

  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'toggle') togglePlay();
    else if (a === 'prev') seekParagraphDelta(-1);
    else if (a === 'next') seekParagraphDelta(1);
    else if (a === 'gear') { panel.hidden = !panel.hidden; dlbox.hidden = true; }
    else if (a === 'logs') { logbox.hidden = !logbox.hidden; api.renderLogs(); }
    else if (a === 'dl') { dlbox.hidden = !dlbox.hidden; panel.hidden = true; }
    else if (a === 'dlstart') startExport(parseInt($('[data-dlcount]').value, 10));
    else if (a === 'dlcancel') cancelExport();
    else if (a === 'closelogs') logbox.hidden = true;
    else if (a === 'clearlogs') { logs.length = 0; api.renderLogs(); }
    else if (a === 'copylogs') {
      const txt = fmtLogs();
      navigator.clipboard.writeText(txt).then(() => { $('[data-a=copylogs]').textContent = 'Copied!'; setTimeout(() => ($('[data-a=copylogs]').textContent = 'Copy'), 1200); },
        () => { const ta = document.createElement('textarea'); ta.value = txt; root.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); });
    }
    else if (a === 'min') bar.classList.toggle('min');
    else if (a === 'close') { send({ type: 'stop' }); stopWordTimer(); activeEl?.classList.remove('csn-active'); activeWord?.classList.remove('csn-w-on'); api.destroy(); ui = null; }
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyP') { e.preventDefault(); togglePlay(); }
  });

  document.body.appendChild(host);
  document.body.setAttribute('data-csn-open', '1');

  const api = {
    destroy() {
      host.remove();
      document.body.removeAttribute('data-csn-open');
    },
    renderLogs() {
      if (logbox.hidden) return;
      const pre = $('[data-logs]');
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      pre.innerHTML = logs.slice(-400).map((l) => {
        const d = l.data !== undefined ? ' ' + (typeof l.data === 'string' ? l.data : JSON.stringify(l.data)) : '';
        const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        return `<span class="l-t">${esc(l.t)}</span> <span class="l-src">[${l.src}]</span> <span class="l-${l.level}">${esc(l.text)}${esc(d)}</span>`;
      }).join('\n');
      $('[data-logcount]').textContent = logs.length + ' entries';
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    },
    render() {
      $('[data-a=dlstart]').hidden = !!state.exporting;
      $('[data-a=dlcancel]').hidden = !state.exporting;
      $('[data-dlstatus]').textContent = state.exportText || '';
      $('[data-a=dl]').textContent = state.exporting ? `⬇ ${state.exportPct ?? 0}%` : '⬇';
      $('[data-a=toggle]').textContent = state.playing ? '⏸ Pause' : state.ready ? '▶ Resume' : '▶ Play';
      $('[data-title]').textContent = chapter.title.length > 40 ? chapter.title.slice(0, 38) + '…' : chapter.title;
      const pos = state.current >= 0 ? ` · ${Math.round(((state.current + 1) / chunks.length) * 100)}%` : '';
      $('[data-status]').textContent = (state.exporting && state.exportText ? state.exportText : state.status + pos);
      $('[data-speedval]').textContent = Number(settings.speed).toFixed(2) + '×';
      const off = Number(settings.wordOffset) || 0;
      $('[data-offsetval]').textContent = (off > 0 ? '+' : '') + off + ' ms' + (off < 0 ? ' (earlier)' : off > 0 ? ' (later)' : '');
      const p = state.progress != null ? state.progress : state.current >= 0 ? ((state.current + 1) / chunks.length) * 100 : 0;
      $('[data-prog]').style.width = p + '%';
    },
  };
  api.render();
  return api;
}

// Guard against double injection (manifest + dynamic registration, or the
// toolbar toggle firing on a page that already has the script).
if (!window.__csnLoaded) {
  window.__csnLoaded = true;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'csn-teardown') {
      siteDisabled = true;
      window.__csnLoaded = false;
      try { teardownChapter(); } catch {}
    }
  });
  main();
}
