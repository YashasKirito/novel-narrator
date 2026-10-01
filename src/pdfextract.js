// PDF → book: turns pdf.js text items (positioned glyph runs) back into
// paragraphs, drops running headers / footers / page numbers, spots headings,
// and splits the result into chapters the narrator can walk through.
//
// Assumes a single-column layout (novels, articles, ebook exports). Two-column
// papers will read column-interleaved.

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export function setWorker(url) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = url;
}

const CHAPTER_RE = /^(chapter|chap\.?|ch\.?|prologue|prolog|epilogue|epilog|interlude|intermission|afterword|foreword|preface|introduction|part|book|volume|vol\.?|act|episode|ep\.?|arc|side story|extra)\b/i;
const NUMBERED_RE = /^(\d{1,4}|[ivxlc]{1,8})(\s*[:.\-–—]\s*\S.*)?$/i;
const PAGE_NO_RE = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{title:string, pages:number, chars:number, chapters:Array<{title:string, pageFrom:number, pageTo:number, paragraphs:Array<{kind:'p'|'h', text:string, page:number}>}>}>}
 */
export async function extractBook(data, { name = '', onProgress, debug = false } = {}) {
  const task = pdfjsLib.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const pages = doc.numPages;
  const lines = [];
  try {
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      lines.push(...pageLines(tc.items, vp, p));
      page.cleanup();
      onProgress?.(p, pages);
    }
    let metaTitle = '';
    try { metaTitle = (await doc.getMetadata())?.info?.Title || ''; } catch {}
    const title = cleanTitle(metaTitle, name);
    const paragraphs = assemble(lines, pages, debug);
    const chapters = splitChapters(paragraphs, pages, title);
    const chars = paragraphs.reduce((n, p) => n + p.text.length, 0);
    const book = { title, pages, chars, chapters };
    if (debug) book.lines = lines;
    return book;
  } finally {
    task.destroy().catch(() => {});
  }
}

// ---------- lines ----------

const half = (v) => Math.round(v * 2) / 2;

function pageLines(items, vp, page) {
  const spans = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.transform || !it.str.trim()) continue;
    const [a, b, , , x, y] = it.transform;
    const size = Math.hypot(a, b) || it.height || 0;
    if (!size) continue;
    spans.push({ str: it.str, x, y, w: it.width || 0, size });
  }
  // top → bottom (PDF y grows upwards), then cluster by baseline
  spans.sort((p, q) => q.y - p.y);
  const lines = [];
  let cur = null;
  for (const s of spans) {
    if (cur && Math.abs(s.y - cur.y) <= Math.max(s.size, cur.size) * 0.45) cur.items.push(s);
    else { cur = { y: s.y, size: s.size, items: [], page, pw: vp.width, ph: vp.height }; cur.items.push(s); lines.push(cur); }
  }
  for (const ln of lines) {
    ln.items.sort((p, q) => p.x - q.x);
    let text = '', end = null, x0 = Infinity, x1 = -Infinity;
    const sizes = new Map();
    for (const it of ln.items) {
      if (end != null) {
        const gap = it.x - end;
        if (gap < -it.size * 0.6 && text.endsWith(it.str)) continue; // fake-bold double draw
        if (gap > it.size * 0.12 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      end = it.x + it.w;
      x0 = Math.min(x0, it.x);
      x1 = Math.max(x1, end);
      sizes.set(half(it.size), (sizes.get(half(it.size)) || 0) + it.str.length);
    }
    ln.text = text.replace(/\s+/g, ' ').trim();
    ln.x0 = x0;
    ln.x1 = x1;
    ln.size = modeOf(sizes);
    delete ln.items;
  }
  return lines.filter((l) => l.text);
}

function modeOf(map) {
  let best = 0, bestKey = 0;
  for (const [k, v] of map) if (v > best) { best = v; bestKey = k; }
  return bestKey;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------- paragraphs ----------

function assemble(all, pages, debug) {
  if (!all.length) return [];
  const sizeCount = new Map();
  for (const l of all) sizeCount.set(l.size, (sizeCount.get(l.size) || 0) + l.text.length);
  const bodySize = modeOf(sizeCount) || 10;

  // Running headers / footers / page numbers: repeated (digit-normalised) lines.
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const seenOn = new Map();
  for (const l of all) {
    const k = norm(l.text);
    if (!seenOn.has(k)) seenOn.set(k, new Set());
    seenOn.get(k).add(l.page);
  }
  // Running headers / footers sit at the very top or bottom of their page.
  const firstOn = new Map(), lastOn = new Map();
  all.forEach((l, i) => { if (!firstOn.has(l.page)) firstOn.set(l.page, i); lastOn.set(l.page, i); });
  const lines = all.filter((l, i) => {
    const zone = l.y > l.ph * 0.9 || l.y < l.ph * 0.1;
    const edge = firstOn.get(l.page) === i || lastOn.get(l.page) === i;
    const big = l.size >= bodySize * 1.18;
    if (PAGE_NO_RE.test(l.text) && (zone || !big)) return false;
    const n = seenOn.get(norm(l.text)).size;
    if ((zone || edge) && !big && n >= Math.max(3, pages * 0.25) && l.text.length <= 80 && !CHAPTER_RE.test(l.text)) return false;
    return true;
  });
  if (!lines.length) return [];

  // Column geometry from full-width body lines.
  const body = lines.filter((l) => l.size === bodySize && l.text.length >= 50);
  const ref = body.length >= 3 ? body : lines;
  const leftX = modeOf(countBy(ref, (l) => Math.round(l.x0)));
  const rightX = modeOf(countBy(ref, (l) => Math.round(l.x1)));
  const colWidth = Math.max(rightX - leftX, bodySize * 10);
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], l = lines[i];
    if (p.page !== l.page || p.size !== bodySize || l.size !== bodySize) continue;
    const g = p.y - l.y;
    if (g > bodySize * 0.5 && g < bodySize * 3) gaps.push(g);
  }
  const lineGap = median(gaps) || bodySize * 1.2;

  const centered = (l) => {
    const lm = l.x0 - leftX, rm = rightX - l.x1;
    return lm > bodySize && rm > bodySize && Math.abs(lm - rm) < bodySize * 2;
  };
  const indented = (l) => l.x0 - leftX > bodySize * 0.7 && !centered(l);
  const short = (l) => l.x1 - l.x0 < colWidth * 0.6;
  const endsSentence = (t) => /[.!?…"”’'»)\]]$/.test(t);
  const isolated = (i) => {
    const l = lines[i], p = lines[i - 1], n = lines[i + 1];
    const before = !p || p.page !== l.page || p.y - l.y > lineGap * 1.3;
    const after = !n || n.page !== l.page || l.y - n.y > lineGap * 1.3;
    return before && after;
  };
  const heading = (i) => {
    const l = lines[i];
    if (l.size >= bodySize * 1.18 && l.text.length <= 120) return true;
    if ((CHAPTER_RE.test(l.text) || NUMBERED_RE.test(l.text)) && l.text.length <= 80 && short(l) && (isolated(i) || centered(l))) return true;
    return false;
  };

  const paras = [];
  let cur = null, prev = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const head = heading(i);
    let brk = !prev;
    if (prev) {
      const pageBreak = prev.page !== l.page;
      const gap = prev.y - l.y;
      const sizeJump = Math.abs(l.size - prev.size) > bodySize * 0.15;
      brk = head || cur.kind === 'h' || sizeJump || indented(l) ||
        (!pageBreak && gap > lineGap * 1.5) ||
        (endsSentence(prev.text) && short(prev)) ||
        centered(l) !== centered(prev);
      // multi-line heading ("CHAPTER ONE" / "The Awakening")
      if (cur.kind === 'h' && head && !pageBreak && gap <= lineGap * 2.2) brk = false;
    }
    if (brk) {
      cur = { kind: head ? 'h' : 'p', text: l.text, page: l.page };
      paras.push(cur);
    } else {
      const t = cur.text;
      if (/\p{L}[-‐]$/u.test(t) && /^\p{Ll}/u.test(l.text)) cur.text = t.slice(0, -1) + l.text;
      else if (cur.kind === 'h' && head && (CHAPTER_RE.test(t) || NUMBERED_RE.test(t)) && !/[:.\-–—]$/.test(t) && !/\s[:\-–—]\s/.test(t)) cur.text = t + ': ' + l.text;
      else cur.text = t + ' ' + l.text;
    }
    prev = l;
  }
  for (const p of paras) if (p.kind === 'h') p.text = tidyHeading(p.text);
  return paras.filter((p) => /[\p{L}\p{N}]/u.test(p.text));
}

function countBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

function tidyHeading(t) {
  t = t.replace(/\s*[:\-–—]\s*$/, '').trim();
  // ALL-CAPS words → Title Case so the narrator doesn't spell them out (keep roman numerals)
  return t.replace(/\p{Lu}{3,}/gu, (w) => (/^[IVXLC]+$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()));
}

// ---------- chapters ----------

function splitChapters(paras, pages, bookTitle) {
  const chapHead = (p) => p.kind === 'h' && p.text.length <= 100 && (CHAPTER_RE.test(p.text) || /^(\d{1,4}|[ivxlc]{1,8})\b/i.test(p.text));
  let idx = paras.map((p, i) => (chapHead(p) ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) idx = paras.map((p, i) => (p.kind === 'h' && p.text.length <= 100 ? i : -1)).filter((i) => i >= 0);

  let chapters = [];
  if (idx.length >= 2) {
    if (idx[0] > 0) chapters.push({ title: 'Beginning', synthetic: true, paragraphs: paras.slice(0, idx[0]) });
    idx.forEach((at, k) => {
      chapters.push({ title: paras[at].text, paragraphs: paras.slice(at + 1, idx[k + 1] ?? paras.length) });
    });
    chapters = mergeTiny(chapters);
  } else if (pages > 40) {
    // no usable headings: 25-page parts
    const per = 25;
    for (let from = 1; from <= pages; from += per) {
      const to = Math.min(pages, from + per - 1);
      const ps = paras.filter((p) => p.page >= from && p.page <= to);
      if (ps.length) chapters.push({ title: `Pages ${from}–${to}`, paragraphs: ps });
    }
  } else {
    chapters.push({ title: bookTitle, paragraphs: paras });
  }
  for (const c of chapters) {
    c.pageFrom = c.paragraphs[0]?.page ?? 1;
    c.pageTo = c.paragraphs[c.paragraphs.length - 1]?.page ?? c.pageFrom;
  }
  return chapters.filter((c) => c.paragraphs.length);
}

// Chapters with almost no text (front matter, a heading that only carries a
// subtitle) fold into the next real chapter, keeping their heading as text.
function mergeTiny(chapters) {
  const chars = (c) => c.paragraphs.reduce((n, p) => n + p.text.length, 0);
  const flat = (list) => list.flatMap((t) => (t.synthetic ? [] : [{ kind: 'h', text: t.title, page: t.paragraphs[0]?.page }]).concat(t.paragraphs));
  const out = [];
  let pending = [];
  for (const c of chapters) {
    if (chars(c) < 1200) { pending.push(c); continue; }
    if (pending.length) { c.paragraphs = flat(pending).concat(c.paragraphs); pending = []; }
    out.push(c);
  }
  if (pending.length) {
    if (out.length) out[out.length - 1].paragraphs.push(...flat(pending));
    else out.push({ title: pending[0].title, paragraphs: flat(pending).slice(pending[0].synthetic ? 0 : 1) });
  }
  return out;
}

// ---------- misc ----------

function cleanTitle(meta, name) {
  let t = String(meta || '').replace(/^Microsoft Word\s*-\s*/i, '').replace(/\.(docx?|pdf|odt|txt|epub)$/i, '').trim();
  if (!t || /^untitled$/i.test(t) || /^about:|^[a-z]+:\/\//i.test(t)) t = decodeURIComponent(String(name || '').split(/[/\\]/).pop() || '').replace(/\.pdf$/i, '').replace(/[_+]/g, ' ').trim();
  return t || 'PDF';
}
