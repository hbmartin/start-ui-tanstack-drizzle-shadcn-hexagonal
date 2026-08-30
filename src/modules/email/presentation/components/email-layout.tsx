import type { ReactNode } from 'react';
import { Body, Head, Html, Preview } from 'react-email';

import { getLanguagePresentation } from '@/platform/lib/i18n/constants';

import { styles } from '@/modules/email/presentation/styles';

export const EmailLayout = ({
  preview,
  children,
  language,
}: {
  preview: string;
  children: ReactNode;
  language: string;
}) => {
  const { dir } = getLanguagePresentation(language);

  return (
    <Html lang={language} dir={dir}>
      <Head>
        <meta name="viewport" content="width=device-width" />
      </Head>
      <Preview>{preview}</Preview>
      <Body lang={language} dir={dir} style={styles.main}>
        {children}
      </Body>
    </Html>
  );
};
