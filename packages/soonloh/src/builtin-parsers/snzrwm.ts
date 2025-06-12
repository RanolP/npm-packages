import { CommonSegment, CommonSegments } from '../builtin-common-segment.js';
import { createClassifier, createParser, createSegmenter } from '../index.js';

// The snzrwm (Soonzorowoom; 순조로움) segment & parser.
export const parser = createParser({
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
      terminate: /^(page|route|[A-Z]+)\.[cm]?[jt]sx?$/,
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
