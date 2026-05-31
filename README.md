# Hebrew PDF Text Fixer

Upload a Hebrew PDF whose embedded fonts lost their character→Unicode mapping —
the text looks fine on screen but comes out as garbage (mojibake, Latin letters,
or replacement characters) when you **copy, search, or extract** it. Get back a
PDF that **looks byte-for-byte identical but has a correct, copy-pasteable and
searchable Hebrew text layer**.

Everything runs **client-side** in the browser via `mupdf-wasm` — no upload, no
server.

## What it does (and doesn't)

The fixer **repairs the encoding in place**: it rewrites each broken font's
`/ToUnicode` map so its existing glyphs decode to the right Hebrew letters. The
page content — the original embedded glyphs, vectors and images — is left
completely untouched.

So the output:

- **looks exactly like the original** (the rendering is unchanged — verified
  pixel-identical), keeping crisp vector text rather than a rasterised image;
- **stays small** (no page images are embedded — the file size barely changes);
- **becomes correct** for copy, search and text extraction.

This replaces the older "rasterise each page + overlay invisible OCR-style text"
approach, which produced large, image-based files.

## How it works

Legacy Hebrew typesetting fonts come from several systems with incompatible
byte/glyph-name conventions, but the broken ones fall into two repairable
regimes, detected per font from the distribution of the Unicode codepoints mupdf
produces:

| regime | signal | repair |
| --- | --- | --- |
| honest | mostly real Hebrew, or working `ToUnicode` | left untouched |
| codepage | Latin-1 mojibake (CP1255-style) | map each glyph through the codepage table |
| lost | replacement chars / Latin-upper / control codes | **glyph-id alphabet decode** |

For the **lost** regime, the one invariant these fonts share is that their glyph
table is laid out as the Hebrew alphabet in order (final-before-regular, ending
at ת). So a glyph at glyph-id `gid` decodes to `LETTER_ORDER[gid - alpha]`, where
the per-font offset `alpha` is solved from universal Latin-slot anchors or, for
anchorless fonts, `maxGid - 26`.

The hard part is that mupdf never exposes the source **byte code** of a glyph
(only its glyph-id), and `/ToUnicode` must be keyed by code. The fixer recovers
the `code → glyph-id` map deterministically: for each font it builds a throwaway
**probe page** that shows all 256 single-byte codes in that font and reads back
the glyph-ids in content order (the k-th glyph is code k). Each glyph is then
decoded per its regime and the result is written as a fresh `/ToUnicode` CMap on
the font dictionary.

See `src/encoding-fix.ts` (the repairer + probe), `src/tag-decode.ts` (pure
glyph-id decoder) and `src/textmap.ts` (mupdf extraction, font classification and
codepage decoding).

## Develop

```bash
npm install
npm run dev        # local dev server
npm run smoke -- /path/to/input.pdf [out.pdf]   # Node pipeline check
npm run build      # production build into dist/
```

## Deploy (GitHub Pages)

Push to `master`. The included workflow builds with
`VITE_BASE=/pdf-missing-encoding-fixer-heb/` (the repo name, so asset paths
resolve under the project Pages URL) and publishes `dist/` to Pages. Enable
Pages → "GitHub Actions" in the repo settings once.

## Limitations

- Fonts with **no consistent glyph identity** (e.g. some Type3 vector fonts)
  can't be decoded deterministically.
- **Anchorless** lost fonts rely on the `maxGid - 26` guess; if their highest
  glyph isn't ת, some glyphs may not be recovered and keep their original
  (broken) text. The page still renders identically.
- Pure-ASCII-encoded Hebrew fonts that show no broken-mapping signal are left
  untouched, to avoid corrupting legitimate Latin text.
