import fs from 'node:fs/promises';
import { exec } from 'node:child_process';

const begin = Date.now();
await fs.rm('woff2', { recursive: true }).catch(() => {});
await fs.mkdir('woff2', { recursive: true });
const otfFiles = await Array.fromAsync(fs.glob('otf/*.otf'));
/** @type {string[]} */
const fixes = [];
/** @type {string[]} */
const files = [];
let count = 0;
await Promise.all(
  otfFiles.map(async (otf) => {
    const result = await new Promise((resolve, reject) => {
      exec(
        `fontforge -quiet -script scripts/build-woff2-fontforge.py ${otf}`,
        (error, stdout, stderr) => {
          if (error) {
            console.error(stderr);
            reject(error);
            return;
          }
          resolve(
            stdout.split('\n').flatMap((x) => {
              try {
                return [JSON.parse(x)];
              } catch {
                return [];
              }
            }),
          );
        },
      );
    });
    for (const log of result) {
      switch (log.type) {
        case 'warn':
          console.log(`${log.type}: ${log.msg}`);
          break;
        case 'fix':
          fixes.push(`  - ${log.msg}`);
          break;
        case 'done':
          console.log(`[${++count}/${otfFiles.length}] ${otf} -> ${log.file}`);
          files.push(`${log.file} <- ${otf}`);
          break;
      }
    }
  }),
);
await fs.writeFile(
  'MANIFEST-WebCM.txt',
  [
    '# Web Computer Modern',
    `# Converted: ${new Date().getFullYear()}-${
      new Date().getMonth() + 1
    }-${new Date().getDate()} Tool: Custom Node.js scripts`,
    '# License: GUST Font LICENSE v1.0 or later (LPPL 1.3c or later)',
    '#',
    '# Original FIles: https://mirrors.ctan.org/fonts/newcomputermodern.zip',
    'Files',
    ...files.toSorted((a, b) => a.localeCompare(b)).map((x) => `  - ${x}`),
    'Changes',
    '  - OTFs converted to WOFF2; glyphs unaltered',
    '  - Font names renamed to WebCM to avoid clashes (per GFL request).',
    'And',
    ...fixes.toSorted((a, b) => a.localeCompare(b)),
    'Support',
    '  No warranty or maintenance from the original authors',
  ].join('\n'),
);
console.log(`Done in ${((Date.now() - begin) / 1000).toFixed(2)}s`);
