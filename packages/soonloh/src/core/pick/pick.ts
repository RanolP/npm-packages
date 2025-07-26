import { Route, PickPredicate, PickResult } from '../types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { tsParser } from './ts-parser.js';

export function createRoutePicker<TSegment>(
  route: Omit<Route<TSegment>, 'pick'>,
): Route<TSegment>['pick'] {
  return async function pick<TPicks extends Record<string, PickPredicate>>(
    picks: TPicks,
  ) {
    // Dynamic import from the route's file
    const moduleExports = await import(route.fileRaw);
    const result = {} as { [K in keyof TPicks]: PickResult<TPicks[K]> };

    for (const [key, predicate] of Object.entries(picks) as Array<
      [keyof TPicks, PickPredicate]
    >) {
      if (typeof predicate !== 'string') {
        result[key] = (await validateWithSchema(
          predicate,
          moduleExports[key],
        )) as PickResult<TPicks[typeof key]>;
        continue;
      }

      switch (predicate) {
        case 'type':
        case 'type?':
          // Check if type is actually exported using TypeScript parser
          const isTypeExported = await tsParser.isTypeExported(
            route.fileRaw,
            key as string,
          );
          if (!isTypeExported) {
            if (predicate === 'type?') {
              result[key] = undefined as PickResult<TPicks[typeof key]>;
              break;
            } else {
              throw new Error(
                `Type '${String(key)}' is not exported from ${route.fileRaw}`,
              );
            }
          }
          // For types, return an object with importHere() method
          result[key] = `import(${route.fileRaw}).${String(key)}` as PickResult<
            TPicks[typeof key]
          >;
          break;
        case 'function':
        case 'function?':
          result[key] = moduleExports[key] as PickResult<TPicks[typeof key]>;
          if (predicate === 'function' && result[key] == null) {
            throw new Error(
              `Export '${String(key)}' not found in ${route.fileRaw}`,
            );
          }
          break;
      }
    }

    return result;
  };
}

/**
 * Validates value with standard-schema
 */
async function validateWithSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<T> {
  const result = await schema['~standard'].validate(value);
  if (result.issues != null) {
    throw new Error(
      `Schema validation failed: ${result.issues
        ?.map((i: { message: string }) => i.message)
        .join(', ')}`,
    );
  }
  return result.value;
}
