// Node smoke test for the encoding-fix pipeline (the browser UI can't be
// exercised here). Usage: node scripts/smoke.mjs <input.pdf> [outPath]
//
// The `src/` modules use extensionless TS imports (bundler resolution), which
// plain Node ESM can't resolve, so we bundle the entry with esbuild on the fly
// (mupdf stays external) and import the result.
import { build } from 'esbuild';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as mupdf from 'mupdf';

const input = process.argv[2] || '/root/Mugah/3.pdf';
const outPath = process.argv[3] || '/tmp/fixed.pdf';

// Emit the bundle inside the project so its external `mupdf` import resolves
// against the project's node_modules; clean it up afterwards.
const bundle = new URL('../.smoke-bundle.mjs', import.meta.url).pathname;
await build({
  entryPoints: [new URL('../src/encoding-fix.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['mupdf'],
  outfile: bundle,
  logLevel: 'error',
});
const { fixPdfEncoding } = await import(pathToFileURL(bundle).href);
rmSync(bundle, { force: true });

console.log('fixing', input);
const { bytes, fixedFonts } = fixPdfEncoding(new Uint8Array(readFileSync(input)), {
  onProgress: ({ font, fontCount, name }) => {
    if (font === 1 || font === fontCount) console.log(`  font ${font}/${fontCount} ${name}`);
  },
});
console.log('fixed fonts:', fixedFonts.join(', ') || '(none)');

writeFileSync(outPath, bytes);
console.log('wrote', outPath, `(${(bytes.length / 1024).toFixed(0)} KB)`);

// Verify: re-open the OUTPUT and extract its (now repaired) text layer.
const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(outPath)), 'application/pdf').asPDF();
const idx = Math.min(2, doc.countPages() - 1);
const page = doc.loadPage(idx);
const st = page.toStructuredText('preserve-whitespace');
let text = '';
st.walk({ onChar(ch) { text += ch; } });
console.log(`\n--- extracted text from FIXED pdf, page ${idx + 1} (first 200 chars) ---`);
console.log(text.slice(0, 200));
