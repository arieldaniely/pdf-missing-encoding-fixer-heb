import { fixPdfEncoding, inspectPdfEncoding } from './encoding-fix';

const drop = document.getElementById('drop') as HTMLDivElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const log = document.getElementById('log') as HTMLDivElement;
const bar = document.getElementById('bar') as HTMLProgressElement;
const out = document.getElementById('out') as HTMLDivElement;

function say(msg: string) {
  log.textContent = msg;
}

async function handle(file: File) {
  out.innerHTML = '';
  bar.hidden = false;
  bar.value = 0;
  try {
    const info = inspectPdfEncoding(new Uint8Array(await file.arrayBuffer()));
    const fontList = info.lostFonts.length
      ? info.lostFonts.join(', ')
      : '(none — file already has correct text)';
    say(`קובץ: ${file.name}\nעמודים: ${info.pageCount}\nגופנים לתיקון: ${fontList}\n\nמעבד…`);

    // Re-read: mupdf detaches the input buffer it opens, so inspect and fix each
    // take their own copy.
    const { bytes: fixed, fixedFonts } = fixPdfEncoding(
      new Uint8Array(await file.arrayBuffer()),
      {
        onProgress: ({ font, fontCount, name }) => {
          bar.value = Math.round((font / fontCount) * 100);
          say(`מתקן גופן ${font} מתוך ${fontCount}: ${name}…`);
        },
      },
    );

    const blob = new Blob([fixed as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const name = file.name.replace(/\.pdf$/i, '') + '.fixed.pdf';
    out.innerHTML = `<a class="dl" href="${url}" download="${name}">הורדת ה‑PDF המתוקן</a>`;
    const fixedList = fixedFonts.length
      ? fixedFonts.map((f) => f.split('+').pop() ?? f).join(', ')
      : '(none)';
    say(`הסתיים. ${info.pageCount} עמודים. גופנים שתוקנו: ${fixedList}`);
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
