# Novel Narrator

A Chrome extension that reads web novels and PDFs aloud with natural AI voices, and turns chapters into MP3 audiobooks.

Everything runs in your browser. The speech model ([Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)) is downloaded once and then runs locally on your GPU or CPU, so the text you read is never sent to a server.

## Features

- **Read aloud** — a floating player on the chapter page with play, pause, and previous/next paragraph. Click any paragraph to jump to it.
- **Follow along** — the current paragraph and word are highlighted, and the page scrolls with the narration.
- **Separate voices** — choose different voices for narration, dialogue, and `【System】` lines, from 21 US and UK voices.
- **Continuous listening** — moves to the next chapter automatically and remembers where you stopped in each chapter.
- **Audiobook export** — collects up to 200 chapters, starting from the current one, and saves them as a single MP3.
- **PDF reader** — opens a PDF in a clean reading view, split into chapters, with the same player and export.
- **Works on most sites** — tuned for a handful of web-novel sites out of the box, and can be switched on for any other site from the toolbar icon.

## Install

The extension is not on the Chrome Web Store, so you load it from source. It needs Chrome 116 or newer and Node.js.

1. Install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `dist` folder.

The first time you press play, the extension downloads the voice model from Hugging Face. After that it is cached.

## Using it

### On a web novel

Open a chapter on a supported site and the player appears at the bottom of the page.

| Site | Built in |
|---|---|
| crimsonscrolls.net | yes |
| brightnovels.com | yes |
| global.novelpia.com | yes |
| novellive.app | yes |
| wtr-lab.com | yes |
| Any other site | click the toolbar icon to enable |

On any other site, click the toolbar icon and grant access when Chrome asks. The extension then finds the main block of text on the page and treats it as the chapter. It stays enabled for that site until you click the icon again.

### On a PDF

Click the toolbar icon on a PDF tab to open it in the reader, or click it on a new tab to pick or drop a PDF file. PDFs are read on your computer; nothing is uploaded.

The reader assumes a single-column layout, such as a novel or an ebook export. Two-column documents will read with the columns interleaved.

### Player controls

| Control | What it does |
|---|---|
| ▶ / ⏸ | Play, pause or resume |
| ⏮ / ⏭ | Previous or next paragraph |
| ⚙ | Voices, speed, engine, auto-next, auto-scroll, word highlighting |
| ⬇ | Export chapters as one MP3 |
| 📋 | Logs, for troubleshooting |
| `Alt+P` | Play or pause from the keyboard |

### Exporting an audiobook

1. Open the first chapter you want and click ⬇.
2. Enter how many chapters to include and start the download.
3. The extension visits each chapter page in turn to collect the text, so you will see the tab navigate.
4. It then synthesises all of it into one mono 64 kbps MP3 with your current voices and speed, and saves it to your downloads folder.

Roughly 900 characters make one minute of audio. You can keep reading while the audio is being synthesised.

### Settings

| Setting | Default | Notes |
|---|---|---|
| Narrator voice | Heart (US F) | Used for everything unless the two below are set |
| Dialogue voice | Same as narrator | Used for text inside quotation marks |
| System voice | Nicole (US F, soft) | Used for paragraphs wrapped in `【 】` or `[ ]` |
| Speed | 1.0× | 0.7× to 1.6× |
| Engine | Auto | WebGPU when available, otherwise CPU (WASM) |
| Auto-next chapter | on | Continues into the next chapter when one ends |
| Auto-scroll | on | Keeps the current paragraph centred |
| Highlight words | on | Word timing is estimated; adjust it with **Word sync** |

## Development

```sh
npm run build          # one-off build into dist/
npm run watch          # rebuild on change
node build.mjs --dev   # also enables the extension on http://localhost:8765 for local fixture pages
```

After a build, reload the extension on `chrome://extensions`.

### Project layout

| Path | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `src/content.js` | Player UI, highlighting, export orchestration; runs on the chapter page |
| `src/textproc.js` | Site adapters, generic chapter extraction, text clean-up and chunking |
| `src/offscreen.js` | Kokoro model, audio playback and MP3 encoding; runs in an offscreen document |
| `src/background.js` | Service worker: toolbar icon, per-site enable/disable, PDF hand-off, downloads |
| `src/reader.js`, `reader.html` | PDF reader page |
| `src/pdfextract.js` | Rebuilds paragraphs and chapters from PDF text |
| `src/settings.js` | Default settings and the voice list |
| `build.mjs` | esbuild script that bundles everything into `dist/` |

### Adding a site

Sites with a dedicated adapter get more reliable titles, paragraphs and next-chapter links than the generic extractor. To add one, write an adapter in `src/textproc.js` alongside the existing ones, add it to `ADAPTERS`, and add the host to `content_scripts.matches` in `manifest.json` and to `BUILTIN` in `src/background.js`.

## Built with

- [kokoro-js](https://www.npmjs.com/package/kokoro-js) — Kokoro text-to-speech in the browser
- [pdf.js](https://mozilla.github.io/pdf.js/) — PDF text extraction
- [lamejs](https://www.npmjs.com/package/@breezystack/lamejs) — MP3 encoding
- [esbuild](https://esbuild.github.io/) — bundling

## Note

This is a personal project. Exported audio is for your own listening; respect the terms of the sites you read and the rights of the authors.
