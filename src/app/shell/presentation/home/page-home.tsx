import { useTranslation } from 'react-i18next';

export function PageHome() {
  const { t } = useTranslation();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-bold tracking-tight">{t('home.title')}</h1>
      <p className="max-w-prose text-muted-foreground">{t('home.subtitle')}</p>
    </main>
  );
}
