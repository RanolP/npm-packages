declare const error: unique symbol;

export type TypelevelError<Message extends string> = `Error: ${Message}` & {
  [error]: 1;
};

export type NonemptyArray<T> = [T, ...T[]];
