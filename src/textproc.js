// Chapter extraction + text preparation for web-novel pages and PDFs.

const STRIP_SELECTOR =
  '.cs-copy-watermark, .cs-paragraph-comment-trigger, script, style, ins, iframe, svg, button';

// ---------- site adapters ----------

const crimsonScrolls = {
  hosts: ['crimsonscrolls.net'],
  extract(doc) {
    const article = doc.querySelector('article.cs-reader');
    if (!article) return null;
    const novel = doc.querySelector('.cs-reader-title p')?.textContent?.trim() || '';
    const titleEl = doc.querySelector('.cs-reader-title h1');
    const title = titleEl?.textContent?.trim() || doc.title;
    const nextUrl =
      doc.querySelector('link[rel="next"]')?.href ||
      doc.querySelector('a.cs-reader-control-next[href]')?.href || null;
    const prevUrl = doc.querySelector('a.cs-reader-control-previous[href]')?.href || null;
    const paragraphs = [];
    article.querySelectorAll(':scope > p, :scope > h2, :scope > h3, :scope > blockquote').forEach((el) => {
      if (el.closest('.cs-chapter-ad, .cs-reader-title, .cs-reader-end-watermark')) return;
      const clone = el.cloneNode(true);
      clone.querySelectorAll(STRIP_SELECTOR).forEach((n) => n.remove());
      let text = clone.textContent.replace(/\s+/g, ' ').trim();
      text = text.replace(/Read on CrimsonScrolls\.net\s*#\w+/gi, '').trim();
      if (text) paragraphs.push({ el, text });
    });
    return { site: 'crimsonscrolls', container: article, titleEl, novel, title, nextUrl, prevUrl, paragraphs };
  },
};

// Bright Novels: Vue/Inertia SPA; the chapter body is one big <p> with <br><br>
// between paragraphs. We wrap each run in an inline span (layout unchanged)
// so highlighting has real elements to target.
function splitBrParagraphs(container) {
  if (container.dataset.csnSplit) return;
  container.dataset.csnSplit = '1';
  container.querySelectorAll('p').forEach(splitBrBlock);
}

function splitBrBlock(p) {
  {
    const nodes = [...p.childNodes];
    const groups = [];
    let cur = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeName === 'BR') {
        let j = i, brs = 0;
        while (j < nodes.length && (nodes[j].nodeName === 'BR' || (nodes[j].nodeType === 3 && !nodes[j].nodeValue.trim()))) {
          if (nodes[j].nodeName === 'BR') brs++;
          j++;
        }
        if (brs >= 2) { groups.push(cur); cur = []; i = j - 1; continue; }
      }
      cur.push(n);
    }
    groups.push(cur);
    if (groups.length <= 1) {
      if (p.textContent.trim()) p.classList.add('csn-para');
      return;
    }
    const frag = document.createDocumentFragment();
    groups.forEach((g, gi) => {
      if (gi > 0) { frag.appendChild(document.createElement('br')); frag.appendChild(document.createElement('br')); }
      if (g.some((n) => n.textContent.trim())) {
        const span = document.createElement('span');
        span.className = 'csn-para';
        g.forEach((n) => span.appendChild(n));
        frag.appendChild(span);
      } else g.forEach((n) => frag.appendChild(n));
    });
    p.textContent = '';
    p.appendChild(frag);
  }
}

const brightNovels = {
  hosts: ['brightnovels.com'],
  extract(doc) {
    const container = doc.querySelector('.chapter-content');
    if (!container) return null;
    splitBrParagraphs(container);
    const paragraphs = [];
    container.querySelectorAll('.csn-para').forEach((el) => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push({ el, text });
    });
    const titleEl = doc.querySelector('main h1');
    const title = doc.querySelector('span[data-slot="select-value"]')?.textContent?.trim() ||
      titleEl?.textContent?.trim() || doc.title;
    const novel = [...doc.querySelectorAll('main a[href*="/series/"]')][0]?.textContent?.trim() || '';
    const links = [...doc.querySelectorAll('a[data-slot="button"]')];
    const nextUrl = links.find((a) => /\bnext\b/i.test(a.textContent))?.href || null;
    const prevUrl = links.find((a) => /\bprev/i.test(a.textContent))?.href || null;
    return { site: 'brightnovels', container, titleEl, novel, title, nextUrl, prevUrl, paragraphs };
  },
};


// Novelpia (global): Nuxt SPA viewer. Body is several #book-content blocks of
// <p data-chunk-index> paragraphs; "Next Chapter" is a router button, not a link,
// so we expose nextEl (to click) instead of a nextUrl.
const novelpia = {
  hosts: ['global.novelpia.com'],
  extract(doc) {
    if (!/^\/viewer\//.test(doc.location?.pathname || location.pathname)) return null;
    const container = doc.querySelector('#book-box');
    if (!container) return null;
    const paragraphs = [];
    container.querySelectorAll('#book-content p').forEach((el) => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push({ el, text });
    });
    const titleEl = doc.querySelector('.viewer-ep-tit');
    let title = titleEl?.textContent?.replace(/\s+/g, ' ').trim() || doc.title;
    title = title.replace(/^Ch\.?\s*(\d+)\s*\)?\s*[:.-]?\s*/i, 'Chapter $1: ');
    const novel = (doc.querySelector('meta[property="og:site_name"]')?.content || doc.title || '')
      .replace(/^Novelpia\s*-\s*/i, '').trim();
    const nextEl = [...doc.querySelectorAll('.next-epi-btn, .viewer-btn.next')]
      .find((b) => !b.classList.contains('disabled')) || null;
    const prevEl = [...doc.querySelectorAll('.viewer-bottom .viewer-btn')]
      .find((b) => /prev/i.test(b.textContent) && !b.classList.contains('disabled')) || null;
    return { site: 'novelpia', container, titleEl, novel, title, nextUrl: null, nextEl, prevUrl: null, prevEl, paragraphs };
  },
};

// Novel Live: classic server-rendered reader. Chapter body is .m-read .txt
// with direct <p> children mixed with ad <div>s; hidden <sub> spans carry
// anti-copy junk. Next/Prev are plain links (#next/#prev); at the ends the
// site points them at an href containing "reload", which means "no chapter".
const novelLive = {
  hosts: ['novellive.app'],
  extract(doc) {
    const path = doc.location?.pathname || location.pathname;
    if (!/^\/book\/[^/]+\/[^/]+/.test(path)) return null;
    const container = doc.querySelector('.m-read .txt');
    if (!container) return null;
    const paragraphs = [];
    container.querySelectorAll(':scope > p').forEach((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(STRIP_SELECTOR + ', sub').forEach((n) => n.remove());
      const text = clone.textContent.replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (/visit and read more novel to help us/i.test(text)) return;
      paragraphs.push({ el, text });
    });
    const titleEl = doc.querySelector('.m-read .top .chapter');
    const title =
      titleEl?.textContent?.replace(/\s+/g, ' ').trim() ||
      doc.querySelector('meta[property="og:novel:chapter_name"]')?.content?.trim() ||
      doc.title;
    const novel =
      doc.querySelector('meta[property="og:novel:novel_name"]')?.content?.trim() ||
      doc.querySelector('.m-read h1.tit a')?.textContent?.trim() || '';
    const chapterLink = (a) => {
      const href = a?.getAttribute('href');
      return href && !/reload/i.test(href) ? a.href : null;
    };
    const nextUrl =
      chapterLink(doc.querySelector('a#next')) ||
      chapterLink(doc.querySelector('.m-read a[title="Read Next Chapter"]'));
    const prevUrl =
      chapterLink(doc.querySelector('a#prev')) ||
      chapterLink(doc.querySelector('.m-read a[title="Read Privious Chapter"]'));
    return { site: 'novellive', container, titleEl, novel, title, nextUrl, prevUrl, paragraphs };
  },
};

// WTR-LAB: Next.js infinite reader — several chapters sit in the DOM at once
// as .chapter-tracker blocks, so pick the one matching the URL's chapter
// number. Lines are .wtr-line divs (nested term-patch spans read fine via
// textContent). Next/Prev are router buttons, not links.
const wtrLab = {
  hosts: ['wtr-lab.com'],
  extract(doc) {
    const path = doc.location?.pathname || location.pathname;
    const m = path.match(/\/novel\/\d+\/[^/]+\/chapter-(\d+)/i);
    if (!m) return null;
    const tracker =
      doc.querySelector(`.chapter-tracker[data-chapter-no="${m[1]}"]`) ||
      doc.querySelector('.chapter-tracker.active') ||
      doc.querySelector('.chapter-tracker');
    const container = tracker?.querySelector('.chapter-body');
    if (!container) return null;
    const paragraphs = [];
    container.querySelectorAll('.wtr-line').forEach((el) => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push({ el, text });
    });
    // Header: <span class="text-2xl"><b>#31</b>Chapter 31 ...</span>
    let titleEl = tracker.querySelector('.chapter-container > span.text-2xl');
    let title = '';
    if (titleEl) {
      const clone = titleEl.cloneNode(true);
      clone.querySelector('b')?.remove();
      title = clone.textContent.replace(/\s+/g, ' ').trim();
    }
    // Body line 0 usually repeats the heading with better punctuation
    // ("Chapter 31: Su Qingyu Visits") — prefer it and drop the duplicate line.
    const strip = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (paragraphs.length && /^chapter\s*\d/i.test(paragraphs[0].text) &&
        (!title || strip(paragraphs[0].text) === strip(title))) {
      title = paragraphs[0].text;
      titleEl = paragraphs[0].el;
      paragraphs.shift();
    }
    if (!title) title = doc.title;
    title = title.replace(/^Chapter\s+(\d+)\s+(?=[A-Za-z])/i, 'Chapter $1: ');
    const novel =
      doc.querySelector('nav[aria-label="breadcrumb"] a span')?.textContent?.trim() ||
      (doc.title || '').replace(/\s+Chapter\s+\d+.*$/i, '').trim();
    const btns = [...doc.querySelectorAll('button')];
    const nextEl = btns.find((b) => /^\s*next\s*$/i.test(b.textContent) && !b.disabled) || null;
    const prevEl = btns.find((b) => /^\s*prev(ious)?\s*$/i.test(b.textContent) && !b.disabled) || null;
    return { site: 'wtrlab', container, titleEl, novel, title, nextUrl: null, nextEl, prevUrl: null, prevEl, paragraphs };
  },
};

// The extension's own PDF reader page (reader.html): pdfextract.js has already
// rebuilt the chapter as plain <p>/<h2> blocks inside <article data-csn-pdf>.
const pdfReader = {
  match: (doc) => !!doc.querySelector('article[data-csn-pdf]'),
  extract(doc) {
    const container = doc.querySelector('article[data-csn-pdf]');
    if (!container) return null;
    const paragraphs = [];
    container.querySelectorAll(':scope > p, :scope > h2, :scope > h3').forEach((el) => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push({ el, text });
    });
    const titleEl = container.querySelector('h1');
    const title = titleEl?.textContent?.replace(/\s+/g, ' ').trim() || doc.title;
    const link = (rel) => doc.querySelector(`a[rel="${rel}"]:not([hidden])`)?.href || null;
    return {
      site: 'pdf', container, titleEl, title,
      novel: container.dataset.novel || '',
      nextUrl: link('next'), prevUrl: link('prev'),
      posId: container.dataset.posId || null,
      paragraphs,
    };
  },
};

const ADAPTERS = [crimsonScrolls, brightNovels, novelpia, novelLive, wtrLab];

// ---------- generic adapter (any site the user enables via the toolbar icon) ----------
// Readability-style: find the parent holding the largest cluster of paragraph-like
// blocks, treat those as the chapter, and guess title / next / prev.

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'BLOCKQUOTE', 'PRE', 'FORM', 'FIGURE', 'HR']);
// Whole-word class matches only ([class~=]): substrings like "hide-menu" on
// <body> or "menu-target" wrappers must not disqualify the whole page.
const BAD_ANCESTOR = 'nav,header,footer,aside,form,[role="navigation"],[class~="comments" i],[id="comments" i],[class~="comment" i],[class~="sidebar" i],[class~="menu" i],[class~="breadcrumb" i]';

function isParaLike(el) {
  const t = el.tagName;
  if (t === 'P' || t === 'BLOCKQUOTE') return true;
  if (t !== 'DIV') return false;
  for (const c of el.children) if (BLOCK_TAGS.has(c.tagName)) return false;
  return true;
}

function cleanText(el) {
  if (el.querySelector('script,style,iframe,ins,noscript,sub')) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,iframe,ins,noscript,sub,button,svg').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }
  return el.textContent.replace(/\s+/g, ' ').trim();
}

function genericNavLink(doc, kind) {
  const rel = doc.querySelector(`a[rel~="${kind}"]`);
  if (rel?.getAttribute('href') && !/^javascript:|^#/.test(rel.getAttribute('href'))) return rel.href;
  if (kind === 'next') {
    const l = doc.querySelector('link[rel="next"]');
    if (l?.href) return l.href;
  }
  const word = kind === 'next' ? /\bnext\b/i : /\bprev(ious)?\b/i;
  const arrow = kind === 'next' ? /^[»›>→]+$/ : /^[«‹<←]+$/;
  let best = null;
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    const label = ((a.textContent || '') + ' ' + (a.title || '') + ' ' + (a.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
    if (!label || label.length > 60) continue;
    if (word.test(label) || arrow.test(label.replace(/\s+/g, ''))) {
      const score = /chap|episode|ep\b/i.test(label) ? 2 : 1;
      if (!best || score > best.score) best = { a, score };
    }
  }
  return best ? best.a.href : null;
}

function genericNavButton(doc, kind) {
  const word = kind === 'next' ? /\bnext\b/i : /\bprev(ious)?\b/i;
  for (const b of doc.querySelectorAll('button')) {
    const label = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
    if (label && label.length <= 30 && word.test(label) && !b.disabled) return b;
  }
  return null;
}

function genericTitle(doc, container) {
  const chapterish = /\bchap(ter)?\.?\s*\d|episode\s*\d|^ch\.?\s*\d/i;
  const heads = [...doc.querySelectorAll('h1, h2, h3')];
  let h = heads.find((e) => chapterish.test(e.textContent)) || null;
  if (h) return { title: cleanText(h), titleEl: h };
  const seg = (doc.title || '').split(/\s*[|·]\s*|\s+[-–—]\s+/).find((s) => chapterish.test(s));
  if (seg) return { title: seg.trim(), titleEl: null };
  h = heads.find((e) => e.tagName === 'H1' && cleanText(e)) || null;
  if (h) return { title: cleanText(h), titleEl: h };
  return { title: (doc.title || '').split(/\s*[|·]\s*|\s+[-–—]\s+/)[0].trim(), titleEl: null };
}

const generic = {
  extract(doc) {
    // Score parents by how much paragraph-like text their children hold.
    const totals = new Map();
    doc.querySelectorAll('p, blockquote, div').forEach((el) => {
      if (!isParaLike(el)) return;
      if (el.closest(BAD_ANCESTOR)) return;
      const len = cleanText(el).length;
      if (len < 40) return;
      const parent = el.parentElement;
      if (!parent) return;
      totals.set(parent, (totals.get(parent) || 0) + len);
    });
    let container = null, max = 0;
    for (const [el, len] of totals) if (len > max) { max = len; container = el; }

    let paragraphs = [];
    if (container && max >= 400) {
      for (const el of container.children) {
        if (!isParaLike(el)) continue;
        const text = cleanText(el);
        if (text) paragraphs.push({ el, text });
      }
    }

    // <br><br>-separated sites: one big block instead of many paragraphs.
    if (paragraphs.length < 3) {
      let brBest = null, brMax = 0;
      doc.querySelectorAll('p, div').forEach((el) => {
        if (el.closest(BAD_ANCESTOR)) return;
        if (el.querySelectorAll(':scope > br').length < 3) return;
        const len = el.textContent.length;
        if (len > brMax) { brMax = len; brBest = el; }
      });
      if (brBest && brMax >= 400) {
        if (!brBest.dataset.csnSplit) { brBest.dataset.csnSplit = '1'; splitBrBlock(brBest); }
        paragraphs = [];
        brBest.querySelectorAll(':scope > .csn-para').forEach((el) => {
          const text = el.textContent.replace(/\s+/g, ' ').trim();
          if (text) paragraphs.push({ el, text });
        });
        container = brBest;
      }
    }
    if (!container || paragraphs.length < 3) return null;

    const { title, titleEl } = genericTitle(doc, container);
    const novel =
      doc.querySelector('meta[property="og:novel:novel_name"]')?.content?.trim() ||
      doc.querySelector('meta[property="og:site_name"]')?.content?.trim() ||
      (doc.location?.hostname || location.hostname);
    const nextUrl = genericNavLink(doc, 'next');
    const prevUrl = genericNavLink(doc, 'prev');
    return {
      site: 'generic',
      container, titleEl, novel, title,
      nextUrl, prevUrl,
      nextEl: nextUrl ? null : genericNavButton(doc, 'next'),
      prevEl: prevUrl ? null : genericNavButton(doc, 'prev'),
      paragraphs,
    };
  },
};

/** Pull ordered paragraphs out of the current page via its site adapter. */
export function extractChapter(doc = document) {
  if (pdfReader.match(doc)) return pdfReader.extract(doc);
  const host = doc.location?.hostname || location.hostname;
  const adapter = ADAPTERS.find((a) => a.hosts.some((h) => host === h || host.endsWith('.' + h)));
  // Known sites use only their tuned adapter (so non-chapter pages stay quiet);
  // everything else falls through to the generic extractor.
  return adapter ? adapter.extract(doc) : generic.extract(doc);
}

// ---------- text normalisation ----------

const SYSTEM_RE = /^\s*[【\[]\s*([\s\S]*?)\s*[】\]]\s*$/;

export function normalizeForSpeech(text) {
  return (
    text
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”„]/g, '"')
      .replace(/…/g, '...')
      .replace(/\.{4,}/g, '...')
      .replace(/([!?])\1{1,}/g, '$1') // "!!!" -> "!"
      .replace(/\?!|!\?/g, '?')
      .replace(/(\w)[-‐‑]{1,2}(\w)/g, '$1-$2')
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/\s*\*\s*\*\s*\*\s*/g, '. ')
      .replace(/\bCh\.\s*(\d)/g, 'Chapter $1')
      .replace(/\bVol\.\s*(\d)/g, 'Volume $1')
      .replace(/\s+/g, ' ')
      .replace(/^[,;:\s]+/, '')
      .trim()
  );
}

/**
 * Split a paragraph into typed segments: narration / dialogue / system.
 * Dialogue = text inside “ ” or " ". System = whole paragraph wrapped in 【 】 or [ ].
 */
function segmentParagraph(text) {
  const sys = text.match(SYSTEM_RE);
  if (sys) return [{ kind: 'system', text: sys[1] }];

  const out = [];
  const re = /[“"]([^”"]+)[”"]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1].trim();
    // Scare quotes ("raised his ears") — short, mid-sentence, no terminal punctuation: keep as narration.
    const scare = inner.split(/\s+/).length <= 4 && !/[.!?…]$/.test(inner) && m.index > 0 && !/[,:]\s*$/.test(text.slice(0, m.index));
    if (scare) continue;
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ kind: 'narration', text: before });
    out.push({ kind: 'dialogue', text: inner });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) out.push({ kind: 'narration', text: tail });
  return out.length ? out : [{ kind: 'narration', text }];
}

const MAX_CHUNK = 320; // ~20s of speech; Kokoro handles this comfortably and prosody improves with context

function splitSentences(text) {
  const parts = text
    .split(/(?<=[.!?…])\s+(?=[A-Z0-9"“(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);

  // pack sentences together up to MAX_CHUNK so each synth call carries real context
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last != null && last.length + 1 + p.length <= MAX_CHUNK) merged[merged.length - 1] = last + ' ' + p;
    else merged.push(p);
  }
  const final = [];
  for (const s of merged) {
    if (s.length <= MAX_CHUNK) { final.push(s); continue; }
    let cur = '';
    for (const piece of s.split(/(?<=,)\s+/)) {
      if (cur && cur.length + piece.length > MAX_CHUNK) { final.push(cur); cur = piece; }
      else cur = cur ? cur + ' ' + piece : piece;
    }
    if (cur) final.push(cur);
  }
  return final;
}

/**
 * Build the flat chunk list the engine plays.
 * @returns {Array<{index:number, para:number, kind:string, text:string, paraEnd:boolean}>}
 */
export function buildChunks(chapter) {
  const chunks = [];
  const push = (para, kind, text, paraEnd) => {
    const t = normalizeForSpeech(text);
    if (!t || !/[a-z0-9]/i.test(t)) return;
    chunks.push({ index: chunks.length, para, kind, text: t, paraEnd });
  };

  // title as chunk 0 (para -1)
  const titleNorm = normalizeForSpeech(chapter.title).toLowerCase();
  push(-1, 'title', chapter.title, true);

  chapter.paragraphs.forEach((p, pi) => {
    if (pi === 0 && normalizeForSpeech(p.text).toLowerCase() === titleNorm) return;
    const segs = segmentParagraph(p.text);
    segs.forEach((seg, si) => {
      const sents = splitSentences(seg.text);
      sents.forEach((s, k) => {
        const isLast = si === segs.length - 1 && k === sents.length - 1;
        push(pi, seg.kind, s, isLast);
      });
    });
  });
  return chunks;
}
