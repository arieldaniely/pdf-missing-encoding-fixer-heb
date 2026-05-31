# Tag/Sappir PDF Fixer

Upload a PDF whose embedded Hebrew fonts lost their character→Unicode mapping
(the classic **Tag/Sappir** `Adv*` output, "Shas" FrankRuehl/Vilna, Bnei‑Baruch
`Z_*`, and similar legacy typesetters) and get back a PDF that **looks identical
but has a correct, copy‑pasteable / searchable Hebrew text layer**.

Everything runs **client‑side** in the browser via `mupdf‑wasm` — no upload, no
server.

## How it works

Legacy Hebrew typesetting fonts share one invariant regardless of their byte or
glyph‑name convention: the glyph table is laid out as the Hebrew alphabet in
order (final‑before‑regular), ending at ת. So a glyph at glyph‑id `gid` decodes
to `LETTER_ORDER[gid - alpha]`, where the per‑font offset `alpha` is solved from
the universal Latin‑slot anchors (Æ→ב, Ø→י, …) or, failing that, `maxGid - 26`.

A per‑font router classifies each font from the distribution of the Unicode
codepoints mupdf produces for it:

| regime | signal | handling |
| --- | --- | --- |
| honest | mostly real Hebrew, or working ToUnicode | use as‑is |
| CP1255 | Latin‑1 mojibake 0xE0–0xFA | byte‑decode |
| lost | FFFD / Latin‑1 upper / control codes | **glyph‑id alphabet decode** |

The decoded text is laid over a rendered image of each original page as
invisible (selectable) text — an OCR‑style sandwich, so the result is correct
for every broken‑font regime, including Type3 vector fonts.

See `src/tag-decode.ts` (pure decoder) and `src/textmap.ts` (mupdf extraction).
This mirrors the decoder shipped in the Mugah pdf‑proofread add‑in.

## Develop

```bash
npm install
npm run dev        # local dev server
npm run smoke -- /path/to/input.pdf   # Node pipeline check
npm run build      # production build into dist/
```

## Deploy (GitHub Pages)

Push to `main`. The included workflow builds with `VITE_BASE=/tag-pdf-fixer/`
and publishes `dist/` to Pages. Enable Pages → "GitHub Actions" in the repo
settings once.

## Limitations

- **Type3 vector fonts** with no glyph identity can't be decoded deterministically.
- Pure‑ASCII‑encoded Hebrew fonts (e.g. some Guttman variants) are left untouched
  to avoid corrupting legitimate Latin text.
- Output embeds page rasters, so it is larger than the original and the original
  vector text is replaced by an invisible Unicode layer.
