import locales from '@/app/i18n';
import { configureI18n } from '@/platform/lib/i18n';
import { createI18nConfig } from '@/platform/lib/i18n/config';

void configureI18n(createI18nConfig(locales));
