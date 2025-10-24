export function handsum<const TAdt, const TImpl extends {} = {}>(
  impl: TImpl &
    Record<string, (this: Handsum<TAdt, TImpl>, ...args: never[]) => unknown>,
): TAdt {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return (...args: unknown[]) => {
          const target = {
            match<R>(
              branches:
                | (Branches<TAdt, R> & { _: never })
                | ({ _: () => R } & Partial<Branches<TAdt, R>>),
            ) {
              return (branches[prop as keyof TAdt] ?? branches._)(...args);
            },
            [prop]: args,

            ...Object.fromEntries(
              Object.entries(impl).map(([key, value]) => [
                key,
                (...args: never[]): unknown => value.apply(target, args),
              ]),
            ),
          } as Handsum<TAdt, TImpl>;
          return target;
        };
      },
    },
  ) as TAdt;
}

export type Handsum<T, TImpl = {}> = {
  [K1 in keyof T]: Simplify<
    {
      [K2 in K1]: T[K1] extends (...args: infer TParams) => unknown
        ? TParams
        : never;
    } & {
      [K2 in Exclude<keyof T, K1>]?: never;
    } & {
      match: <R>(
        branches:
          | { [K in K1]: Branch<T, K1, R> }
          | ({ [K in K1]?: Branch<T, K1, R> } & { _: () => R }),
      ) => R;
    } & TImpl
  >;
}[keyof T];

type Branches<T, R> = {
  [K in keyof T]: T[K] extends (...args: infer TParams) => unknown
    ? (...args: TParams) => R
    : never;
};

type Branch<T, K extends keyof T, R> = T[K] extends (
  ...args: infer TParams
) => unknown
  ? (...args: TParams) => R
  : never;

export type HandsumSubset<TAdt, TName extends keyof TAdt> = TAdt extends {
  [K in TName]?: never;
}
  ? never
  : TAdt;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
