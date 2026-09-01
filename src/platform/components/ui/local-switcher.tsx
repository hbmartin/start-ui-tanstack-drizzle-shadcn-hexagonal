import { LanguagesIcon } from 'lucide-react';
import { useTransition } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AVAILABLE_LANGUAGES,
  LanguageKey,
} from '@/platform/lib/i18n/constants';
import { useHydrated } from '@/platform/hooks/use-hydrated';
import { cn } from '@/platform/lib/tailwind/utils';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/platform/components/ui/select';

export const LocalSwitcher = (props: { iconOnly?: boolean }) => {
  const { i18n, t } = useTranslation(['common']);
  const [isPending, startLanguageTransition] = useTransition();
  const hydrated = useHydrated();

  const changeLanguage = (language: LanguageKey) => {
    if (language === i18n.language || isPending) return;

    startLanguageTransition(async () => {
      await i18n.changeLanguage(language);
    });
  };

  return (
    <Select
      value={i18n.language}
      disabled={!hydrated || isPending}
      onValueChange={(value) => changeLanguage(value as LanguageKey)}
    >
      <SelectTrigger
        aria-label={t('common:languages.label')}
        data-hydrated={hydrated ? 'true' : 'false'}
        className={cn(
          'w-auto border-0 bg-transparent px-0 shadow-none dark:bg-transparent',
          props.iconOnly &&
            'size-9 justify-center [&_[data-slot=select-icon]]:hidden [&_[data-slot=select-value]]:sr-only'
        )}
      >
        <LanguagesIcon className="opacity-50" />
        {isPending && (
          <span className="sr-only" role="status">
            {t('common:languages.pending')}
          </span>
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {AVAILABLE_LANGUAGES.map((language) => (
          <SelectItem key={language.key} value={language.key}>
            <span className="flex flex-col">
              <span>{t(`common:languages.values.${language.key}`)}</span>
              {language.key !== i18n.language && (
                <span className="text-xs opacity-60">
                  {t(`common:languages.values.${language.key}`, {
                    lng: language.key,
                  })}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
