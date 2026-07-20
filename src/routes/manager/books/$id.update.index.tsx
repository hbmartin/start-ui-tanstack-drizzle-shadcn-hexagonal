import { createFileRoute } from '@tanstack/react-router';

import { isForbiddenRouteContext } from '@/modules/auth/presentation';
import { bookQueries } from '@/modules/book/client';
import { PageBookUpdate } from '@/modules/book/presentation';
import { genreQueries } from '@/modules/genre/client';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteBookId, parseRouteScopeKey } from '@/routes/-route-params';

export const Route = createFileRoute('/manager/books/$id/update/')({
  loader: observedLoader(
    '/manager/books/$id/update/',
    async ({ context, params }) => {
      if (isForbiddenRouteContext(context)) return undefined;
      const scopeKey = parseRouteScopeKey(context.scopeKey);
      const bookId = parseRouteBookId(params.id);

      const [book] = await Promise.all([
        context.queryClient.ensureQueryData(
          bookQueries.getById({ id: bookId, scopeKey })
        ),
        context.queryClient.ensureQueryData(
          genreQueries.getAllList({ scopeKey })
        ),
      ]);

      return book;
    }
  ),
  component: RouteComponent,
});

function RouteComponent() {
  const params = Route.useParams();
  return <PageBookUpdate bookId={parseRouteBookId(params.id)} />;
}
