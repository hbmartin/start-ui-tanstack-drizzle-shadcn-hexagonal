import { ReactNode } from 'react';

import { useHydrated } from '@/platform/hooks/use-hydrated';

import { NavSidebar } from '@/app/shell/presentation/manager/nav-sidebar';

export const Layout = (props: { children?: ReactNode }) => {
  const hydrated = useHydrated();

  return (
    <div
      className="flex flex-1 flex-col"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-testid="layout-manager"
    >
      <NavSidebar>{props.children}</NavSidebar>
    </div>
  );
};
