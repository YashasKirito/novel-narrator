export const DEFAULT_SETTINGS = {
  narratorVoice: 'af_heart',
  dialogueVoice: 'same',   // 'same' = use narrator voice
  systemVoice: 'af_nicole', // for 【system】 lines
  speed: 1.0,
  device: 'auto',          // auto | webgpu | wasm
  autoNext: true,
  autoScroll: true,
  wordHighlight: true,
  wordOffset: 0,           // ms; negative = highlight earlier, positive = later
};

export const VOICES = [
  ['af_heart', 'Heart (US F) ★'],
  ['af_bella', 'Bella (US F) ★'],
  ['af_nicole', 'Nicole (US F, soft)'],
  ['af_aoede', 'Aoede (US F)'],
  ['af_kore', 'Kore (US F)'],
  ['af_sarah', 'Sarah (US F)'],
  ['af_sky', 'Sky (US F)'],
  ['am_michael', 'Michael (US M)'],
  ['am_fenrir', 'Fenrir (US M)'],
  ['am_puck', 'Puck (US M)'],
  ['am_adam', 'Adam (US M)'],
  ['am_onyx', 'Onyx (US M)'],
  ['am_liam', 'Liam (US M)'],
  ['bf_emma', 'Emma (UK F)'],
  ['bf_isabella', 'Isabella (UK F)'],
  ['bf_alice', 'Alice (UK F)'],
  ['bf_lily', 'Lily (UK F)'],
  ['bm_george', 'George (UK M)'],
  ['bm_fable', 'Fable (UK M)'],
  ['bm_daniel', 'Daniel (UK M)'],
  ['bm_lewis', 'Lewis (UK M)'],
];

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
