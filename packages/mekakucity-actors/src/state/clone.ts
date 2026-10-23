const typedArrayPrototypes = new Set<object>([
  Int8Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
  Int16Array.prototype, Uint16Array.prototype, Int32Array.prototype,
  Uint32Array.prototype, Float32Array.prototype, Float64Array.prototype,
  BigInt64Array.prototype, BigUint64Array.prototype,
]);

export const cloneOrThrow = <T>(value: T, errorFactory: (cause: unknown) => Error): T => {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw errorFactory(cause);
  }
};

export const assertCloneableResultPrototypes = (
  value: unknown,
  isKnownRef: (candidate: object) => boolean,
  isDescriptor: (candidate: unknown) => boolean,
  seen = new WeakSet<object>(),
): void => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (typeof value === "function") throw new TypeError("Functions are not structured-cloneable");
  if (seen.has(value)) return;
  seen.add(value);
  if (isKnownRef(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype === Object.prototype || prototype === null) && isDescriptor(value)
      && Object.keys(value).length === 2 && Object.hasOwn(value, "type") && Object.hasOwn(value, "id")) return;
  const visit = (item: unknown) => assertCloneableResultPrototypes(item, isKnownRef, isDescriptor, seen);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError("Array subclasses are not structured-clone-safe");
    value.forEach(visit);
    return;
  }
  if (prototype === Map.prototype) {
    for (const [key, item] of value as Map<unknown, unknown>) { visit(key); visit(item); }
    return;
  }
  if (prototype === Set.prototype) {
    for (const item of value as Set<unknown>) visit(item);
    return;
  }
  if (prototype === Date.prototype || prototype === RegExp.prototype || prototype === ArrayBuffer.prototype
      || (typeof SharedArrayBuffer !== "undefined" && prototype === SharedArrayBuffer.prototype)) return;
  if (ArrayBuffer.isView(value)) {
    if (prototype !== DataView.prototype && !typedArrayPrototypes.has(prototype)) {
      throw new TypeError("Typed array subclasses are not structured-clone-safe");
    }
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (prototype as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
    throw new TypeError(`Instances with the ${name} prototype are not structured-clone-safe`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Objects with symbol-keyed properties are not structured-clone-safe");
  }
  Object.keys(value).forEach((key) => visit((value as Record<string, unknown>)[key]));
};
