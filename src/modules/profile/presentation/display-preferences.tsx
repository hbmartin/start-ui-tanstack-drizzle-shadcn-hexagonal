import { useTranslation } from 'react-i18next';

import { Card, CardHeader, CardTitle } from '@/platform/components/ui/card';
import { LocalSwitcher } from '@/platform/components/ui/local-switcher';
import { ThemeSwitcher } from '@/platform/components/ui/theme-switcher';

import { ProfileCardRow } from './profile-card-row';

export const DisplayPreferences = () => {
  const { t } = useTranslation(['common', 'profile']);
  return (
    <Card className="gap-0 p-0">
      <CardHeader className="gap-y-0 py-4">
        <CardTitle>{t('profile:displayPreferences.title')}</CardTitle>
      </CardHeader>
      <ProfileCardRow label={t('common:themes.label')}>
        <div className="-my-2">
          <ThemeSwitcher />
        </div>
      </ProfileCardRow>
      <ProfileCardRow label={t('common:languages.label')}>
        <div className="-my-2">
          <LocalSwitcher />
        </div>
      </ProfileCardRow>
    </Card>
  );
};
