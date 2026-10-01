// Service worker: only job is to make sure the offscreen document (which hosts
// Kokoro + the audio output) exists when a content script asks for it.

let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        // BLOBS is required for the MP3 export (URL.createObjectURL) and — importantly —
        // lifts the AUDIO_PLAYBACK-only rule that closes the document after 30s of silence,
        // which would kill long synthesis jobs and idle engines.
        reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
        justification: 'Runs the Kokoro TTS model, plays narrated chapter audio, and builds MP3 blobs for export.',
      })
      .finally(() => (creating = null));
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'download') {
    // Blob URL minted by the offscreen document (same extension origin).
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' })
      .then((id) => sendResponse({ ok: true, id }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg && msg.type === 'ensure-offscreen') {
    ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  return false;
});

// ---------- enable-on-any-site (toolbar icon toggle) ----------
// Built-in sites ship in the manifest. Any other site: clicking the icon asks
// for permission on that origin, registers a persistent content script there
// (so auto-next / export keep working across page loads), and injects into the
// current tab. Clicking again disables the site and drops the permission.

const SITES_KEY = 'genericOrigins';
const BUILTIN = ['crimsonscrolls.net', 'brightnovels.com', 'global.novelpia.com', 'novellive.app', 'wtr-lab.com'];

const scriptId = (host) => 'csn-' + host;

async function getOrigins() {
  const o = await chrome.storage.local.get(SITES_KEY);
  return o[SITES_KEY] || []; // e.g. ["https://example.com/*"]
}

function flashBadge(tabId, text) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#888' });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
}

// ---------- PDF reader ----------
// Chrome's PDF viewer keeps the text inside a plugin, so we open the PDF in our
// own reader page (reader.html), which extracts the text and runs the narrator.

const readerUrl = (src) => chrome.runtime.getURL('reader.html') + (src ? '?src=' + encodeURIComponent(src) : '');
const looksPdf = (url) => /\.pdf$/i.test(url.pathname);

async function probePdf(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType });
    return r?.result === 'application/pdf';
  } catch { return false; }
}

function openReader(tab, src) {
  return chrome.tabs.update(tab.id, { url: readerUrl(src) });
}

chrome.action.onClicked.addListener(async (tab) => {
  // tab.url needs the activeTab grant (given by this very click); guard anyway.
  let url = null;
  try { url = new URL(tab.url || ''); } catch {}
  if (url?.protocol === 'chrome-extension:' && url.host === chrome.runtime.id) {
    flashBadge(tab.id, 'ON'); // our own reader page
    return;
  }
  if (!url || !/^(https?|file):$/.test(url.protocol)) {
    // New tab / chrome:// pages: nothing to read here, offer the PDF picker.
    chrome.tabs.create({ url: readerUrl(), index: tab.index + 1 }).catch((e) => console.warn('csn: open reader failed', e));
    return;
  }
  const host = url.hostname;
  const builtin = BUILTIN.some((h) => host === h || host.endsWith('.' + h));

  try {
    if (url.protocol === 'file:') {
      // Local PDF: reading it needs file access ("Allow access to file URLs");
      // the reader page falls back to a file picker if that's not granted.
      if (!looksPdf(url)) { flashBadge(tab.id, 'n/a'); return; }
      await chrome.permissions.request({ origins: ['file:///*'] }).catch(() => false);
      return openReader(tab, url.href);
    }
    const origin = `${url.protocol}//${host}/*`;
    if (looksPdf(url)) {
      // Ask first: permissions.request must run on the user gesture, before any awaits.
      if (!builtin) await chrome.permissions.request({ origins: [origin] }).catch((e) => { console.warn('csn: permissions.request failed', e); return false; });
      return openReader(tab, url.href);
    }
    if (builtin) {
      if (await probePdf(tab.id)) return openReader(tab, url.href);
      flashBadge(tab.id, 'ON'); // built-in site: already always on
      return;
    }

    const granted = await chrome.permissions.request({ origins: [origin] })
      .catch((e) => { console.warn('csn: permissions.request failed', e); return false; });

    // PDF served without a .pdf extension (activeTab lets us look).
    if (await probePdf(tab.id)) return openReader(tab, url.href);

    const origins = await getOrigins();
    if (origins.includes(origin)) {
      // toggle OFF
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId(host)] }).catch(() => {});
      await chrome.storage.local.set({ [SITES_KEY]: origins.filter((o) => o !== origin) });
      chrome.permissions.remove({ origins: [origin] }).catch(() => {});
      chrome.tabs.sendMessage(tab.id, { type: 'csn-teardown' }).catch(() => {});
      flashBadge(tab.id, 'OFF');
      return;
    }
    if (!granted) { flashBadge(tab.id, '!'); return; }
    await chrome.scripting.registerContentScripts([{
      id: scriptId(host),
      matches: [origin],
      js: ['content.js'],
      runAt: 'document_idle',
    }]).catch(() => {}); // already registered is fine
    await chrome.storage.local.set({ [SITES_KEY]: [...new Set([...origins, origin])] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
      .catch((e) => console.warn('csn: inject failed', e));
  } catch (e) {
    console.error('csn: toggle failed', e);
    flashBadge(tab.id, '!');
  }
});

// Content script announces itself on load -> per-tab ON badge (feedback that it's active).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'csn-alive' && sender.tab?.id != null) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#b4442c' });
  }
  // Content script landed on Chrome's PDF viewer: hint that a click opens the reader.
  if (msg?.type === 'csn-pdf-page' && sender.tab?.id != null) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: 'PDF' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#888' });
    chrome.action.setTitle({ tabId: sender.tab.id, title: 'Novel Narrator: click to read this PDF aloud' });
  }
});

// Registered scripts are cleared on extension update — restore them.
chrome.runtime.onInstalled.addListener(async () => {
  const origins = await getOrigins();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const have = new Set(existing.map((s) => s.id));
  for (const origin of origins) {
    const host = origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
    if (have.has(scriptId(host))) continue;
    await chrome.scripting.registerContentScripts([{
      id: scriptId(host), matches: [origin], js: ['content.js'], runAt: 'document_idle',
    }]).catch((e) => console.warn('re-register failed', origin, e));
  }
});
