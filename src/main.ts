import { fixPdf, inspectPdf } from './fix';

const drop = document.getElementById('drop') as HTMLDivElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const log = document.getElementById('log') as HTMLDivElement;
const bar = document.getElementById('bar') as HTMLProgressElement;
const out = document.getElementById('out') as HTMLDivElement;

let fontBytes: ArrayBuffer | null = null;
async function getFont(): Promise<ArrayBuffer> {
  if (fontBytes) return fontBytes;
  const b = await fetch(`${import.meta.env.BASE_URL}hebrew.ttf`).then((r) =>
    r.arrayBuffer(),
  );
  fontBytes = b;
  return b;
}

function say(msg: string) {
  log.textContent = msg;
}

async function handle(file: File) {
  out.innerHTML = '';
  bar.hidden = false;
  bar.value = 0;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = inspectPdf(bytes);
    const fontList = info.lostFonts.length
      ? info.lostFonts.join(', ')
      : '(none — file already has correct text)';
    say(`קובץ: ${file.name}\nעמודים: ${info.pageCount}\nגופנים לתיקון: ${fontList}\n\nמעבד…`);

    const font = await getFont();
    const fixed = await fixPdf(bytes, font, {
      onProgress: ({ page, pageCount }) => {
        bar.value = Math.round((page / pageCount) * 100);
        say(`מעבד עמוד ${page} מתוך ${pageCount}…`);
      },
    });

    const blob = new Blob([fixed as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const name = file.name.replace(/\.pdf$/i, '') + '.fixed.pdf';
    out.innerHTML = `<a class="dl" href="${url}" download="${name}">הורדת ה‑PDF המתוקן</a>`;
    say(`הסתיים. ${info.pageCount} עמודים. גופנים שתוקנו: ${fontList}`);
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
