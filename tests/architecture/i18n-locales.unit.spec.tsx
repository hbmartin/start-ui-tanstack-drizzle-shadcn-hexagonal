import { describe, expect, it } from 'vitest';

import locales from '@/app/i18n';
import {
  AVAILABLE_LANGUAGES,
  getLanguagePresentation,
} from '@/platform/lib/i18n/constants';

type TranslationTree = Readonly<Record<string, unknown>>;

const getInterpolationTokens = (value: string) =>
  [...value.matchAll(/\{\{\s*(-\s*)?([^},\s]+)(?:\s*,[^}]*)?\s*\}\}/gu)]
    .map((match) =>
      match[2] ? `${match[1] ? 'unescaped' : 'escaped'}:${match[2]}` : undefined
    )
    .filter((token): token is string => token !== undefined)
    .toSorted();

const getLeafShape = (value: unknown, prefix = ''): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    return [
      `${prefix}:array:${value.length}`,
      ...value.flatMap((entry, index) =>
        getLeafShape(entry, `${prefix}[${index}]`)
      ),
    ];
  }
  if (value !== null && typeof value === 'object') {
    return [
      `${prefix}:object`,
      ...Object.entries(value as TranslationTree)
        .toSorted(([left], [right]) => left.localeCompare(right, 'en'))
        .flatMap(([key, entry]) =>
          getLeafShape(entry, prefix === '' ? key : `${prefix}.${key}`)
        ),
    ];
  }

  return [
    typeof value === 'string'
      ? `${prefix}:string:${getInterpolationTokens(value).join(',')}`
      : `${prefix}:${typeof value}`,
  ];
};

describe('application locale contract', () => {
  it('keeps every locale and namespace in one deterministic order', () => {
    const languageKeys = AVAILABLE_LANGUAGES.map(({ key }) => key);
    const namespaceKeys = Object.keys(locales.en);

    expect(Object.keys(locales)).toEqual(languageKeys);
    for (const language of languageKeys) {
      expect(Object.keys(locales[language])).toEqual(namespaceKeys);
    }
  });

  it('keeps every nested translation key and value type at parity with English', () => {
    for (const namespace of Object.keys(locales.en) as Array<
      keyof typeof locales.en
    >) {
      const referenceShape = getLeafShape(locales.en[namespace]);

      for (const { key: language } of AVAILABLE_LANGUAGES) {
        expect(
          getLeafShape(locales[language][namespace]),
          `${language}.${namespace} must match en.${namespace}`
        ).toEqual(referenceShape);
      }
    }
  });

  it('represents empty containers and requires closed interpolation tokens', () => {
    expect(getLeafShape({ section: {} })).not.toEqual(getLeafShape({}));
    expect(getLeafShape({ items: [] })).not.toEqual(getLeafShape({}));
    expect(getLeafShape({ greeting: '{{name}}' })).not.toEqual(
      getLeafShape({ greeting: '{{name' })
    );
    expect(getLeafShape({ html: '{{- safeHtml}}' })).not.toEqual(
      getLeafShape({ html: '{{- otherHtml}}' })
    );
    expect(getLeafShape({ html: '{{safeHtml}}' })).not.toEqual(
      getLeafShape({ html: '{{- safeHtml}}' })
    );
  });

  it('defaults unknown external language values to left-to-right rendering', () => {
    expect(getLanguagePresentation('unknown')).toEqual({
      dir: 'ltr',
      fontScale: undefined,
    });
  });
});
