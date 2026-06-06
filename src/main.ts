import { fixPdfEncoding, inspectPdfEncoding } from './encoding-fix';

const drop = document.getElementById('drop') as HTMLDivElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const log = document.getElementById('log') as HTMLDivElement;
const bar = document.getElementById('bar') as HTMLProgressElement;
const out = document.getElementById('out') as HTMLDivElement;

function say(msg: string) {
  log.textContent = msg;
}

function displayFontName(font: string): string {
  return font.split('+').pop() ?? font;
}

function compactFontList(fonts: string[], empty: string, limit = 24): string {
  const unique = [...new Set(fonts.map(displayFontName))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (unique.length === 0) return empty;
  const shown = unique.slice(0, limit).join(', ');
  const more = unique.length > limit ? `, ועוד ${unique.length - limit}` : '';
  return `${shown}${more}`;
}

async function handle(file: File) {
  out.innerHTML = '';
  bar.hidden = false;
  bar.value = 0;
  try {
    const info = inspectPdfEncoding(new Uint8Array(await file.arrayBuffer()));
    const fontList = compactFontList(
      info.lostFonts,
      '(אין - נראה שכבר יש מיפוי טקסט תקין)',
    );
    say(
      `קובץ: ${file.name}\n` +
        `עמודים: ${info.pageCount}\n` +
        `פונטים לתיקון: ${fontList}\n\n` +
        'מעבד...',
    );

    // Re-read: mupdf detaches the input buffer it opens, so inspect and fix each
    // take their own copy.
    const { bytes: fixed, fixedFonts } = fixPdfEncoding(
      new Uint8Array(await file.arrayBuffer()),
      {
        onProgress: ({ font, fontCount, name }) => {
          bar.value = Math.round((font / fontCount) * 100);
          say(`מתקן פונט ${font} מתוך ${fontCount}: ${name}...`);
        },
      },
    );

    const blob = new Blob([fixed as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const name = file.name.replace(/\.pdf$/i, '') + '.fixed.pdf';
    out.innerHTML = `<a class="dl" href="${url}" download="${name}">הורדת ה-PDF המתוקן</a>`;
    const fixedList = compactFontList(fixedFonts, '(אין)');
    say(
      `הסתיים. ${info.pageCount} עמודים.\n` +
        `פונטים שתוקנו: ${fixedList}`,
    );
    bar.hidden = true;
  } catch (e) {
    bar.hidden = true;
    say(`שגיאה: ${e instanceof Error ? e.message : String(e)}`);
  }
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) handle(fileInput.files[0]);
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) handle(f);
});
