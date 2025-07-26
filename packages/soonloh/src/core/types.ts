import { BaseSegment } from './segment.js';

export interface Route<TSegment> {
  fileRaw: string;
  filePosix: string;
  segments: Exclude<TSegment, BaseSegment>[];
}
