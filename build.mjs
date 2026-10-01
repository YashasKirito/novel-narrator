import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out + '/wasm', { recursive: true });

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
if (process.argv.includes('--dev')) {
  // local fixture pages for testing without Cloudflare in the way
  manifest.content_scripts[0].matches.push('http://localhost:8765/novel/*/*');
  manifest.host_permissions.push('http://localhost:8765/*'); // lets reader.html fetch fixture PDFs
}
writeFileSync(out + '/manifest.json', JSON.stringify(manifest, null, 2));
cpSync('offscreen.html', out + '/offscreen.html');
cpSync('reader.html', out + '/reader.html');
cpSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', out + '/pdf.worker.mjs');
cpSync('icons', out + '/icons', { recursive: true });
const ortDir = 'node_modules/@huggingface/transformers/dist/';
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  cpSync(ortDir + f, `${out}/wasm/${f}`);
}

const common = { bundle: true, platform: 'browser', target: 'chrome116', logLevel: 'info', sourcemap: false };
const builds = [
  { entryPoints: ['src/background.js'], outfile: out + '/background.js', format: 'esm' },
  { entryPoints: ['src/content.js'], outfile: out + '/content.js', format: 'iife' },
  { entryPoints: ['src/offscreen.js'], outfile: out + '/offscreen.js', format: 'esm', minify: true },
  { entryPoints: ['src/reader.js'], outfile: out + '/reader.js', format: 'esm', minify: true },
];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context({ ...common, ...b })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
}
