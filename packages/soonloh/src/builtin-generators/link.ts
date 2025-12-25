import { CommonSegment } from '../builtin-common-segment.js';
import { CodeGenerator } from '../core/config.js';

interface Options {
  targetPath?: (pathSafeBranch: string) => string;
  filter?: (terminator: string | null) => boolean;
}
export const genLink = ({
  targetPath = () => 'src/generated/link.ts',
  filter = () => true,
}: Options): CodeGenerator<CommonSegment> => ({
  name: 'soonloh:link',
  targetPath,
  generate(routes) {
    return [
      'export interface LinkMap {',
      routes.flatMap((route) => {
        if (
          !filter(
            route.segments.reduce<string | null>(
              (acc, segment) =>
                acc == null && segment.kind === 'terminator'
                  ? segment.path
                  : acc,
              null,
            ),
          )
        ) {
          return [];
        }

        const paramProps = route.segments.flatMap((segment) => {
          if (segment.kind !== 'param') return [];

          return `    ${JSON.stringify(segment.name)}${
            segment.optional ? '?' : ''
          }: ${segment.catchall ? 'string[]' : 'string'}`;
        });
        return [
          [
            `  // ${route.filePosix}`,
            '  ' +
              JSON.stringify(
                '/' +
                  route.segments
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
          ],
        ];
      }),
      '};',
      '',
      'export function link<',
      '  K extends keyof {',
      '    [K in keyof LinkMap as LinkMap[K] extends {} ? never : K]: 1;',
      '  },',
      '>(key: K): string;',
      'export function link<',
      '  K extends keyof {',
      '    [K in keyof LinkMap as LinkMap[K] extends {} ? K : never]: 1;',
      '  },',
      '>(key: K, props: LinkMap[K]): string;',
      'export function link<K extends keyof LinkMap>(key: K, props?: LinkMap[K]) {',
      String.raw`  return key.replace(/\{\*?(.+)\}\??/, (_, name) => {`,
      '    const value = ((props ?? {}) as Record<string, string>)[name];',
      `    return Array.isArray(value) ? value.join('/') : value;`,
      '  });',
      '}',
      '',
    ]
      .flat(2)
      .join('\n');
  },
});
