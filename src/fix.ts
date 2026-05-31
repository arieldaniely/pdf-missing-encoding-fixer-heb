import fontkit from '@pdf-lib/fontkit';
import * as mupdf from 'mupdf';
import { PDFDocument } from 'pdf-lib';
import { buildTagFontDecoders, extractPageText, renderPageImage } from './textmap';

export interface FixProgress {
  page: number;
  pageCount: number;
  lostFonts: string[];
}

/** Axis projections of a mupdf Quad ([ulx,uly,urx,ury,llx,lly,lrx,lry]). */
function qx(q: number[]): [number, number] {
  return [Math.min(q[0], q[2], q[4], q[6]), Math.max(q[0], q[2], q[4], q[6])];
}
function qy(q: number[]): [number, number] {
  return [Math.min(q[1], q[3], q[5], q[7]), Math.max(q[1], q[3], q[5], q[7])];
}

interface Line {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Split an extracted block into visual lines with their on-page bounding box.
 * `block.text` uses `\n` for line breaks and `block.quads[i]` is the quad for
 * `text[i]` (null at the inserted `\n`), both in the top-down structured-text
 * space mupdf reports.
 */
function blockLines(text: string, quads: (number[] | null)[]): Line[] {
  const lines: Line[] = [];
  let cur = '';
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const flush = () => {
    if (cur.trim() && Number.isFinite(left)) {
      lines.push({ text: cur, left, right, top, bottom });
    }
    cur = '';
    left = Infinity;
    right = -Infinity;
    top = Infinity;
    bottom = -Infinity;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      flush();
      continue;
    }
    cur += ch;
    const q = quads[i];
    if (q) {
      const [xmin, xmax] = qx(q);
      const [ymin, ymax] = qy(q);
      if (xmin < left) left = xmin;
      if (xmax > right) right = xmax;
      if (ymin < top) top = ymin;
      if (ymax > bottom) bottom = ymax;
    }
  }
  flush();
  return lines;
}

/**
 * Rebuild a PDF whose Tag/Sappir-style fonts lost their character mapping into
 * one with a correct, copy-pasteable Hebrew text layer. Each output page is the
 * original rendered as an image (so it looks identical) with the decoded Hebrew
 * placed over it as invisible (selectable/searchable) text — an OCR-style
 * sandwich that works for every broken-font regime, including Type3 outlines.
 *
 * `fontBytes` is a Unicode Hebrew TTF/OTF for the invisible layer (the browser
 * fetches it; Node passes it from disk), so the function has no I/O of its own.
 */
export async function fixPdf(
  srcBytes: Uint8Array,
  fontBytes: ArrayBuffer | Uint8Array,
  opts?: { dpi?: number; onProgress?: (p: FixProgress) => void },
): Promise<Uint8Array> {
  const dpi = opts?.dpi ?? 150;
  const src = mupdf.Document.openDocument(srcBytes, 'application/pdf').asPDF();
  if (!src) throw new Error('Not a PDF');
  const decoders = buildTagFontDecoders(src);
  const lostFonts = [...decoders.lost.keys()].map((f) => f.split('+').pop() ?? f);

  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await out.embedFont(fontBytes, { subset: true });

  const pageCount = src.countPages();
  for (let i = 0; i < pageCount; i++) {
    const { image } = renderPageImage(src, i, dpi);
    const page = src.loadPage(i);
    const [x0, y0, x1, y1] = page.getBounds('MediaBox');
    page.destroy();
    const w = x1 - x0;
    const h = y1 - y0;

    const outPage = out.addPage([w, h]);
    const png = await out.embedPng(image as unknown as Uint8Array);
    outPage.drawImage(png, { x: 0, y: 0, width: w, height: h });

    for (const block of extractPageText(src, i, decoders)) {
      for (const line of blockLines(
        block.text,
        block.quads as unknown as (number[] | null)[],
      )) {
        // Strip glyphs the embedded font lacks so pdf-lib won't throw; the rest
        // still copy/paste correctly.
        const safe = sanitizeForFont(line.text, font);
        if (!safe.trim()) continue;
        const size = Math.max(2, line.bottom - line.top);
        // Quads are top-down; pdf-lib's origin is bottom-left.
        outPage.drawText(safe, {
          x: line.left - x0,
          y: h - (line.bottom - y0),
          size,
          font,
          opacity: 0, // invisible but selectable & searchable
        });
      }
    }
    opts?.onProgress?.({ page: i + 1, pageCount, lostFonts });
  }

  return out.save();
}

/** Drop characters the embedded font can't encode (keeps copy/paste from throwing). */
function sanitizeForFont(s: string, font: { getCharacterSet?: () => number[] }): string {
  const set = font.getCharacterSet?.();
  if (!set) return s;
  const ok = new Set(set);
  let r = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x20 || cp === 0x0a || ok.has(cp)) r += ch;
  }
  return r;
}

/** Report which fonts a PDF carries that need restoration (for the UI preview). */
export function inspectPdf(srcBytes: Uint8Array): {
  pageCount: number;
  lostFonts: string[];
} {
  const src = mupdf.Document.openDocument(srcBytes, 'application/pdf').asPDF();
  if (!src) throw new Error('Not a PDF');
  const decoders = buildTagFontDecoders(src);
  return {
    pageCount: src.countPages(),
    lostFonts: [...decoders.lost.keys()].map((f) => f.split('+').pop() ?? f),
  };
}
