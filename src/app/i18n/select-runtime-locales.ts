export const selectRuntimeLocales = <
  TLocales extends Readonly<Record<string, Readonly<Record<string, unknown>>>>,
>(
  locales: TLocales,
  demoEnabled: boolean
): TLocales => {
  if (demoEnabled) return locales;
  return Object.fromEntries(
    Object.entries(locales).map(([language, resources]) => [
      language,
      Object.fromEntries(
        Object.entries(resources).filter(
          ([namespace]) => namespace !== 'book' && namespace !== 'genre'
        )
      ),
    ])
  ) as TLocales;
};
