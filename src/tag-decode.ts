/**
 * Generalized decoder for legacy Hebrew typesetting PDFs whose embedded fonts
 * lost their character→Unicode mapping (Tag/Sappir `Adv*`, "Shas" FrankRuehl/
 * Vilna, Guttman GHodes, …). These come from several typesetting systems with
 * incompatible byte/glyph-name conventions, but share ONE invariant: the font's
 * glyph table is laid out as the Hebrew alphabet in order (final-before-regular
 * for the 5 pairs), ending at ת. So a glyph at glyph-id `gid` decodes to
 * `LETTER_ORDER[gid - alpha]`, where `alpha` is a per-font base offset.
 *
 * This module is the pure, mupdf-free core: classify a font into a decoding
 * regime, solve its `alpha`, and decode a single glyph. The mupdf wiring (the
 * `Device`/`showGlyph` capture and per-document calibration) lives in
 * `textmap.ts`.
 *
 * See the project memory note `project_tag_sappir_fonts` for the analysis
 * across the sample corpus.
 */

/** 27 glyph slots: 22 letters + 5 finals, final-before-regular, ending at ת. */
export const LETTER_ORDER = Array.from('אבגדהוזחטיךכלםמןנסעףפץצקרשת');
const LETTER_INDEX: Record<string, number> = Object.fromEntries(
  LETTER_ORDER.map((c, i) => [c, i]),
);

/**
 * Universal "reused standard glyph slot" → Hebrew letter, keyed by the Unicode
 * codepoint mupdf returns for that standard PostScript glyph name. This is a
 * property of the Tag/Sappir glyph-slot convention (verified identical across
 * every full Adv* font in the corpus), not of any one file: e.g. the slot named
 * `AE` (which mupdf reports as U+00C6 'Æ') is always bet.
 */
export const LATIN_ANCHOR: Record<number, string> = {
  0x00c6: 'ב', // AE
  0x00aa: 'ד', // ordfeminine
  0x00ba: 'כ', // ordmasculine
  0x00d8: 'י', // Oslash
  0x0152: 'ך', // OE
  0x0153: 'ת', // oe
  0x00e6: 'ס', // ae
  0x00f8: 'ש', // oslash
  0x0142: 'ר', // lslash
  0x0141: 'ט', // Lslash
  0x0131: 'ץ', // dotlessi
};

export type FontRegime = 'honest' | 'cp1255' | 'lost';

export interface FontGlyphStats {
  total: number;
  /** glyphs whose unicode is in the Hebrew block 0x0590-0x05FF */
  heb: number;
  /** glyphs whose unicode is in the CP1255 Hebrew byte range 0xE0-0xFA */
  cp1255: number;
  /** glyphs mupdf could not map (U+FFFD) */
  fffd: number;
  /** glyphs in the Latin-1 upper range 0xC0-0xDF (pre-remap / MacRoman) */
  upper: number;
  /** glyphs in the control range 0x01-0x1F (raw subset codes) */
  ctrl: number;
}

/**
 * Decide how a font's glyphs should be decoded, from the distribution of the
 * Unicode codepoints mupdf produced for it:
 *   - `honest`  — already mostly real Hebrew (or legitimately non-Hebrew:
 *                 punctuation, symbols, real Latin); use mupdf's unicode as-is.
 *   - `cp1255`  — Latin-1 mojibake in the CP1255 Hebrew byte range; the existing
 *                 byte-decode path handles it (and preserves nikkud).
 *   - `lost`    — positive evidence the Hebrew mapping is broken (FFFD, Latin-1
 *                 upper / MacRoman remap, or raw control codes); glyph identity
 *                 must be recovered from the glyph-id.
 *
 * Crucially, a font with no Hebrew but no broken-mapping signal stays `honest`:
 * GID-restoring real punctuation or Latin text would corrupt it. (This means a
 * pure-ASCII-encoded Hebrew font — e.g. Guttman GHodes — is conservatively NOT
 * restored here; that case needs the font dict's missing-ToUnicode signal,
 * which is out of scope for this unicode-distribution classifier.)
 */
export function classifyFontRegime(stats: FontGlyphStats): FontRegime {
  if (stats.total === 0) return 'honest';
  if (stats.heb / stats.total > 0.3) return 'honest';
  if (stats.cp1255 / stats.total > 0.3) return 'cp1255';
  if ((stats.fffd + stats.upper + stats.ctrl) / stats.total > 0.3) return 'lost';
  return 'honest';
}

/**
 * If `unicode` is one of the universal Latin anchor slots, return the `alpha`
 * it implies for a glyph at `gid` (`gid - letterIndex`); otherwise `undefined`.
 * Lets callers accumulate anchor votes without touching the internal tables.
 */
export function anchorAlpha(gid: number, unicode: number): number | undefined {
  const heb = LATIN_ANCHOR[unicode];
  if (heb === undefined) return undefined;
  return gid - LETTER_INDEX[heb];
}

export interface GlyphSample {
  gid: number;
  unicode: number;
}

export interface AlphaResult {
  alpha: number;
  confident: boolean;
}

/**
 * Solve a lost-mapping font's base offset `alpha` such that
 * `gid - alpha` indexes into LETTER_ORDER.
 *
 * Primary signal: the universal Latin-slot anchors (Æ→ב, …). Each anchor glyph
 * gives `alpha = gid - letterIndex`; we take the majority vote. This is robust
 * (self-validating: anchors must agree) and needs no document-wide maximum.
 *
 * Fallback (fonts with no standard Latin anchors — e.g. TrueType "Shas" /
 * ASCII-subset fonts): `alpha = maxGid - 26`, assuming ת is the highest glyph
 * the font actually uses.
 */
export function solveAlpha(glyphs: GlyphSample[]): AlphaResult {
  const votes = new Map<number, number>();
  let maxGid = 0;
  for (const g of glyphs) {
    if (g.gid > maxGid) maxGid = g.gid;
    const heb = LATIN_ANCHOR[g.unicode];
    if (heb === undefined) continue;
    votes.set(
      g.gid - LETTER_INDEX[heb],
      (votes.get(g.gid - LETTER_INDEX[heb]) ?? 0) + 1,
    );
  }
  return solveAlphaFromVotes(votes, maxGid);
}

/**
 * Core of {@link solveAlpha}, working from pre-aggregated anchor votes
 * (`alpha → count`) and the font's maximum glyph-id. Lets the per-document
 * calibration pass accumulate incrementally without storing every glyph.
 */
export function solveAlphaFromVotes(
  votes: Map<number, number>,
  maxGid: number,
): AlphaResult {
  if (votes.size > 0) {
    let bestAlpha = 0;
    let bestVotes = 0;
    let totalVotes = 0;
    for (const [a, n] of votes) {
      totalVotes += n;
      if (n > bestVotes) {
        bestVotes = n;
        bestAlpha = a;
      }
    }
    // Confident when anchors are (near-)unanimous: a unique offset, or a clear
    // majority. Disagreement means the font breaks the assumption — flag it.
    return { alpha: bestAlpha, confident: bestVotes === totalVotes };
  }
  return { alpha: maxGid - 26, confident: false };
}

/**
 * Decode one glyph of a lost-mapping font.
 *   - In the letter range `[alpha, alpha+27)` → the Hebrew letter.
 *   - Otherwise (low gids: punctuation / nikkud) → pass through mupdf's own
 *     unicode if it is a sane printable character (honest punctuation), else
 *     drop it (`''`) so downstream searches aren't polluted by font noise.
 */
export function decodeGid(
  alpha: number,
  gid: number,
  fallbackUnicode: number,
): string {
  const li = gid - alpha;
  if (li >= 0 && li < LETTER_ORDER.length) return LETTER_ORDER[li];
  if (
    fallbackUnicode >= 0x20 &&
    fallbackUnicode <= 0x7e &&
    fallbackUnicode !== 0xfffd
  ) {
    return String.fromCodePoint(fallbackUnicode);
  }
  return '';
}
