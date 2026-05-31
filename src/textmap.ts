import * as mupdf from 'mupdf';
import {
  type AlphaResult,
  anchorAlpha,
  classifyFontRegime,
  decodeGid,
  type FontGlyphStats,
  solveAlphaFromVotes,
} from './tag-decode';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * One text region of a page (column/paragraph/title/footnote). Distinct blocks
 * are kept separate so that text searches never match across unrelated areas.
 *
 * `text` is a visual-line-grouped string: stext-lines that share a Y baseline
 * (which mupdf often splits when a single visual line was typeset as several
 * runs) are concatenated with no separator, while real line breaks within the
 * block are emitted as `\n`. `quads[i]` is the on-page quad for `text[i]`, or
 * `null` when `text[i]` is the inserted `\n`.
 */
export interface TextBlock {
  index: number;
  bbox: { x: number; y: number; w: number; h: number };
  text: string;
  quads: (mupdf.Quad | null)[];
}

export type ImageMediaType = 'image/png' | 'image/jpeg';

export interface PageContent {
  pageIdx: number;
  pageNum: number;
  blocks: TextBlock[];
  image: string;
  imageMediaType: ImageMediaType;
  width: number;
  height: number;
}

// Anthropic's API rejects images above 5 MB. We aim a touch lower so a single
// large render doesn't bump up against the boundary; if a PNG exceeds this we
// fall back to JPEG with decreasing quality until it fits.
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const JPEG_QUALITY_LADDER = [92, 80, 70, 60, 50];

function encodePixmapForLLM(pixmap: mupdf.Pixmap): {
  image: Uint8Array;
  imageMediaType: ImageMediaType;
} {
  const png = pixmap.asPNG();
  if (png.byteLength <= MAX_IMAGE_BYTES) {
    return { image: png, imageMediaType: 'image/png' };
  }
  let last: Uint8Array | null = null;
  for (const quality of JPEG_QUALITY_LADDER) {
    last = pixmap.asJPEG(quality);
    if (last.byteLength <= MAX_IMAGE_BYTES) {
      return { image: last, imageMediaType: 'image/jpeg' };
    }
  }
  return { image: last!, imageMediaType: 'image/jpeg' };
}

export interface TextMatch {
  blockIdx: number;
  startChar: number;
  endChar: number;
  quads: mupdf.Quad[];
  /**
   * `'exact'` when the AI quote matched verbatim after normalising whitespace,
   * combining marks and bidi-mirrored brackets. `'partial'` when only a
   * letter-only fallback matched (because punctuation/letter order differed in
   * the PDF byte stream).
   */
  precision: 'exact' | 'partial';
}

interface RawChar {
  ch: string;
  quad: mupdf.Quad;
  font: string;
}
interface RawLine {
  bbox: mupdf.Rect;
  chars: RawChar[];
}
interface RawBlock {
  bbox: mupdf.Rect;
  lines: RawLine[];
}

/**
 * Some PDFs (typesetting tools that pre-date proper Unicode font support)
 * embed Hebrew via fonts with a CP1255-style codepage mapping and no
 * `ToUnicode` CMap. mupdf then reports the raw byte values as Latin-1
 * supplement characters: e.g. `øäåæ` for what visually renders as `זוהר`.
 * The bytes 0xE0-0xFA line up 1-to-1 with U+05D0-U+05EA, and the runs are
 * stored visual-LTR (so a logical Hebrew word looks reversed). Mapping
 * the bytes plus reversing the run recovers real Hebrew.
 *
 * We work at the **run** level inside a line, not the whole line —
 * footnotes commonly mix one good-Hebrew sentence with a glyph-encoded
 * citation, and reversing real Hebrew would corrupt it. A run is a
 * contiguous sequence of Latin-1 supplement bytes (allowing intervening
 * ASCII whitespace/punctuation, which a CP1255 font also emits as ASCII
 * codepoints).
 */
function isCp1255Hebrew(cp: number): boolean {
  return cp >= 0xE0 && cp <= 0xFA;
}
function isLatin1Mojibake(cp: number): boolean {
  return cp >= 0x00C0 && cp <= 0x00FF;
}
function isAsciiPrintable(cp: number): boolean {
  return cp >= 0x20 && cp <= 0x7E;
}
/**
 * A Hebrew combining mark — nikkud (vowel points), dagesh, shin/sin dots and
 * te'amim (cantillation). These are zero-advance: they ride a base consonant
 * rather than occupying their own horizontal slot. (Range 0x05BE makaf and
 * 0x05C0/0x05C3/0x05C6 are punctuation, not combining, so excluded.)
 */
function isCombiningMark(cp: number): boolean {
  return (
    (cp >= 0x0591 && cp <= 0x05bd) ||
    cp === 0x05bf ||
    cp === 0x05c1 ||
    cp === 0x05c2 ||
    cp === 0x05c4 ||
    cp === 0x05c5 ||
    cp === 0x05c7
  );
}
/** A base letter: Hebrew consonant (incl. finals) or Latin — never a mark. */
function isBaseLetterCp(cp: number): boolean {
  return (
    (cp >= 0x05d0 && cp <= 0x05ea) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a)
  );
}

/**
 * Some Hebrew typesetting fonts spell nikkud as ASCII upper-letter glyph
 * slots (F, H, N, U, X, Y, Q, R, S, T, V, W, Z) and as Latin-1 chars in
 * the 0xC0-0xDF / 0xFB-0xFF range. After demojibake those are still in
 * the stream and would corrupt the searches. We strip them block-by-block
 * (not line-by-line) so a line of pure noise inside an otherwise-Hebrew
 * block also gets cleaned. Blocks with no Hebrew at all are left alone
 * — that preserves legitimate accented-Latin documents.
 */
function stripNikkudGlyphsInBlock(raw: RawBlock): void {
  const isHeb = (cp: number) => cp >= 0x0590 && cp <= 0x05FF;
  let hebCount = 0;
  for (const line of raw.lines) {
    for (const c of line.chars) {
      if (isHeb(c.ch.codePointAt(0) ?? 0)) hebCount++;
    }
  }
  if (hebCount === 0) return;
  for (const line of raw.lines) {
    line.chars = line.chars.filter((c) => {
      const cp = c.ch.codePointAt(0) ?? 0;
      // Latin-1 supplement and C1-control range left after demojibake are
      // unmapped font noise (the font's nikkud / cantillation glyph slots).
      // Z_PREVIW.MAP routes te'amim through bytes 0x80-0x9C in the pre-remap
      // convention — those slip below the 0xA0 boundary and would survive
      // otherwise.
      if (cp >= 0x0080 && cp <= 0x00FF) return false;
      // Any Latin letter inside a Hebrew block is — virtually always — a
      // nikkud glyph slot (Q, U, X, c, etc.). Real English words are rare
      // in a Hebrew document and the trade-off keeps searches clean.
      if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) return false;
      // Underscore — common vowel-mark slot.
      if (cp === 0x5F) return false;
      return true;
    });
  }
}

/**
 * Per-font glyph-slot mappings for Hebrew typesetting fonts that route some
 * letters through ASCII or extended-Latin codepoints (no `ToUnicode` CMap
 * to recover them).
 *
 * Key is a substring of the mupdf-reported font name (after the `+` subset
 * prefix). Value maps a single source char to its Hebrew letter — empty
 * string means "drop this glyph slot" (typically a nikkud / cantillation
 * mark we don't need for proofreading).
 *
 * Today we know the "Z_*" Bnei Baruch–style fonts: F and H are forms of
 * ש (with shin/sin dot baked in), X is י, the rest are vocalisation glyphs.
 * Add more entries here as we encounter new fonts.
 */
/**
 * Glyph-slot map for the Z_FR / Z_Vilna / Z_Margalit Hebrew typesetting
 * fonts (Bnei-Baruch / "Hasulam" lineage). Derived from the publisher's
 * own `Z_PREVIW.MAP` font definition: the font hosts dagesh-bearing /
 * shin-dot / vowel-aware letterforms in non-CP1255 codepoints, so the
 * byte mupdf reports back doesn't directly mean its ASCII letter.
 *
 * Two encoding conventions appear in the wild and `Z_PREVIW.MAP`
 * documents both — the ASCII upper-letter "post-remap" encoding
 * (Q-Z, [, \, ], …) and the ASCII lower-letter "pre-remap" encoding
 * (a-z). Both are listed here so PDFs using either convention extract
 * correctly. Every entry is the bare consonant the slot represents
 * (dagesh / shin-dot / vowel distinctions are folded onto the consonant
 * since proofreading only cares about letters).
 *
 * Where the two conventions disagree on the same byte we pick the
 * "post-remap" (uppercase) meaning, because that's what we've observed
 * mupdf emit on every sample PDF so far:
 *   - B → ך (kafs_shva)  (pre-remap meaning is ו vav_holam)
 *   - a → ק (qof_dagesh) (pre-remap meaning is ב bet_dagesh)
 *   - c → ת (tav_dagesh) (pre-remap meaning is ד dalet_dagesh)
 */
const Z_FONT_LETTER_MAP: Record<string, string> = {
  // Post-remap (uppercase) encoding — Z_PREVIW.MAP column 2
  A: 'ו', // vav + holam
  B: 'ך', // final-kaf + sheva
  C: 'ך', // final-kaf + qamats
  F: 'ש', // shin (shin-dot)
  G: 'ש', // shin (shin-dot) + dagesh
  H: 'ש', // shin (sin-dot)
  I: 'ש', // shin (sin-dot) + dagesh
  Q: 'ב', // bet + dagesh
  R: 'ג', // gimel + dagesh
  S: 'ד', // dalet + dagesh
  T: 'ה', // he + dagesh
  U: 'ו', // vav + dagesh
  V: 'ז', // zayin + dagesh
  W: 'ט', // tet + dagesh
  X: 'י', // yod + dagesh
  Y: 'ך', // final-kaf + dagesh
  Z: 'כ', // kaf + dagesh
  '[': 'ל', // lamed + dagesh
  '\\': 'מ', // mem + dagesh
  ']': 'נ', // nun + dagesh
  '^': 'ס', // samekh + dagesh
  _: 'פ', // pe + dagesh
  '`': 'צ', // sade + dagesh
  a: 'ק', // qof + dagesh
  c: 'ת', // tav + dagesh
  // Hebrew-specific dashes (Z_PREVIW.MAP lines 71/85 — endash/emdash).
  J: '–', // en-dash (U+2013), Z col 2 byte 0x4A
  K: '—', // em-dash (U+2014), Z col 2 byte 0x4B
  // Pre-remap (lowercase / shin-block) encoding — Z_PREVIW.MAP column 1.
  // No conflicts with the post-remap entries above.
  E: 'ך', // final-kaf + qamats (pre-remap)
  L: 'ש', // shin (shin-dot)  (pre-remap)
  M: 'ש', // shin (shin-dot) + dagesh
  N: 'ש', // shin (sin-dot)
  O: 'ש', // shin (sin-dot) + dagesh
  b: 'ג', // gimel + dagesh
  d: 'ה', // he + dagesh
  e: 'ו', // vav + dagesh
  f: 'ז', // zayin + dagesh
  h: 'ט', // tet + dagesh
  i: 'י', // yod + dagesh
  j: 'ך', // final-kaf + dagesh
  k: 'כ', // kaf + dagesh
  l: 'ל', // lamed + dagesh
  n: 'מ', // mem + dagesh
  p: 'נ', // nun + dagesh
  q: 'ס', // samekh + dagesh
  t: 'פ', // pe + dagesh
  v: 'צ', // sade + dagesh
  w: 'ק', // qof + dagesh
  z: 'ת', // tav + dagesh
};

// Bytes outside CP1255's 0xE0-0xFA Hebrew range that still encode Hebrew
// letters or Hebrew-specific punctuation in Z_PREVIW.MAP. Handled at
// fixMojibakeRuns level since they survive the run-anchor check
// (Latin-1 mojibake range) but aren't covered by the standard CP1255 decode
// and would otherwise be killed by the block-level Latin-1 strip.
const Z_EXTRA_HEBREW_BYTES: Record<number, string> = {
  0xFD: 'ר', // resh + dagesh
  0xFE: 'ח', // chet + dagesh
  0xDA: '־', // makaf (Hebrew word-connector, U+05BE)
  0xC1: '-', // hyphen (Z col 2 byte 193 per Z_PREVIW.MAP line 16)
};

const FONT_GLYPH_MAP: Record<string, Record<string, string>> = {
  Z_FR: Z_FONT_LETTER_MAP,
  Z_Vilna: Z_FONT_LETTER_MAP,
  Z_Margalit: Z_FONT_LETTER_MAP,
};

function fontGlyph(fontName: string, ch: string): string | undefined {
  for (const key of Object.keys(FONT_GLYPH_MAP)) {
    if (fontName.includes(key)) {
      return FONT_GLYPH_MAP[key][ch];
    }
  }
  return undefined;
}

/**
 * Decode one mojibake glyph of a CP1255-codepage font to its Hebrew letter,
 * from the font name and the Latin-1 codepoint mupdf reports for it. Mirrors
 * the per-character precedence of {@link fixMojibakeRuns} so the encoding fixer
 * (which rewrites `/ToUnicode`) recovers exactly the same letters the inline
 * text pipeline does: CP1255 Hebrew block → Z extra-byte table → font ASCII
 * glyph slot → ASCII passthrough → drop. Returns `''` for "no letter here".
 */
export function decodeCp1255Glyph(fontName: string, uni: number): string {
  if (isCp1255Hebrew(uni)) return String.fromCodePoint(uni - 0xe0 + 0x05d0);
  const extra = Z_EXTRA_HEBREW_BYTES[uni];
  if (extra !== undefined) return extra;
  const mapped = fontGlyph(fontName, String.fromCodePoint(uni));
  if (mapped !== undefined) return mapped; // '' means "drop this slot"
  if (isAsciiPrintable(uni)) return String.fromCodePoint(uni);
  return '';
}

/** Quad axis projections we use repeatedly when re-sorting / re-spacing. */
function quadXMin(q: mupdf.Quad): number {
  const a = q as unknown as number[];
  return Math.min(a[0], a[2], a[4], a[6]);
}
function quadXMax(q: mupdf.Quad): number {
  const a = q as unknown as number[];
  return Math.max(a[0], a[2], a[4], a[6]);
}
function quadYMin(q: mupdf.Quad): number {
  const a = q as unknown as number[];
  return Math.min(a[1], a[3], a[5], a[7]);
}
function quadYMax(q: mupdf.Quad): number {
  const a = q as unknown as number[];
  return Math.max(a[1], a[3], a[5], a[7]);
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Sort a Hebrew-dominant visual line by X-position descending (right→left).
 * mupdf delivers chars in PDF stream order, which for typesetters that place
 * each glyph at an absolute coordinate does not match logical reading order;
 * X-descending recovers it. JS sort is stable, so chars at equal X keep
 * stream order. Lines that aren't Hebrew-dominant are left alone so legitimate
 * LTR runs aren't reversed.
 *
 * After sorting RTL, embedded LTR sub-runs (digits, Latin letters) are
 * reversed in place — the global RTL sort flips their internal order, so
 * "12" inside a Hebrew sentence becomes "21" without this step.
 */
function isLtrSubChar(c: RawChar): boolean {
  const cp = c.ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5A) ||
    (cp >= 0x61 && cp <= 0x7A)
  );
}
function reverseLtrRuns(chars: RawChar[]): void {
  let i = 0;
  while (i < chars.length) {
    if (!isLtrSubChar(chars[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < chars.length && isLtrSubChar(chars[j])) j++;
    // Reverse [i, j) in place.
    for (let lo = i, hi = j - 1; lo < hi; lo++, hi--) {
      const tmp = chars[lo];
      chars[lo] = chars[hi];
      chars[hi] = tmp;
    }
    i = j;
  }
}
export function sortCharsByVisualOrder(chars: RawChar[]): void {
  if (chars.length < 2) return;
  let hebCount = 0;
  let latCount = 0;
  for (const c of chars) {
    const cp = c.ch.codePointAt(0) ?? 0;
    if (cp >= 0x0590 && cp <= 0x05FF) hebCount++;
    else if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) latCount++;
  }
  if (hebCount === 0 || latCount >= hebCount) return;

  const xCenter = (c: RawChar) => (quadXMin(c.quad) + quadXMax(c.quad)) / 2;

  // Combining marks are zero-advance, but pre-OpenType Hebrew fonts (the TAG
  // family) emit each mark as its own positioned glyph, so PDF stream order can
  // detach a vowel from its consonant — and a naive x-center sort can even
  // place a mark *ahead* of its base (the mark sits a hair right-of-centre).
  // We sort only the base/space/punctuation anchors, then re-attach every mark
  // to the base letter whose x-range covers it (else the nearest base letter),
  // keeping it immediately after that letter. Marks therefore never reorder a
  // word and never participate in inter-word spacing.
  const anchors: RawChar[] = [];
  const marks: RawChar[] = [];
  for (const c of chars) {
    if (isCombiningMark(c.ch.codePointAt(0) ?? 0)) marks.push(c);
    else anchors.push(c);
  }
  anchors.sort((a, b) => xCenter(b) - xCenter(a));

  const bases = anchors.filter((a) => isBaseLetterCp(a.ch.codePointAt(0) ?? 0));
  const riders = new Map<RawChar, RawChar[]>();
  for (const m of marks) {
    if (bases.length === 0) break;
    const mc = xCenter(m);
    let owner = bases[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const b of bases) {
      if (mc >= quadXMin(b.quad) && mc <= quadXMax(b.quad)) {
        owner = b;
        bestDist = -1;
        break;
      }
      const d = Math.abs(xCenter(b) - mc);
      if (d < bestDist) {
        bestDist = d;
        owner = b;
      }
    }
    const list = riders.get(owner);
    if (list) list.push(m);
    else riders.set(owner, [m]);
  }

  const merged: RawChar[] = [];
  for (const a of anchors) {
    merged.push(a);
    const ms = riders.get(a);
    if (ms) merged.push(...ms);
  }
  // Degenerate line with marks but no base letters: keep the marks rather than
  // drop them.
  if (bases.length === 0) merged.push(...marks);

  chars.length = 0;
  chars.push(...merged);
  reverseLtrRuns(chars);
}

/**
 * Combined post-sort cleanup: re-derive whitespace from quad geometry.
 * **Does not drop content** — footnote-reference letters, doubled
 * punctuation, and other oddities stay in the output verbatim because
 * they're often the very things we're trying to flag during proofreading.
 * We only use char height/baseline to decide *spacing*, since superscripts
 * are visually glued to the preceding body word and shouldn't trigger a
 * space between word and ref.
 *
 * Heuristics:
 *   - A char is **subordinate** (visually attached to the body run, not a
 *     space-worthy break) when its glyph height is < 70% of the line median
 *     letter height or its baseline sits > 25% of medH above the line's
 *     median baseline. Footnote letters, raised dots, vowel marks all match.
 *   - **Space** between two consecutive non-subordinate chars when the gap
 *     (after subtracting any subordinate's X-extent that sits between them)
 *     exceeds 35% of median body letter width. mupdf's own space heuristic
 *     over-fires on tight kerning ("א ם" inside אם) and under-fires on
 *     narrow inter-word gaps ("פטורלהחזיר"); geometry alone fixes both.
 *
 * Synthetic spaces get a quad covering the gap so highlight quads still land
 * correctly when a search match spans the boundary.
 */
export function cleanLine(chars: RawChar[]): RawChar[] {
  if (chars.length === 0) return chars;

  // Letters for line-metric stats (median height/baseline/width). Excludes
  // combining marks: they are zero-width/zero-advance riders and would skew
  // the medians toward zero.
  const isLetter = (c: RawChar) => {
    const cp = c.ch.codePointAt(0) ?? 0;
    return (
      ((cp >= 0x0590 && cp <= 0x05ff) ||
        (cp >= 0x41 && cp <= 0x5a) ||
        (cp >= 0x61 && cp <= 0x7a)) &&
      !isCombiningMark(cp)
    );
  };
  const letters = chars.filter(isLetter);

  let medH = 0;
  let medYMax = 0;
  if (letters.length >= 3) {
    medH = median(letters.map((c) => quadYMax(c.quad) - quadYMin(c.quad)));
    medYMax = median(letters.map((c) => quadYMax(c.quad)));
  }
  const isLetterCp = (cp: number): boolean =>
    (cp >= 0x0590 && cp <= 0x05FF) ||
    (cp >= 0x41 && cp <= 0x5A) ||
    (cp >= 0x61 && cp <= 0x7A);
  // A char is subordinate (visually attached, no space-worthy break) when its
  // baseline is raised — that's a superscript / footnote ref. We do NOT mark
  // letters subordinate purely by height, because mupdf often groups two
  // different-size body lines (e.g. Aramaic + smaller Hebrew translation) at
  // the same baseline; the smaller line is body text, not a superscript.
  // Non-letter glyphs (vowel marks, raised dots, punctuation oddities) at
  // half height *are* subordinate — they're decorations.
  const isSubordinate = (c: RawChar): boolean => {
    const cp = c.ch.codePointAt(0) ?? 0;
    // Combining marks ride their base consonant: never a space-worthy break,
    // regardless of line metrics.
    if (isCombiningMark(cp)) return true;
    if (medH <= 0) return false;
    const h = quadYMax(c.quad) - quadYMin(c.quad);
    if (medYMax - quadYMax(c.quad) > medH * 0.25) return true;
    if (!isLetterCp(cp) && h < medH * 0.5) return true;
    return false;
  };

  const bodyWidths = letters
    .filter((c) => !isSubordinate(c))
    .map((c) => quadXMax(c.quad) - quadXMin(c.quad))
    .filter((w) => w > 0.5);
  const medW = bodyWidths.length > 0 ? median(bodyWidths) : 0;
  const spaceThreshold = medW > 0 ? medW * 0.35 : 0;
  // Relaxed threshold used only where mupdf itself emitted a space character.
  // Pure geometry over-/under-fires on a tight, justified word space (e.g. a
  // letter-spaced title), so a real space whose gap dips just under the 0.35
  // geometric threshold would otherwise be dropped and glue the words. When
  // mupdf reported a space we trust it down to a lower bar — 0.15*medW sits
  // ~5x above the within-word gap noise floor (measured p95 ≈ 0.03*medW), so
  // it recovers tight spaces without splitting words on kerning over-fire.
  const relaxedThreshold = medW > 0 ? medW * 0.15 : 0;

  // First pass: drop existing whitespace but remember where mupdf put it, keep
  // everything else, decide which chars are subordinate (skipped for spacing).
  type Item = { c: RawChar; subordinate: boolean; spaceBefore: boolean };
  const items: Item[] = [];
  let pendingSpace = false;
  for (const c of chars) {
    if (/\s/.test(c.ch)) {
      pendingSpace = true;
      continue;
    }
    items.push({ c, subordinate: isSubordinate(c), spaceBefore: pendingSpace });
    pendingSpace = false;
  }
  if (items.length === 0) return [];

  // Second pass: emit chars; insert spaces between non-subordinate pairs whose
  // gap (after subtracting any sandwiched subordinates) exceeds the threshold —
  // or, where mupdf emitted a space, the relaxed threshold.
  const out: RawChar[] = [];
  let lastBody: RawChar | null = null;
  let subBetweenMinX = Infinity;
  let subBetweenMaxX = -Infinity;
  let mupdfSpaceSinceBody = false;

  for (const { c, subordinate, spaceBefore } of items) {
    if (spaceBefore) mupdfSpaceSinceBody = true;
    if (subordinate) {
      out.push(c);
      subBetweenMinX = Math.min(subBetweenMinX, quadXMin(c.quad));
      subBetweenMaxX = Math.max(subBetweenMaxX, quadXMax(c.quad));
      continue;
    }
    if (lastBody) {
      // Visual gap between the two body chars in RTL-sorted order. Subtract
      // any subordinate glyph extent that sits in between (footnote refs etc.
      // visually fill that gap, so they shouldn't induce a space).
      let gap = quadXMin(lastBody.quad) - quadXMax(c.quad);
      if (subBetweenMinX < Infinity) {
        gap -= subBetweenMaxX - subBetweenMinX;
      }
      // The relaxed (mupdf-confirmed) tier targets glued *words*. A mupdf space
      // is a real word break when the next segment STARTS with a base consonant
      // (Hebrew 0x05D0-0x05EA or Latin) — `c` here, since iteration is in RTL
      // reading order. Gating on the following char being a base letter keeps
      // the tier from (a) honouring spaces before punctuation — e.g. a
      // footnote-ref bracket before a period/comma — and (b) splitting a
      // vowel-pointed word at a nikkud/te'amim mark (not a base letter). What
      // precedes the space is irrelevant: `סי' פ"ו` (geresh → letter) is a real
      // break. Both excluded cases stay governed by the geometric tier.
      const startsWord = isBaseLetterCp(c.ch.codePointAt(0) ?? 0);
      const wantSpace =
        (spaceThreshold > 0 && gap > spaceThreshold) ||
        (startsWord &&
          mupdfSpaceSinceBody &&
          relaxedThreshold > 0 &&
          gap > relaxedThreshold);
      if (wantSpace) {
        const y0 = quadYMin(lastBody.quad);
        const y1 = quadYMax(lastBody.quad);
        const xLeft = quadXMax(c.quad);
        const xRight = quadXMin(lastBody.quad);
        const spaceQuad = [
          xLeft, y0,
          xRight, y0,
          xLeft, y1,
          xRight, y1,
        ] as unknown as mupdf.Quad;
        out.push({ ch: ' ', quad: spaceQuad, font: lastBody.font });
      }
      subBetweenMinX = Infinity;
      subBetweenMaxX = -Infinity;
    }
    out.push(c);
    lastBody = c;
    mupdfSpaceSinceBody = false;
  }
  return out;
}

function fixMojibakeRuns(chars: RawChar[]): RawChar[] {
  const result: RawChar[] = [];
  let i = 0;
  while (i < chars.length) {
    const cp = chars[i].ch.codePointAt(0) ?? 0;
    // Anchor a run on a Latin-1 char that's in the CP1255 Hebrew block —
    // or on a Z-font glyph slot (so a line like "תa" with Z-font gets the
    // 'a' mapped to ק even without an explicit CP1255 byte first).
    const fg = fontGlyph(chars[i].font, chars[i].ch);
    const isAnchor = isCp1255Hebrew(cp) || Z_EXTRA_HEBREW_BYTES[cp] !== undefined || fg !== undefined;
    if (!isAnchor) {
      result.push(chars[i]);
      i++;
      continue;
    }
    // Extend greedily while we keep seeing CP1255 Hebrew, Latin-1 bytes
    // or ASCII printables. This captures glyph-encoded Hebrew with
    // embedded ASCII spaces/quotes/digits.
    let j = i;
    while (j < chars.length) {
      const c = chars[j].ch.codePointAt(0) ?? 0;
      if (isCp1255Hebrew(c) || isAsciiPrintable(c) || isLatin1Mojibake(c)) {
        j++;
      } else {
        break;
      }
    }
    // Trim trailing chars that aren't CP1255 Hebrew — they probably
    // belong to the next, real-Hebrew run.
    while (j > i + 1) {
      const c = chars[j - 1].ch.codePointAt(0) ?? 0;
      if (isCp1255Hebrew(c) || isLatin1Mojibake(c)) break;
      j--;
    }

    const run: RawChar[] = [];
    for (let k = i; k < j; k++) {
      const c = chars[k];
      const cp2 = c.ch.codePointAt(0) ?? 0;
      if (isCp1255Hebrew(cp2)) {
        run.push({ ...c, ch: String.fromCodePoint(cp2 - 0xE0 + 0x05D0) });
        continue;
      }
      // Latin-1 bytes outside the CP1255 Hebrew block can still encode
      // Hebrew letters in the Z fonts (e.g. 0xFD = resh+dagesh, 0xFE =
      // chet+dagesh per Z_PREVIW.MAP). Consult the extra-bytes table
      // before falling through to the font-glyph slots.
      const extra = Z_EXTRA_HEBREW_BYTES[cp2];
      if (extra !== undefined) {
        run.push({ ...c, ch: extra });
        continue;
      }
      // ASCII letters / underscore / extended-Latin: consult the font
      // glyph map. Empty string means "drop"; non-empty maps to a
      // recovered Hebrew letter; undefined falls through.
      const mapped = fontGlyph(c.font, c.ch);
      if (mapped !== undefined) {
        if (mapped) run.push({ ...c, ch: mapped });
        continue;
      }
      // Default: keep ASCII printable, drop anything else. The strip
      // pass below will scrub remaining noise at block level.
      if (isAsciiPrintable(cp2)) run.push(c);
    }
    run.reverse();
    result.push(...run);
    i = j;
  }
  return result;
}

export interface RenderedImage {
  image: Uint8Array;
  imageMediaType: ImageMediaType;
  width: number;
  height: number;
}

/**
 * Rasterise a single page to an encoded bitmap (PNG, or JPEG when it would
 * exceed the LLM size cap). Kept separate from text extraction so the viewer
 * can re-render at a new zoom DPI without re-walking the structured text.
 */
export function renderPageImage(
  doc: mupdf.PDFDocument,
  pageIdx: number,
  dpi = 300,
): RenderedImage {
  const page = doc.loadPage(pageIdx);
  let pixmap: mupdf.Pixmap | null = null;
  try {
    const matrix = mupdf.Matrix.scale(dpi / 72, dpi / 72);
    // Force MediaBox so we always render the entire page, even when a CropBox
    // would clip part of it.
    pixmap = page.toPixmap(
      matrix,
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
      'View',
      'MediaBox',
    );
    const { image, imageMediaType } = encodePixmapForLLM(pixmap);
    return { image, imageMediaType, width: pixmap.getWidth(), height: pixmap.getHeight() };
  } finally {
    // mupdf objects live in the WASM heap and are only reclaimed by a
    // FinalizationRegistry, which fires under JS-GC pressure — never under
    // WASM-arena pressure. A page render is ~16 MB; without an explicit free
    // the arena saturates after ~100 pages and `malloc` fails. Free eagerly.
    pixmap?.destroy();
    page.destroy();
  }
}

/**
 * Per-document calibration of the legacy "lost-mapping" fonts (Tag/Sappir,
 * Shas, Guttman, …): the set of fonts whose glyph identity mupdf can't recover,
 * each with the base offset `alpha` needed to turn a glyph-id into a Hebrew
 * letter. Build once per opened PDF and thread into {@link extractPageText} /
 * {@link extractPageContent}; honest and CP1255 fonts are deliberately absent
 * (they stay on the existing unicode / byte-decode paths).
 */
export interface TagFontDecoders {
  lost: Map<string, AlphaResult>;
  /**
   * Font names classified as CP1255 codepage mojibake (mupdf reports their
   * bytes as Latin-1). The text pipeline byte-decodes them inline; the encoding
   * fixer uses this set to know which fonts get a CP1255-derived ToUnicode.
   */
  cp1255: Set<string>;
}

/**
 * Minimum glyph occurrences before trusting an anchor-less `maxGid-26` offset.
 * Real body/title fonts emit thousands; a font below this is too sparse for the
 * "highest glyph is ת" assumption to hold, so we leave it untouched.
 */
const MIN_GLYPHS_FOR_MAXGID = 200;

const fontNameOf = (font: mupdf.Font | null | undefined): string =>
  (font && typeof font.getName === 'function' ? font.getName() : '') ?? '';

/**
 * Run a page through a no-op rendering device purely to observe each glyph's
 * font, glyph-id, mupdf-unicode and on-page origin — the glyph-id is the only
 * place to recover the character identity that lost-mapping fonts destroyed
 * (`toStructuredText`/`onChar` expose unicode but not the gid).
 */
function forEachGlyph(
  doc: mupdf.PDFDocument,
  pageIdx: number,
  cb: (font: string, gid: number, unicode: number, x: number, y: number) => void,
): void {
  const page = doc.loadPage(pageIdx);
  // `showGlyph`'s `trm` origin is in PDF bottom-up user space (the page.run CTM
  // is reported separately and isn't folded into `trm`), whereas
  // `toStructuredText`'s `onChar` origin is top-down (y from the page top). Flip
  // the captured y by the page height so the two line up for matching. (x and
  // gid are unaffected.)
  // `showGlyph`'s `trm` is the glyph matrix in its text object's space; the
  // device CTM (mupdf's page flip plus any Form-XObject transform) is reported
  // separately. The page-space origin `onChar` reports is the CTM applied to the
  // trm origin — apply it generally (handles glyphs nested in XObjects, e.g.
  // running heads, which a fixed page-height flip would misplace).
  const visit = (text: mupdf.Text, ctm: mupdf.Matrix) => {
    text.walk({
      showGlyph(font, trm, gid, unicode) {
        const px = trm[4];
        const py = trm[5];
        const x = ctm[0] * px + ctm[2] * py + ctm[4];
        const y = ctm[1] * px + ctm[3] * py + ctm[5];
        cb(fontNameOf(font), gid, unicode || 0, x, y);
      },
    });
  };
  const device = new mupdf.Device({
    fillText: (text, ctm) => visit(text, ctm),
    clipText: (text, ctm) => visit(text, ctm),
    ignoreText: (text, ctm) => visit(text, ctm),
  });
  try {
    page.run(device, mupdf.Matrix.identity);
  } finally {
    device.close();
    device.destroy();
    page.destroy();
  }
}

/**
 * Scan the document, classify every font, and solve `alpha` for the
 * lost-mapping ones. Scanning is capped (`maxPages`, default 60) — body fonts
 * recur on every page, so a small prefix yields a font's full anchor set and
 * its maximum glyph-id.
 */
export function buildTagFontDecoders(
  doc: mupdf.PDFDocument,
  opts?: { maxPages?: number },
): TagFontDecoders {
  const pageCount = doc.countPages();
  const scan = Math.min(pageCount, opts?.maxPages ?? 60);
  const stats = new Map<string, FontGlyphStats>();
  const votes = new Map<string, Map<number, number>>();
  const maxGid = new Map<string, number>();

  for (let p = 0; p < scan; p++) {
    forEachGlyph(doc, p, (font, gid, unicode) => {
      let s = stats.get(font);
      if (!s) {
        s = { total: 0, heb: 0, cp1255: 0, fffd: 0, upper: 0, ctrl: 0 };
        stats.set(font, s);
      }
      s.total++;
      if (unicode === 0xfffd) s.fffd++;
      else if (unicode >= 0x0590 && unicode <= 0x05ff) s.heb++;
      else if (unicode >= 0xe0 && unicode <= 0xfa) s.cp1255++;
      else if (unicode >= 0xc0 && unicode <= 0xdf) s.upper++;
      else if (unicode >= 0x01 && unicode <= 0x1f) s.ctrl++;

      maxGid.set(font, Math.max(maxGid.get(font) ?? 0, gid));
      const a = anchorAlpha(gid, unicode);
      if (a !== undefined) {
        let v = votes.get(font);
        if (!v) {
          v = new Map();
          votes.set(font, v);
        }
        v.set(a, (v.get(a) ?? 0) + 1);
      }
    });
  }

  const lost = new Map<string, AlphaResult>();
  const cp1255 = new Set<string>();
  for (const [font, s] of stats) {
    const regime = classifyFontRegime(s);
    if (regime === 'cp1255') {
      cp1255.add(font);
      continue;
    }
    if (regime !== 'lost') continue;
    const r = solveAlphaFromVotes(
      votes.get(font) ?? new Map(),
      maxGid.get(font) ?? 0,
    );
    // Only restore when calibration is trustworthy: either the Latin anchors
    // agreed (confident), or the font carries enough glyphs that its
    // `maxGid-26` offset is reliable (it surely contains a full alphabet ending
    // at ת). Sparse decorative fonts fail both and are left untouched rather
    // than risk emitting garbage from a mis-guessed offset.
    if (r.confident || s.total >= MIN_GLYPHS_FOR_MAXGID) lost.set(font, r);
  }
  return { lost, cp1255 };
}

/**
 * Map every lost-mapping glyph on a page from its on-page origin to its
 * glyph-id + mupdf-unicode, so the structured-text walk (which only sees
 * unicode) can swap in the GID-decoded Hebrew letter. Keyed on the pen origin,
 * which `onChar`'s `origin` and `showGlyph`'s `trm` report identically.
 */
function originKey(x: number, y: number): string {
  return `${Math.round(x * 2)},${Math.round(y * 2)}`;
}
function buildLostGlyphMap(
  doc: mupdf.PDFDocument,
  pageIdx: number,
  decoders: TagFontDecoders,
): Map<string, { gid: number; unicode: number }> {
  const map = new Map<string, { gid: number; unicode: number }>();
  forEachGlyph(doc, pageIdx, (font, gid, unicode, x, y) => {
    if (!decoders.lost.has(font)) return;
    map.set(`${font}|${originKey(x, y)}`, { gid, unicode });
  });
  return map;
}

/**
 * Walk a page's structured text into cleaned, reading-ordered blocks. The
 * result is independent of render DPI, so the viewer extracts it once per page
 * regardless of zoom level. Pass `decoders` (from {@link buildTagFontDecoders})
 * to restore legacy lost-mapping fonts; without it, behaviour is unchanged.
 */
export function extractPageText(
  doc: mupdf.PDFDocument,
  pageIdx: number,
  decoders?: TagFontDecoders,
): TextBlock[] {
  const page = doc.loadPage(pageIdx);
  let stext: mupdf.StructuredText | null = null;
  try {
    stext = page.toStructuredText('preserve-whitespace');
    const lostGlyphs =
      decoders && decoders.lost.size > 0
        ? buildLostGlyphMap(doc, pageIdx, decoders)
        : null;
    return walkStructuredText(stext, decoders ?? null, lostGlyphs);
  } finally {
    // Free the WASM-heap objects (see renderPageImage for why this matters).
    stext?.destroy();
    page.destroy();
  }
}

function walkStructuredText(
  stext: mupdf.StructuredText,
  decoders: TagFontDecoders | null,
  lostGlyphs: Map<string, { gid: number; unicode: number }> | null,
): TextBlock[] {
  const rawBlocks: RawBlock[] = [];
  let curBlock: RawBlock | null = null;
  let curLine: RawLine | null = null;

  stext.walk({
    beginTextBlock(bbox) {
      curBlock = { bbox, lines: [] };
    },
    endTextBlock() {
      if (curBlock) rawBlocks.push(curBlock);
      curBlock = null;
    },
    beginLine(bbox) {
      curLine = { bbox, chars: [] };
    },
    endLine() {
      if (curLine && curBlock) {
        curLine.chars = fixMojibakeRuns(curLine.chars);
        curBlock.lines.push(curLine);
      }
      curLine = null;
    },
    onChar(ch, origin, font, size, quad) {
      // Drop degenerate microscopic glyphs (some PDFs hide metadata text at
      // corners with sub-point font size). Real text is at least ~5pt; we
      // gate at 2pt to be safe. mupdf's bbox is also tiny in those cases.
      if (typeof size === 'number' && size > 0 && size < 2) return;
      const h = quadYMax(quad) - quadYMin(quad);
      if (h > 0 && h < 1) return;
      const fontName = fontNameOf(font);
      // Lost-mapping font: replace mupdf's garbage unicode with the letter
      // recovered from this glyph's glyph-id (matched by pen origin). An empty
      // decode (undecodable low-gid noise) drops the glyph entirely.
      const decoder = decoders?.lost.get(fontName);
      if (decoder && lostGlyphs) {
        const g = lostGlyphs.get(`${fontName}|${originKey(origin[0], origin[1])}`);
        if (g) {
          const decoded = decodeGid(decoder.alpha, g.gid, g.unicode);
          if (!decoded) return;
          curLine?.chars.push({ ch: decoded, quad, font: fontName });
          return;
        }
      }
      curLine?.chars.push({ ch, quad, font: fontName });
    },
  });

  for (const raw of rawBlocks) {
    stripNikkudGlyphsInBlock(raw);
  }

  const blocks: TextBlock[] = [];
  for (const raw of rawBlocks) {
    const tb = assembleBlock(blocks.length, raw);
    if (tb) blocks.push(tb);
  }
  return blocks;
}

export function extractPageContent(
  doc: mupdf.PDFDocument,
  pageIdx: number,
  dpi = 300,
  decoders?: TagFontDecoders,
): PageContent {
  const { image, imageMediaType, width, height } = renderPageImage(doc, pageIdx, dpi);
  const blocks = extractPageText(doc, pageIdx, decoders);
  return { pageIdx, pageNum: pageIdx + 1, blocks, image: toBase64(image), imageMediaType, width, height };
}

function assembleBlock(index: number, raw: RawBlock): TextBlock | null {
  if (raw.lines.length === 0) return null;

  // Group lines by visual baseline. Two mupdf-lines belong to the same visual
  // line when their Y baselines are close enough — typesetters that emit each
  // glyph or word as a separate run land here, and so do titles set glyph-by-
  // glyph. Once grouped, we sort chars in the group by X (right→left for
  // Hebrew-dominant groups), which recovers logical reading order even when
  // mupdf's stream order shuffles letters within a word.
  const groups: { chars: RawChar[]; h: number }[] = [];
  let prevY: number | null = null;
  let prevH = 0;
  for (const line of raw.lines) {
    if (line.chars.length === 0) continue;
    const [, y0, , y1] = line.bbox;
    const h = y1 - y0;
    if (prevY != null && Math.abs(y0 - prevY) <= Math.max(2, prevH * 0.5)) {
      groups[groups.length - 1].chars.push(...line.chars);
      groups[groups.length - 1].h = Math.max(groups[groups.length - 1].h, h);
    } else {
      groups.push({ chars: [...line.chars], h });
    }
    prevY = y0;
    prevH = h;
  }

  let text = '';
  const quads: (mupdf.Quad | null)[] = [];
  for (let i = 0; i < groups.length; i++) {
    sortCharsByVisualOrder(groups[i].chars);
    const chars = cleanLine(groups[i].chars);
    if (chars.length === 0) continue;
    if (i > 0 && text.length > 0) {
      text += '\n';
      quads.push(null);
    }
    for (const c of chars) {
      text += c.ch;
      quads.push(c.quad);
    }
  }

  if (!text.trim()) return null;

  const [x0, y0, x1, y1] = raw.bbox;
  return {
    index,
    bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    text,
    quads,
  };
}

/**
 * Bidi mirroring pairs: in RTL contexts the PDF text-extraction layer reports
 * `(` where the rendered glyph is visually `)`, and similarly for the other
 * mirroring pairs. Canonicalising every closer to its opener lets the search
 * match across that mismatch without removing the character (so the highlight
 * still covers the actual punctuation).
 */
const BIDI_MIRROR: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
  '>': '<',
};

/**
 * Build a normalised search key for `s` plus a map from each emitted character
 * back to its index in the original string. `keep` decides which original
 * characters contribute (after NFKD-decomposing and dropping combining marks).
 *   - exact mode: drop only whitespace, canonicalise mirrored brackets.
 *   - letters mode: drop everything except letters and digits — used as a
 *     fallback so AI quotes whose brackets/spaces sit in different positions
 *     than the PDF byte stream still locate.
 */
function buildSearchKey(
  s: string,
  mode: 'exact' | 'letters',
): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) continue;
    const mapped = BIDI_MIRROR[c] ?? c;
    for (const dec of mapped.normalize('NFKD')) {
      if (/\p{M}/u.test(dec)) continue;
      if (mode === 'letters' && !/[\p{L}\p{N}]/u.test(dec)) continue;
      out.push(dec);
      map.push(i);
    }
  }
  return { text: out.join(''), map };
}

function tryFind(
  blocks: TextBlock[],
  target: string,
  mode: 'exact' | 'letters',
): TextMatch | null {
  const t = buildSearchKey(target, mode).text;
  if (!t) return null;
  for (const block of blocks) {
    const key = buildSearchKey(block.text, mode);
    const idx = key.text.indexOf(t);
    if (idx < 0) continue;
    const startChar = key.map[idx];
    const endChar = key.map[idx + t.length - 1] + 1;
    const quads: mupdf.Quad[] = [];
    for (let i = startChar; i < endChar; i++) {
      const q = block.quads[i];
      if (q) quads.push(q);
    }
    return {
      blockIdx: block.index,
      startChar,
      endChar,
      quads,
      precision: mode === 'exact' ? 'exact' : 'partial',
    };
  }
  return null;
}

/**
 * Locate `target` inside any single block. Tries an exact pass first
 * (whitespace, combining marks, and bidi-mirrored brackets normalised), then
 * falls back to a letter-only pass that ignores all punctuation/spacing in
 * the comparison while still mapping the highlight quads back to the original
 * characters (so brackets and commas are still covered visually).
 */
export function findText(blocks: TextBlock[], target: string): TextMatch | null {
  return tryFind(blocks, target, 'exact') ?? tryFind(blocks, target, 'letters');
}

export function formatBlocksForLLM(blocks: TextBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}
