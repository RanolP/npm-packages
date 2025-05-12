import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';

const woffFiles = {
  Devanagari: {
    '08': await listFilesPrefixed('WebCM Devanagari 08'),
    10: await listFilesPrefixed('WebCM Devanagari 10'),
  },
  Sans: {
    '08': await listFilesPrefixed('WebCM Sans 08'),
    10: await listFilesPrefixed('WebCM Sans 10'),
  },
  Serif: {
    '08': await listFilesPrefixed('WebCM Serif 08'),
    10: await listFilesPrefixed('WebCM Serif 10'),
  },
  Math: {
    Serif: await listFilesPrefixed('WebCM Math Serif'),
    Sans: await listFilesPrefixed('WebCM Math Sans'),
  },
  Mono: {
    10: await listFilesPrefixed('WebCM Mono 10'),
  },
  Uncial: {
    '08': await listFilesPrefixed('WebCM Uncial 08'),
    10: await listFilesPrefixed('WebCM Uncial 10'),
  },
};

const flattened = valuesRecursively(woffFiles);
const listed = new Set(Object.values(flattened).flat());
const rest = (await listFilesPrefixed()).filter((x) => !listed.has(x));

if (rest.length > 0) {
  console.log('warn: THere is uncovered woff2 files:');
  for (const file of rest) {
    console.log(`  - woff2/${file}`);
  }
  console.log();
  console.log();
}

let count = 0;
const flattenedEntries = Object.entries(flattened);
const output = await Promise.all(
  flattenedEntries.map(async ([name, value]) => {
    /** @type {string[]} */
    const content = [`/** ${name} */`];
    for (const fontPath of value) {
      const [family, subfamily, weight] = await new Promise(
        (resolve, reject) => {
          exec(
            `fontforge -lang=ff -c "Open($1); Print($familyname); Print(GetTTFName(0x409, 2)); Print(GetOS2Value(\\"Weight\\"));" ${JSON.stringify(
              path.join('woff2', fontPath),
            )}`,
            (error, stdout, stderr) => {
              if (error) {
                console.error(stderr);
                reject(error);
                return;
              }
              resolve(stdout.split(/[\r\n]+/).filter(Boolean));
            },
          );
        },
      );
      const isItalic =
        subfamily.includes('Italic') || subfamily.includes('Oblique');

      content.push(
        '@font-face {',
        `  font-family: ${JSON.stringify(family)};`,
        `  src: url(${JSON.stringify(
          path.posix.join('..', 'woff2', fontPath),
        )}) format("woff2");`,
        `  font-weight: ${weight};`,
        `  font-style: ${isItalic ? 'italic' : 'normal'};`,
        '}',
      );
    }

    console.log(
      `[${++count}/${flattenedEntries.length}] Web Computer Modern ${name}`,
    );

    return {
      name: name,
      content: content.join('\n'),
    };
  }),
);
output.toSorted((a, b) => a.name.localeCompare(b.name));

const fullCss = output.map((x) => x.content).join('\n');

await fs.rm('styles', { recursive: true }).catch(() => {});
await fs.mkdir('styles', { recursive: true });
await fs.writeFile('styles/index.css', fullCss, { encoding: 'utf-8' });

/**
 *
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
function listFilesPrefixed(prefix) {
  return Array.fromAsync(
    fs.glob(prefix ? `${prefix} *.woff2` : '*.woff2', { cwd: 'woff2' }),
  );
}

/**
 *
 * @param {unknown} object
 * @param {string[]} parentKeys
 * @returns {Record<string, string[]>}
 */
function valuesRecursively(object, parentKeys = []) {
  return Array.isArray(object)
    ? { [parentKeys.join(' ')]: object }
    : object && typeof object === 'object'
    ? Object.assign(
        {},
        ...Object.entries(object).map(([key, value]) =>
          valuesRecursively(value, [...parentKeys, key]),
        ),
      )
    : {};
}
