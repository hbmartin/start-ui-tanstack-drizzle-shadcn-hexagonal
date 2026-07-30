import type { SVGProps } from 'react';

import { cn } from '@/platform/lib/tailwind/utils';

import { useBrand } from './brand-context';
import { StartUiMark } from './start-ui-mark';

/**
 * Renders the injected brand mark (see `BrandProvider`), falling back to the
 * template's Start UI mark when no brand is provided (fixtures, isolated
 * tests). Change product identity in `src/app/adopter`, not here.
 */
export const Logo = (props: SVGProps<SVGSVGElement>) => {
  const Mark = useBrand()?.mark ?? StartUiMark;

  return <Mark {...props} className={cn('text-primary', props.className)} />;
};
