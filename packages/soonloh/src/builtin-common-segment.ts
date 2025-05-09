import { createSegment, inferSegment } from './core/segment.js';

export const CommonSegments = createSegment({
  grouping: {
    name: 'string',
  },
  param: {
    name: 'string',
    catchall: 'boolean',
    optional: 'boolean',
  },
  static: {
    path: 'string',
  },
  terminator: {
    path: 'string',
  },
});
export type CommonSegment = inferSegment<typeof CommonSegments>;
