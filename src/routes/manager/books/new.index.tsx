import { createFileRoute } from '@tanstack/react-router';

import { isForbiddenRouteContext } from '@/modules/auth/presentation';
import { PageBookNew } from '@/modules/book/presentation';
import { genreQueries } from '@/modules/genre/client';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteScopeKey } from '@/routes/-route-params';

export const Route = createFileRoute('/manager/books/new/')({
  loader: observedLoader('/manager/books/new/', ({ context }) => {
    if (isForbiddenRouteContext(context)) return undefined;

    return context.queryClient.ensureQueryData(
      genreQueries.getAllList({
        scopeKey: parseRouteScopeKey(context.scopeKey),
      })
    );
  }),
  component: RouteComponent,
});

function RouteComponent() {
  return <PageBookNew />;
}
