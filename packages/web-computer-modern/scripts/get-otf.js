import path from 'node:path';
import { ZipReader } from '@zip.js/zip.js';
import { HttpReader } from '@zip.js/zip.js';
import fs from 'node:fs/promises';
import { Uint8ArrayWriter } from '@zip.js/zip.js';

const begin = Date.now();

console.log('Cleaning directories...');
await fs.rm('otf', { recursive: true }).catch(() => {});
console.log(
  'Download package from https://mirrors.ctan.org/fonts/newcomputermodern.zip...',
);
const zip = new ZipReader(
  new HttpReader('https://mirrors.ctan.org/fonts/newcomputermodern.zip'),
);
await fs.mkdir('otf', { recursive: true });
for (const entry of await zip.getEntries()) {
  const targetDir = entry.filename.endsWith('.otf') ? 'otf' : null;
  if (targetDir == null) {
    console.log(`${entry.filename} ... skip`);
    continue;
  }
  console.log(`${entry.filename} ... save`);
  const name = path.parse(entry.filename).base;
  const data = await entry.getData?.(new Uint8ArrayWriter());
  if (data == null) {
    process.exit(1);
  }
  await fs.writeFile(path.join(targetDir, name), data);
}

console.log(`Done in ${((Date.now() - begin) / 1000).toFixed(2)}s`);
