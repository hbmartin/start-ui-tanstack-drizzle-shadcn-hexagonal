import i18n from 'i18next';
import type { InitOptions } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

let initialization: Promise<unknown> | undefined;

export const configureI18n = (config: InitOptions) => {
  initialization ??= i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init(config);

  return initialization;
};

export default i18n;
