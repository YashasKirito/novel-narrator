// PDF reader page: fetches (or takes a dropped) PDF, rebuilds it as chapters of
// plain paragraphs via pdfextract.js, renders them, then loads the ordinary
// narrator content script on top — so play / highlight / auto-next / export
// all work exactly as on a web-novel site.

import { extractBook, setWorker } from './pdfextract.js';

setWorker(chrome.runtime.getURL('pdf.worker.mjs'));

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const chIndex = Math.max(0, parseInt(params.get('ch') || '0', 10) || 0);
const isLocal = src.startsWith('local:');

const readerUrl = (s, ch) => `reader.html?src=${encodeURIComponent(s)}&ch=${ch}`;

// ---------- theme ----------
const THEME_KEY = 'csn:theme';
function applyTheme() {
  let t = '';
  try { t = localStorage.getItem(THEME_KEY) || ''; } catch {}
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const forced = document.documentElement.dataset.theme;
  const dark = forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  document.documentElement.dataset.theme = next;
}
applyTheme();

// ---------- cache (IndexedDB, extension origin) ----------
const DB = 'csn-pdf', STORE = 'books', MAX_AGE = 30 * 24 * 3600 * 1000;
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
const cacheGet = (key) => withStore('readonly', (s) => s.get(key)).catch(() => null);
const cacheDel = (key) => withStore('readwrite', (s) => s.delete(key)).catch(() => {});
async function cachePut(key, book) {
  await withStore('readwrite', (s) => {
    s.put({ key, savedAt: Date.now(), ...book });
    // prune stale entries
    s.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (c.value.key !== key && Date.now() - (c.value.savedAt || 0) > MAX_AGE) c.delete();
      c.continue();
    };
  }).catch((e) => console.warn('csn: cache write failed', e));
}

// ---------- state panel ----------
const stateEl = $('[data-state]');
function showState({ title, text = '', err = '', progress = null, picker = false }) {
  stateEl.hidden = false;
  $('[data-main]').hidden = true;
  $('[data-state-title]').textContent = title;
  $('[data-state-text]').textContent = text;
  $('[data-state-err]').hidden = !err;
  $('[data-state-err]').textContent = err;
  $('[data-state-bar]').hidden = progress == null;
  $('[data-state-bar] > i').style.width = (progress || 0) + '%';
  $('[data-drop]').hidden = !picker;
}

// ---------- loading ----------
async function fetchPdf(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    showState({ title: 'Downloading PDF…', text: total ? `${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : `${(got / 1048576).toFixed(1)} MB`, progress: total ? (got / total) * 100 : null });
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  return buf;
}

async function parse(bytes, name) {
  showState({ title: 'Reading PDF…', text: 'Extracting text', progress: 0 });
  const book = await extractBook(bytes, {
    name,
    onProgress: (p, n) => showState({ title: 'Reading PDF…', text: `Page ${p} of ${n}`, progress: (p / n) * 100 }),
  });
  if (!book.chapters.length || book.chars < 50) {
    throw new Error('No readable text found in this PDF. Scanned/image-only PDFs need OCR first.');
  }
  return book;
}

function fileKey(f) {
  return `local:${f.name}:${f.size}:${f.lastModified}`;
}

async function openFile(f) {
  try {
    const key = fileKey(f);
    let book = await cacheGet(key);
    if (!book) {
      showState({ title: 'Reading PDF…', text: f.name, progress: 0 });
      book = await parse(new Uint8Array(await f.arrayBuffer()), f.name);
      await cachePut(key, book);
    }
    history.replaceState(null, '', readerUrl(key, 0));
    render(book, key, 0);
  } catch (e) {
    console.error(e);
    showState({ title: "Couldn't read that PDF", err: e.message || String(e), picker: true });
  }
}

async function load() {
  if (!src) {
    showState({ title: 'Open a PDF to narrate', text: 'Tip: on any PDF tab, click the Novel Narrator toolbar icon to open it here.', picker: true });
    return;
  }
  let book = await cacheGet(src);
  if (book && chIndex >= book.chapters.length) book = null;
  if (!book) {
    if (isLocal) {
      const name = src.split(':')[1] || 'the file';
      showState({ title: 'Choose the file again', text: `The extracted text for “${name}” is no longer cached.`, picker: true });
      return;
    }
    try {
      showState({ title: 'Downloading PDF…', text: src, progress: null });
      const bytes = await fetchPdf(src);
      book = await parse(bytes, src);
      await cachePut(src, book);
    } catch (e) {
      console.error(e);
      const hint = src.startsWith('file:')
        ? 'For local files, enable “Allow access to file URLs” for this extension in chrome://extensions, or pick the file below.'
        : 'Pick the file below instead (download it first if needed).';
      showState({ title: "Couldn't open the PDF", text: hint, err: `${src}\n${e.message || e}`, picker: true });
      return;
    }
  }
  render(book, src, Math.min(chIndex, book.chapters.length - 1));
}

// ---------- render ----------
let narratorLoaded = false;
function render(book, key, ch) {
  const chapter = book.chapters[ch];
  const article = $('[data-article]');
  article.textContent = '';
  article.dataset.novel = book.title;
  article.dataset.posId = `${key}#${ch}`;
  const h1 = document.createElement('h1');
  h1.dataset.csnTitle = '1';
  h1.textContent = chapter.title;
  article.appendChild(h1);
  const pg = document.createElement('div');
  pg.className = 'pages';
  pg.textContent = chapter.pageFrom === chapter.pageTo ? `Page ${chapter.pageFrom} of ${book.pages}` : `Pages ${chapter.pageFrom}–${chapter.pageTo} of ${book.pages}`;
  article.appendChild(pg);
  for (const p of chapter.paragraphs) {
    const el = document.createElement(p.kind === 'h' ? 'h2' : 'p');
    el.textContent = p.text;
    article.appendChild(el);
  }

  const prev = $('[data-prev]'), next = $('[data-next]');
  prev.hidden = ch <= 0;
  next.hidden = ch >= book.chapters.length - 1;
  if (!prev.hidden) prev.href = readerUrl(key, ch - 1);
  if (!next.hidden) next.href = readerUrl(key, ch + 1);

  $('[data-book]').textContent = book.title;
  $('[data-meta]').textContent = `${book.chapters.length} chapter${book.chapters.length === 1 ? '' : 's'} · ${book.pages} pages`;
  const sel = $('[data-chapters]');
  sel.textContent = '';
  book.chapters.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${i + 1}. ${c.title}`;
    sel.appendChild(o);
  });
  sel.value = String(ch);
  sel.hidden = book.chapters.length <= 1;
  sel.onchange = () => { location.href = readerUrl(key, +sel.value); };
  const link = $('[data-src]');
  link.hidden = isLocal || key.startsWith('local:');
  if (!link.hidden) link.href = key;
  $('[data-a=reload]').hidden = link.hidden;
  document.title = `${chapter.title} · ${book.title}`;

  stateEl.hidden = true;
  $('[data-main]').hidden = false;
  window.scrollTo(0, 0);

  if (!narratorLoaded) {
    narratorLoaded = true;
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content.js');
    document.body.appendChild(s);
  }
}

// ---------- wiring ----------
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a === 'theme') toggleTheme();
  else if (a === 'open') $('[data-file]').click();
  else if (a === 'reload') cacheDel(src).then(() => location.href = readerUrl(src, chIndex));
});
$('[data-file]').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) openFile(f); });

document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.name) || x.type === 'application/pdf');
  if (f) openFile(f);
  else showState({ title: 'That’s not a PDF', picker: true });
});

load();
