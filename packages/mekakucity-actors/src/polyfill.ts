// tsc-compiled actor classes need this imported before they are defined.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");
