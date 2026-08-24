import { createFileRoute } from '@tanstack/react-router';

import { Button } from '@/platform/components/ui/button';

import {
  BuildInfoDrawer,
  BuildInfoVersion,
} from '@/app/build-info/presentation';
import { AppPageProfile as PageProfile } from '@/modules/profile/presentation';

export const Route = createFileRoute('/app/profile/')({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <PageProfile
      supportSlot={
        <BuildInfoDrawer>
          <Button variant="ghost" size="xs" className="opacity-60">
            <BuildInfoVersion />
          </Button>
        </BuildInfoDrawer>
      }
    />
  );
}
