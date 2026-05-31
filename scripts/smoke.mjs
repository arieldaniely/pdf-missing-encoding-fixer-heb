// Node smoke test for the fix pipeline (the browser UI can't be exercised here).
// Usage: node scripts/smoke.mjs <input.pdf> [outDir]
import { readFileSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { fixPdf } from '../src/fix.ts';

const input = process.argv[2] || '/root/Mugah/3.pdf';
const fontBytes = readFileSync(new URL('../public/hebrew.ttf', import.meta.url));
const src = new Uint8Array(readFileSync(input));

console.log('fixing', input);
const fixed = await fixPdf(src, fontBytes, {
  dpi: 120,
  onProgress: ({ page, pageCount, lostFonts }) => {
    if (page === 1) console.log('lost fonts:', lostFonts.join(', ') || '(none)');
    if (page % 25 === 0 || page === pageCount) console.log(`  ${page}/${pageCount}`);
  },
});

const outPath = '/tmp/fixed.pdf';
writeFileSync(outPath, fixed);
console.log('wrote', outPath, `(${(fixed.length / 1024).toFixed(0)} KB)`);

// Verify: re-open the OUTPUT and extract its (now honest) text layer.
const doc = mupdf.Document.openDocument(fixed, 'application/pdf').asPDF();
const page = doc.loadPage(2);
const st = page.toStructuredText('preserve-whitespace');
let text = '';
st.walk({ onChar(ch) { text += ch; } });
console.log('\n--- extracted text from FIXED pdf, page 3 (first 200 chars) ---');
console.log(text.slice(0, 200));
