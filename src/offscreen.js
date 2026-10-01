// Offscreen document: hosts the Kokoro model + audio output.
import { KokoroTTS, env } from 'kokoro-js';
import { Mp3Encoder } from '@breezystack/lamejs';

env.wasmPaths = chrome.runtime.getURL('wasm/');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const LOOKAHEAD = 24;              // max chunks synthesised ahead of the one currently playing
const BUFFER_TARGET = 60;          // seconds of audio to keep synthesised ahead of playback
const PREROLL = 2;                 // chunks ready before playback starts
const SCHEDULE_HORIZON = 6;        // seconds of audio kept scheduled on the audio clock
const GAP = { sentence: 0.08, paragraph: 0.42, system: 0.25, title: 0.8, dialogue: 0.1 };
const SR = 24000;

// Kokoro pads every clip with ~0.3-0.5s of silence on both ends; strip it so
// the only pauses are the ones we schedule deliberately.
function trimSilence(pcm, threshold = 0.012, padMs = 40, fadeMs = 6) {
  const pad = Math.round((padMs / 1000) * SR);
  let start = 0, end = pcm.length;
  while (start < end && Math.abs(pcm[start]) < threshold) start++;
  while (end > start && Math.abs(pcm[end - 1]) < threshold) end--;
  if (end - start < SR * 0.05) return pcm; // all-silence guard
  start = Math.max(0, start - pad);
  end = Math.min(pcm.length, end + pad);
  const out = pcm.slice(start, end);
  const fade = Math.min(Math.round((fadeMs / 1000) * SR), out.length >> 1);
  for (let i = 0; i < fade; i++) { const g = i / fade; out[i] *= g; out[out.length - 1 - i] *= g; }
  return out;
}

let tts = null;
let engineInfo = null;
// Serialise model calls: playback pump and export job must not run inference concurrently.
let ttsBusy = Promise.resolve();
function generate(text, opts) {
  const run = ttsBusy.then(() => tts.generate(text, opts));
  ttsBusy = run.catch(() => {});
  return run;
}
const engineLabel = (s) => `${engineInfo?.device === 'webgpu' ? 'GPU' : 'CPU×' + (engineInfo?.threads ?? 1)}${s?.rtf ? ' ' + s.rtf.toFixed(1) + '× rt' : ''}`;
let loadedDevice = null;
let loading = null;

let port = null;
let session = null; // { gen, chunks, settings, cursor, playing, cache, ctx, sources, nextStart, timers }

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'csn-reader') return;
  if (port) { try { port.disconnect(); } catch {} }
  stopSession();
  port = p;
  p.onMessage.addListener(onMessage);
  if (exportJob?.last) post(exportJob.last);
  p.onDisconnect.addListener(() => { if (port === p) { port = null; stopSession(); } });
});

const post = (m) => { try { port?.postMessage(m); } catch {} };
const t0 = performance.now();
const log = (level, text, data) => {
  const line = { t: Math.round(performance.now() - t0), level, text, data };
  (level === 'error' ? console.error : console.log)('[csn]', text, data ?? '');
  post({ type: 'log', ...line });
};
const info = (t, d) => log('info', t, d);
const warn = (t, d) => log('warn', t, d);
const err = (t, d) => log('error', t, d);
self.addEventListener('error', (e) => err('uncaught: ' + e.message, e.error?.stack));
self.addEventListener('pagehide', () => { try { console.warn('[csn] offscreen document unloading'); } catch {} });
self.addEventListener('unhandledrejection', (e) => err('unhandled rejection: ' + (e.reason?.message || e.reason), e.reason?.stack));
const status = (text, extra = {}) => post({ type: 'status', text, ...extra });

async function onMessage(msg) {
  try {
    switch (msg.type) {
      case 'play': await startSession(msg); break;
      case 'pause': pause(); break;
      case 'resume': resume(); break;
      case 'seek': seek(msg.index); break;
      case 'stop': stopSession(); break;
      case 'settings': await updateSettings(msg.settings); break;
      case 'export': runExport(msg); break;
      case 'export-cancel': if (exportJob) { exportJob.cancelled = true; info('export cancel requested'); } break;
    }
  } catch (e) {
    err('message handler failed: ' + (e?.message || e), e?.stack);
    post({ type: 'error', text: e?.message || String(e) });
  }
}

// ---------- model ----------

async function pickDevice(pref) {
  info('device probe', { pref, hasNavigatorGpu: !!navigator.gpu, crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency, ua: navigator.userAgent });
  if (pref === 'wasm') return 'wasm';
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        let ai = {};
        try { ai = adapter.info || (await adapter.requestAdapterInfo?.()) || {}; } catch {}
        info('webgpu adapter OK', { vendor: ai.vendor, architecture: ai.architecture, device: ai.device, description: ai.description, isFallback: adapter.isFallbackAdapter });
        return 'webgpu';
      }
      warn('webgpu: requestAdapter returned null');
    } catch (e) { warn('webgpu: requestAdapter threw', e?.message); }
  } else warn('webgpu: navigator.gpu missing in offscreen document');
  if (pref === 'webgpu') status('WebGPU unavailable, falling back to CPU');
  return 'wasm';
}

async function ensureModel(pref) {
  const device = await pickDevice(pref);
  if (tts && loadedDevice === device) return tts;
  if (loading) return loading;
  loading = (async () => {
    const dtype = device === 'webgpu' ? 'fp32' : 'q8';
    const files = new Map();
    const tl = performance.now();
    info('model load start', { model: MODEL_ID, device, dtype, wasmPaths: env.wasmPaths });
    status(`Loading Kokoro (${device})…`, { progress: 0 });
    const model = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype,
      device,
      progress_callback: (ev) => {
        if (ev.status === 'progress') {
          files.set(ev.file, [ev.loaded || 0, ev.total || 0]);
          let l = 0, t = 0;
          for (const [a, b] of files.values()) { l += a; t += b; }
          const pct = t ? Math.round((l / t) * 100) : 0;
          status(`Downloading model ${pct}% (${(l / 1048576).toFixed(0)} MB)`, { progress: pct });
        } else if (ev.status === 'ready') {
          status('Warming up…', { progress: 100 });
        } else if (ev.status === 'initiate' || ev.status === 'done') {
          info('file ' + ev.status, ev.file);
        }
      },
    });
    tts = model;
    loadedDevice = device;
    info('model loaded', { ms: Math.round(performance.now() - tl) });
    status('Warming up…');
    const tw = performance.now();
    const warm = await model.generate('The story begins.', { voice: 'af_heart' });
    engineInfo = { device, threads: self.crossOriginIsolated ? (navigator.hardwareConcurrency || 1) : 1,
      warmRtf: +((warm.audio.length / 24000) / ((performance.now() - tw) / 1000)).toFixed(2), warmMs: Math.round(performance.now() - tw) };
    info('engine ready', engineInfo);
    return model;
  })().finally(() => (loading = null));
  return loading;
}

// ---------- session ----------

function voiceFor(chunk, settings) {
  const n = settings.narratorVoice || 'af_heart';
  if (chunk.kind === 'dialogue') return settings.dialogueVoice && settings.dialogueVoice !== 'same' ? settings.dialogueVoice : n;
  if (chunk.kind === 'system') return settings.systemVoice && settings.systemVoice !== 'same' ? settings.systemVoice : n;
  return n;
}

async function startSession({ gen, chunks, startIndex, settings }) {
  stopSession();
  const ctx = new AudioContext({ sampleRate: 24000 });
  session = {
    gen, chunks, settings, cursor: startIndex || 0, playing: false, cache: new Map(),
    ctx, sources: [], nextStart: 0, timers: [], pumping: false, lastScheduled: -1, ended: false,
    queue: [], endAt: null, // audio-clock driven "now playing" notifications
  };
  const s = session;
  info('session start', { gen, chunks: chunks.length, chars: chunks.reduce((a, c) => a + c.text.length, 0), startIndex, settings, ctxSampleRate: ctx.sampleRate, ctxState: ctx.state });
  await ensureModel(settings.device);
  if (session !== s) return;
  status('Ready · ' + engineLabel(s), { ready: true, progress: null });
  play(s.cursor);
}

function stopSession() {
  if (!session) return;
  const s = session;
  session = null;
  clearScheduled(s);
  try { s.ctx.close(); } catch {}
}

function clearScheduled(s) {
  for (const src of s.sources) { try { src.stop(); } catch {} }
  s.sources = [];
  for (const t of s.timers) clearTimeout(t);
  s.timers = [];
  s.queue = [];
  s.endAt = null;
  s.lastScheduled = -1;
}

function play(index) {
  const s = session;
  if (!s) return;
  info('play', { index, ctxState: s.ctx.state });
  clearScheduled(s);
  s.cursor = index;
  s.playingIndex = undefined;
  s.ended = false;
  s.playing = true;
  s.nextStart = 0;
  if (s.ctx.state === 'suspended') s.ctx.resume();
  post({ type: 'state', playing: true });
  pump();
  schedule();
}

function pause() {
  const s = session;
  if (!s || !s.playing) return;
  s.playing = false;
  info('pause', { at: s.playingIndex });
  s.ctx.suspend();
  post({ type: 'state', playing: false });
}

function resume() {
  const s = session;
  if (!s) return;
  if (s.ended) return play(0);
  s.playing = true;
  s.ctx.resume();
  post({ type: 'state', playing: true });
  pump();
  schedule();
}

function seek(index) {
  const s = session;
  if (!s) return;
  play(Math.max(0, Math.min(s.chunks.length - 1, index)));
}

async function updateSettings(settings) {
  const s = session;
  if (!s) return;
  const old = s.settings;
  s.settings = settings;
  info('settings update', settings);
  const deviceChanged = settings.device !== old.device;
  const voiceChanged = ['narratorVoice', 'dialogueVoice', 'systemVoice', 'speed'].some((k) => settings[k] !== old[k]);
  if (deviceChanged) {
    const wasPlaying = s.playing;
    pause();
    await ensureModel(settings.device);
    if (session !== s) return;
    status('Ready', { ready: true });
    if (wasPlaying) play(currentIndex(s));
  } else if (voiceChanged && s.playing) {
    play(currentIndex(s));
  }
}

function currentIndex(s) {
  return s.playingIndex ?? s.cursor;
}

// ---------- synthesis pump ----------

function cacheKey(chunk, settings) {
  return `${voiceFor(chunk, settings)}|${settings.speed}|${chunk.text}`;
}

async function pump() {
  const s = session;
  if (!s || s.pumping) return;
  s.pumping = true;
  try {
    while (session === s && s.playing) {
      const base = s.playingIndex ?? s.cursor;
      let target = -1;
      let buffered = Math.max(0, s.nextStart - s.ctx.currentTime);
      for (let i = base; i < Math.min(s.chunks.length, base + LOOKAHEAD); i++) {
        const pcm = s.cache.get(cacheKey(s.chunks[i], s.settings));
        if (!pcm) { target = i; break; }
        if (i > s.lastScheduled) buffered += pcm.length / 24000;
      }
      if (target < 0 || buffered > BUFFER_TARGET) break;
      const chunk = s.chunks[target];
      const key = cacheKey(chunk, s.settings);
      const tg = performance.now();
      const audio = await generate(chunk.text, { voice: voiceFor(chunk, s.settings), speed: s.settings.speed || 1 });
      if (session !== s) return;
      const pcm = trimSilence(audio.audio); // Float32Array @ 24k
      s.cache.set(key, pcm);
      const ms = performance.now() - tg;
      const secs = pcm.length / 24000;
      const trimmed = +((audio.audio.length - pcm.length) / 24000).toFixed(2);
      s.rtf = secs / (ms / 1000);
      info(`synth #${target}`, { kind: chunk.kind, chars: chunk.text.length, audioSec: +secs.toFixed(2), trimmedSec: trimmed, ms: Math.round(ms), rtf: +s.rtf.toFixed(2), bufferedSec: +buffered.toFixed(1), playing: s.playingIndex });
      schedule();
    }
  } catch (e) {
    err('synth failed: ' + (e?.message || e), e?.stack);
    post({ type: 'error', text: e?.message || String(e) });
  } finally {
    s.pumping = false;
  }
}

// ---------- scheduler ----------

function prerolled(s) {
  if (s.lastScheduled >= 0) return true;
  for (let i = s.cursor; i < Math.min(s.chunks.length, s.cursor + PREROLL); i++) {
    if (!s.cache.has(cacheKey(s.chunks[i], s.settings))) return false;
  }
  return true;
}

function schedule() {
  const s = session;
  if (!s || !s.playing) return;
  const ctx = s.ctx;
  if (!prerolled(s)) { pump(); return; }
  while (true) {
    const idx = s.lastScheduled >= 0 ? s.lastScheduled + 1 : s.cursor;
    if (idx >= s.chunks.length) {
      // End-of-chapter fires off the AUDIO clock (see tick) so a pause freezes it
      // along with playback instead of letting a wall-clock timer fire mid-pause.
      if (s.endAt == null && s.lastScheduled >= 0) s.endAt = s.nextStart + 0.3;
      return;
    }
    const chunk = s.chunks[idx];
    const pcm = s.cache.get(cacheKey(chunk, s.settings));
    if (!pcm) {
      pump();
      if (s.lastScheduled >= 0 && s.nextStart < ctx.currentTime + 0.2 && !s.stalled) {
        s.stalled = true;
        warn('STALL: audio ran out waiting for synth', { waitingFor: idx, playing: s.playingIndex });
        status('Buffering… ' + engineLabel(s), { ready: true });
      }
      return;
    }
    if (s.stalled) { info('stall recovered', { idx }); s.stalled = false; }
    const startAt = Math.max(ctx.currentTime + 0.03, s.nextStart);
    if (startAt - ctx.currentTime > SCHEDULE_HORIZON) return; // enough queued

    const buf = ctx.createBuffer(1, pcm.length, 24000);
    buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(startAt);
    s.sources.push(src);

    const gap = chunk.kind === 'title' ? GAP.title : chunk.paraEnd ? GAP.paragraph : chunk.kind === 'system' ? GAP.system : GAP.sentence;
    const nextKind = s.chunks[idx + 1]?.kind;
    const extra = nextKind === 'system' && chunk.kind !== 'system' ? GAP.system : 0;
    s.nextStart = startAt + buf.duration + gap + extra;
    s.lastScheduled = idx;

    info(`sched #${idx}`, { startIn: +(startAt - ctx.currentTime).toFixed(2), dur: +buf.duration.toFixed(2), gap: +(gap + extra).toFixed(2) });
    // "Now playing #idx" is announced by tick() when the audio clock reaches
    // startAt — never by wall-clock setTimeout, which keeps running while the
    // context is suspended and used to walk the UI forward during pause.
    s.queue.push({ idx, startAt, dur: buf.duration });
  }
}

// Advance playingIndex / chapter-end strictly by the audio clock.
function tick() {
  const s = session;
  if (!s || !s.playing) return;
  const now = s.ctx.currentTime;
  let fired = null;
  while (s.queue.length && s.queue[0].startAt <= now + 0.03) fired = s.queue.shift();
  if (fired && s.playingIndex !== fired.idx) {
    s.playingIndex = fired.idx;
    post({ type: 'chunk', index: fired.idx, engine: engineLabel(s), dur: fired.dur });
  }
  if (s.endAt != null && now >= s.endAt) {
    s.endAt = null;
    s.ended = true;
    s.playing = false;
    info('chapter ended');
    post({ type: 'ended' });
  }
}

// ---------- multi-chapter MP3 export ----------

let exportJob = null;
const MP3_KBPS = 64;
const CHAPTER_GAP = 1.4;

function gapFor(chunk, next) {
  const gap = chunk.kind === 'title' ? GAP.title : chunk.paraEnd ? GAP.paragraph : chunk.kind === 'system' ? GAP.system : GAP.sentence;
  const extra = next?.kind === 'system' && chunk.kind !== 'system' ? GAP.system : 0;
  return gap + extra;
}

function toInt16(pcm) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

async function runExport({ chapters, settings, filename }) {
  if (exportJob) { post({ type: 'export-error', text: 'An export is already running' }); return; }
  const job = { cancelled: false };
  exportJob = job;
  const total = chapters.reduce((n, c) => n + c.chunks.length, 0);
  const totalChars = chapters.reduce((n, c) => n + c.chunks.reduce((a, k) => a + k.text.length, 0), 0);
  info('export start', { chapters: chapters.length, chunks: total, chars: totalChars, filename, kbps: MP3_KBPS });
  const t0 = performance.now();
  try {
    await ensureModel(settings.device);
    const enc = new Mp3Encoder(1, SR, MP3_KBPS);
    const parts = [];
    let done = 0, seconds = 0;
    const pushPcm = (pcm) => { const mp3 = enc.encodeBuffer(toInt16(pcm)); if (mp3.length) parts.push(mp3); seconds += pcm.length / SR; };
    const pushSilence = (sec) => { if (sec > 0) pushPcm(new Float32Array(Math.round(sec * SR))); };

    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      if (ci > 0) pushSilence(CHAPTER_GAP);
      for (let i = 0; i < ch.chunks.length; i++) {
        if (job.cancelled) throw new Error('cancelled');
        const chunk = ch.chunks[i];
        const key = cacheKey(chunk, settings);
        let pcm = session?.cache.get(key);
        if (!pcm) {
          const audio = await generate(chunk.text, { voice: voiceFor(chunk, settings), speed: settings.speed || 1 });
          pcm = trimSilence(audio.audio);
        }
        pushPcm(pcm);
        pushSilence(gapFor(chunk, ch.chunks[i + 1]));
        done++;
        if (done % 3 === 0 || done === total) {
          const elapsed = (performance.now() - t0) / 1000;
          job.last = { type: 'export-progress', chapter: ci + 1, chapters: chapters.length, done, total, pct: Math.round((done / total) * 100), seconds, eta: Math.round((elapsed / done) * (total - done)) };
          post(job.last);
        }
      }
      info(`export chapter ${ci + 1}/${chapters.length} done`, { title: ch.title, audioMin: +(seconds / 60).toFixed(1) });
    }
    const tail = enc.flush();
    if (tail.length) parts.push(tail);
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    info('export encoded', { bytes: blob.size, minutes: +(seconds / 60).toFixed(1), tookSec: Math.round((performance.now() - t0) / 1000) });
    const res = await chrome.runtime.sendMessage({ type: 'download', url, filename });
    if (!res?.ok) throw new Error('download failed: ' + (res?.error || 'unknown'));
    post({ type: 'export-done', filename, bytes: blob.size, seconds });
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  } catch (e) {
    if (e.message === 'cancelled') { info('export cancelled'); post({ type: 'export-cancelled' }); }
    else { err('export failed: ' + (e?.message || e), e?.stack); post({ type: 'export-error', text: e?.message || String(e) }); }
  } finally {
    exportJob = null;
  }
}

// keep the scheduler fed while playing (audio clock advances independently);
// tick() also announces chunk changes, so run tight enough for highlight sync
setInterval(() => { if (session?.playing) { tick(); schedule(); pump(); } }, 60);
