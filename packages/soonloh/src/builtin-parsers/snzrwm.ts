import { CommonSegment, CommonSegments } from '../builtin-common-segment.js';
import { createClassifier, createParser, createSegmenter } from '../index.js';

interface Options {
  /**
   * The tokens treated as terminators.
   * `false` to disable this behavior.
   *
   * @default
   * ```ts
   * {
   *   allCaps: true,
   *   tokens: ['page', 'route', 'layout', 'error', 'loading']
   * }
   * ```
   */
  terminators?: false | { allCaps: boolean; tokens: string[] };
}
/**
 * The snzrwm (Soonzorowoom; 순조로움) segment & parser.
 */
export const parser = ({
  terminators = {
    allCaps: true,
    tokens: ['page', 'route', 'layout', 'error', 'loading'],
  },
}: Options) =>
  createParser({
    segmenter: createSegmenter({
      escape: /(\{.+?\})/,
      separator: ['/', '.'],
    }),
    classifier: createClassifier({
      patterns: {
        grouping: /^\((.+)\)$/,
        param: /^\$(.+)/,
        catchallParam: /^\$\+(.+)/,
        ignore: /^(_.*)/,
        optional: /^\[(.+)\]/,
        terminate:
          terminators === false
            ? /$^/
            : new RegExp(
                String.raw`^(${terminators.tokens.join('|')}${
                  terminators.allCaps ? '|[A-Z]+' : ''
                })\.[cm]?[jt]sx?$`
              ),
        escape: /\{(.+?)\}/,
      },
      classify(token, ctx): CommonSegment {
        if (token.ignore) {
          return CommonSegments.error();
        }
        if (ctx.index === ctx.length - 1) {
          return token.terminate
            ? CommonSegments.terminator({ path: token.terminate.text })
            : CommonSegments.error();
        }
        if (token.escape) {
          return CommonSegments.static({ path: token.escape.text });
        }
        if (token.grouping) {
          return CommonSegments.grouping({ name: token.grouping.text });
        }
        let optional = false;
        if (token.optional) {
          optional = true;
          token = token.optional;
        }
        if (token.catchallParam) {
          return CommonSegments.param({
            name: token.catchallParam.text,
            catchall: true,
            optional,
          });
        }
        if (token.param) {
          return CommonSegments.param({
            name: token.param.text,
            catchall: false,
            optional,
          });
        }
        return CommonSegments.static({ path: token.text });
      },
    }),
  });

export const segments = CommonSegments;
