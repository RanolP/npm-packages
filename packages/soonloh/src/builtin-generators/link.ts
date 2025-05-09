import { CommonSegment } from '../builtin-common-segment.js';
import { CodeGenerator } from '../core/config.js';

export const link: CodeGenerator<CommonSegment> = {
  name: 'soonloh:link',
  targetPath() {
    return 'src/generated/link.ts';
  },
  generate(paths) {
    return [
      'export interface LinkMap {',
      paths.map((path) => {
        const paramProps = path.segments.flatMap((segment) => {
          if (segment.kind !== 'param') return [];

          return `    ${JSON.stringify(segment.name)}${
            segment.optional ? '?' : ''
          }: ${segment.catchall ? 'string[]' : 'string'}`;
        });
        return [
          `  // ${path.filePosix}`,
          '  ' +
            JSON.stringify(
              '/' +
                path.segments
                  .flatMap((segment) => {
                    switch (segment.kind) {
                      case 'grouping':
                      case 'terminator':
                        return [];
                      case 'static':
                        return segment.path;
                      case 'param':
                        return `{${segment.catchall ? '*' : ''}${
                          segment.name
                        }}${segment.optional ? '?' : ''}`;
                    }
                  })
                  .join('/'),
            ) +
            (paramProps.length === 0 ? '?: never' : ': {'),
          ...(paramProps.length > 0 ? [...paramProps, '  }'] : []),
        ];
      }),
      '};',
      '',
      'export function path<',
      '  K extends keyof {',
      '    [K in keyof LinkMap as LinkMap[K] extends {} ? never : K]: 1;',
      '  },',
      '>(key: K): string;',
      'export function path<',
      '  K extends keyof {',
      '    [K in keyof LinkMap as LinkMap[K] extends {} ? K : never]: 1;',
      '  },',
      '>(key: K, props: LinkMap[K]): string;',
      'export function path<K extends keyof LinkMap>(key: K, props?: LinkMap[K]) {',
      String.raw`  return key.replace(/\{\*?(.+)\}\??/, (_, name) => {`,
      '    const value = (props as Record<string, string>)[name];',
      `    return Array.isArray(value) ? value.join('/') : value;`,
      '  });',
      '}',
      '',
    ]
      .flat(2)
      .join('\n');
  },
};
