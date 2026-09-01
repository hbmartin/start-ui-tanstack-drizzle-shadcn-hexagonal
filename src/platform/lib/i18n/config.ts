import type { InitOptions, Resource } from 'i18next';
import { keys } from 'remeda';

import {
  DEFAULT_LANGUAGE_KEY,
  DEFAULT_NAMESPACE,
} from '@/platform/lib/i18n/constants';

export const createI18nConfig = (locales: Resource): InitOptions => {
  const defaultResources = locales[DEFAULT_LANGUAGE_KEY];
  if (!defaultResources) {
    throw new Error(
      `Missing resources for the default locale: ${DEFAULT_LANGUAGE_KEY}`
    );
  }

  return {
    defaultNS: DEFAULT_NAMESPACE,
    ns: keys(defaultResources),
    resources: locales,
    fallbackLng: DEFAULT_LANGUAGE_KEY,
    supportedLngs: keys(locales),
    detection: {
      caches: ['cookie'],
      cookieMinutes: 43200, // 30 days
      cookieOptions: { path: '/', sameSite: 'lax' },
    },

    // Fix issue with i18next types
    // https://www.i18next.com/overview/typescript#argument-of-type-defaulttfuncreturn-is-not-assignable-to-parameter-of-type-xyz
    returnNull: false,

    interpolation: {
      escapeValue: false, // React already escapes interpolated content.
    },
  };
};
