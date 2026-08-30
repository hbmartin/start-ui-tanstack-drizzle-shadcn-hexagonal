import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmailLayout } from '@/modules/email/presentation/components/email-layout';
import { getLanguagePresentation } from '@/platform/lib/i18n/constants';

describe('EmailLayout', () => {
  it.each([
    ['en', 'ltr'],
    ['fr', 'ltr'],
    ['ar', 'rtl'],
    ['sw', 'ltr'],
  ] as const)('renders %s documents in %s direction', (language, direction) => {
    const markup = renderToStaticMarkup(
      <EmailLayout language={language} preview="Direction check">
        <p>Content</p>
      </EmailLayout>
    );

    expect(getLanguagePresentation(language).dir).toBe(direction);
    const htmlTag = markup.match(/^<html[^>]+>/u)?.[0];
    const bodyTag = markup.match(/<body[^>]+>/u)?.[0];
    expect(htmlTag).toContain(`lang="${language}"`);
    expect(htmlTag).toContain(`dir="${direction}"`);
    expect(bodyTag).toContain(`lang="${language}"`);
    expect(bodyTag).toContain(`dir="${direction}"`);
  });
});
