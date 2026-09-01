import { linkOptions } from '@tanstack/react-router';

import { isCapabilityEnabled } from '@/modules/kernel';

import {
  IconBookOpenDuotone,
  IconBookOpenFill,
  IconHouseDuotone,
  IconHouseFill,
  IconUserCircleDuotone,
  IconUserCircleFill,
} from '@/platform/components/icons/generated';

export const MAIN_NAV_LINKS = linkOptions([
  {
    labelTranslationKey: 'layout:nav.home',
    icon: IconHouseDuotone,
    iconActive: IconHouseFill,
    to: '/app',
    activeOptions: { exact: true },
  },
  ...(isCapabilityEnabled('book')
    ? [
        {
          labelTranslationKey: 'layout:nav.books' as const,
          icon: IconBookOpenDuotone,
          iconActive: IconBookOpenFill,
          to: '/app/books' as const,
        },
      ]
    : []),
  {
    labelTranslationKey: 'layout:nav.profile',
    icon: IconUserCircleDuotone,
    iconActive: IconUserCircleFill,
    to: '/app/profile',
  },
]);

export type NavLinkItem = Omit<
  (typeof MAIN_NAV_LINKS)[number],
  'labelTranslationKey'
> & { children?: React.ReactNode };
