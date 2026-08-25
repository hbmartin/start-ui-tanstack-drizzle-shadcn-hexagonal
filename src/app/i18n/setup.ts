import locales from '@/app/i18n';
import { selectRuntimeLocales } from '@/app/i18n/select-runtime-locales';
import { isCapabilityEnabled } from '@/modules/kernel';
import { configureI18n } from '@/platform/lib/i18n';
import { createI18nConfig } from '@/platform/lib/i18n/config';

const runtimeLocales = selectRuntimeLocales(
  locales,
  isCapabilityEnabled('book')
);

void configureI18n(createI18nConfig(runtimeLocales));
