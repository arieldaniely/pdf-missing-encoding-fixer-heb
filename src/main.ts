import { fixPdfEncoding, inspectPdfEncoding } from './encoding-fix';

const drop = document.getElementById('drop') as HTMLDivElement;
const pickFile = document.getElementById('pick-file') as HTMLButtonElement;
const pickFolder = document.getElementById('pick-folder') as HTMLButtonElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const folderInput = document.getElementById('folder') as HTMLInputElement;
const log = document.getElementById('log') as HTMLDivElement;
const bar = document.getElementById('bar') as HTMLProgressElement;
const out = document.getElementById('out') as HTMLDivElement;

folderInput.setAttribute('webkitdirectory', '');
folderInput.setAttribute('directory', '');

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

type PdfJob = {
  file: File;
  path: string;
};

type FixedPdf = {
  outputPath: string;
  bytes: Uint8Array;
  pageCount: number;
  fixedFonts: string[];
  lastModified: number;
};

type ZipEntry = {
  path: string;
  bytes: Uint8Array;
  date: Date;
};

type BrowserFileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
};

type BrowserFileSystemFileEntry = BrowserFileSystemEntry & {
  file(success: (file: File) => void, error?: (err: DOMException) => void): void;
};

type BrowserFileSystemDirectoryEntry = BrowserFileSystemEntry & {
  createReader(): {
    readEntries(
      success: (entries: BrowserFileSystemEntry[]) => void,
      error?: (err: DOMException) => void,
    ): void;
  };
};

function filePath(file: File): string {
  const withRelativePath = file as File & { webkitRelativePath?: string };
  return withRelativePath.webkitRelativePath || file.name;
}

function outputPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.replace(/\.pdf$/i, '.fixed.pdf');
}

function pdfJobs(files: File[]): PdfJob[] {
  return files
    .filter((file) => /\.pdf$/i.test(file.name))
    .map((file) => ({ file, path: filePath(file) }));
}

async function fixOnePdf(
  job: PdfJob,
  index: number,
  total: number,
): Promise<FixedPdf> {
  const info = inspectPdfEncoding(new Uint8Array(await job.file.arrayBuffer()));
  const fontList = compactFontList(
    info.lostFonts,
    '(אין - נראה שכבר יש מיפוי טקסט תקין)',
  );
  say(
    `קובץ ${index + 1} מתוך ${total}: ${job.path}\n` +
      `עמודים: ${info.pageCount}\n` +
      `פונטים לתיקון: ${fontList}\n\n` +
      'מעבד...',
  );

  // Re-read: mupdf detaches the input buffer it opens, so inspect and fix each
  // take their own copy.
  const { bytes, fixedFonts } = fixPdfEncoding(
    new Uint8Array(await job.file.arrayBuffer()),
    {
      onProgress: ({ font, fontCount, name }) => {
        const fileProgress = fontCount === 0 ? 1 : font / fontCount;
        bar.value = Math.round(((index + fileProgress) / total) * 100);
        say(
          `קובץ ${index + 1} מתוך ${total}: ${job.path}\n` +
            `מתקן פונט ${font} מתוך ${fontCount}: ${name}...`,
        );
      },
    },
  );

  bar.value = Math.round(((index + 1) / total) * 100);
  return {
    outputPath: outputPath(job.path),
    bytes,
    pageCount: info.pageCount,
    fixedFonts,
    lastModified: job.file.lastModified,
  };
}

function makeDownload(blob: Blob, filename: string, label: string) {
  const url = URL.createObjectURL(blob);
  out.innerHTML = `<a class="dl" href="${url}" download="${filename}">${label}</a>`;
}

async function handleFiles(files: File[], preferZip = false) {
  await handleJobs(pdfJobs(files), preferZip);
}

async function handleJobs(jobs: PdfJob[], preferZip = false) {
  out.innerHTML = '';
  if (jobs.length === 0) {
    say('לא נמצאו קבצי PDF לביצוע.');
    return;
  }

  bar.hidden = false;
  bar.value = 0;
  try {
    const fixed: FixedPdf[] = [];
    for (let i = 0; i < jobs.length; i++) {
      fixed.push(await fixOnePdf(jobs[i], i, jobs.length));
    }

    if (fixed.length === 1 && !preferZip) {
      makeDownload(
        new Blob([fixed[0].bytes as BlobPart], { type: 'application/pdf' }),
        fixed[0].outputPath.split('/').pop() ?? 'fixed.pdf',
        'הורדת ה-PDF המתוקן',
      );
    } else {
      const zip = createZip(
        fixed.map((item) => ({
          path: item.outputPath,
          bytes: item.bytes,
          date: new Date(item.lastModified || Date.now()),
        })),
      );
      makeDownload(
        new Blob([zip as BlobPart], { type: 'application/zip' }),
        'fixed-pdfs.zip',
        'הורדת ZIP עם כל הקבצים המתוקנים',
      );
    }

    const fixedFonts = fixed.flatMap((item) => item.fixedFonts);
    const fixedList = compactFontList(fixedFonts, '(אין)');
    const pages = fixed.reduce((sum, item) => sum + item.pageCount, 0);
    say(
      `הסתיים. ${fixed.length} קבצים, ${pages} עמודים.\n` +
        `פונטים שתוקנו: ${fixedList}`,
    );
  } catch (e) {
    say(`שגיאה: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    bar.hidden = true;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < crcTable.length; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): number {
  return (
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  );
}

function dosDate(date: Date): number {
  const year = Math.max(1980, date.getFullYear());
  return ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function write16(out: number[], value: number) {
  out.push(value & 0xff, (value >>> 8) & 0xff);
}

function write32(out: number[], value: number) {
  out.push(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function append(out: number[], bytes: Uint8Array) {
  for (const byte of bytes) out.push(byte);
}

function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const centralDirectory: number[] = [];

  for (const entry of entries) {
    const pathBytes = encoder.encode(entry.path.replace(/\\/g, '/'));
    const crc = crc32(entry.bytes);
    const offset = chunks.length;
    const time = dosTime(entry.date);
    const date = dosDate(entry.date);

    write32(chunks, 0x04034b50);
    write16(chunks, 20);
    write16(chunks, 0x0800);
    write16(chunks, 0);
    write16(chunks, time);
    write16(chunks, date);
    write32(chunks, crc);
    write32(chunks, entry.bytes.length);
    write32(chunks, entry.bytes.length);
    write16(chunks, pathBytes.length);
    write16(chunks, 0);
    append(chunks, pathBytes);
    append(chunks, entry.bytes);

    write32(centralDirectory, 0x02014b50);
    write16(centralDirectory, 20);
    write16(centralDirectory, 20);
    write16(centralDirectory, 0x0800);
    write16(centralDirectory, 0);
    write16(centralDirectory, time);
    write16(centralDirectory, date);
    write32(centralDirectory, crc);
    write32(centralDirectory, entry.bytes.length);
    write32(centralDirectory, entry.bytes.length);
    write16(centralDirectory, pathBytes.length);
    write16(centralDirectory, 0);
    write16(centralDirectory, 0);
    write16(centralDirectory, 0);
    write16(centralDirectory, 0);
    write32(centralDirectory, 0);
    write32(centralDirectory, offset);
    append(centralDirectory, pathBytes);
  }

  const centralOffset = chunks.length;
  append(chunks, Uint8Array.from(centralDirectory));
  write32(chunks, 0x06054b50);
  write16(chunks, 0);
  write16(chunks, 0);
  write16(chunks, entries.length);
  write16(chunks, entries.length);
  write32(chunks, centralDirectory.length);
  write32(chunks, centralOffset);
  write16(chunks, 0);
  return Uint8Array.from(chunks);
}

async function filesFromEntry(
  entry: BrowserFileSystemEntry,
  path = '',
): Promise<PdfJob[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as BrowserFileSystemFileEntry).file((file) => {
        resolve([{ file, path: `${path}${file.name}` }]);
      }, reject);
    });
  }

  if (!entry.isDirectory) return [];
  const directory = entry as BrowserFileSystemDirectoryEntry;
  const reader = directory.createReader();
  const entries: BrowserFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<BrowserFileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    entries.push(...batch);
  }
  const nested = await Promise.all(
    entries.map((child) => filesFromEntry(child, `${path}${entry.name}/`)),
  );
  return nested.flat();
}

async function jobsFromDrop(e: DragEvent): Promise<PdfJob[]> {
  const items = [...(e.dataTransfer?.items ?? [])];
  const entryReaders = items
    .map((item) => {
      const withEntry = item as unknown as {
        webkitGetAsEntry?: () => BrowserFileSystemEntry | null;
      };
      return withEntry.webkitGetAsEntry?.() ?? null;
    })
    .filter((entry): entry is BrowserFileSystemEntry => entry !== null);

  if (entryReaders.length > 0) {
    const nested = await Promise.all(entryReaders.map((entry) => filesFromEntry(entry)));
    return nested.flat().filter((job) => /\.pdf$/i.test(job.file.name));
  }
  return pdfJobs([...(e.dataTransfer?.files ?? [])]);
}

pickFile.addEventListener('click', () => fileInput.click());
pickFolder.addEventListener('click', () => folderInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) handleFiles([...fileInput.files]);
  fileInput.value = '';
});
folderInput.addEventListener('change', () => {
  if (folderInput.files?.length) handleFiles([...folderInput.files], true);
  folderInput.value = '';
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  void jobsFromDrop(e).then((jobs) => handleJobs(jobs, jobs.length > 1));
});
