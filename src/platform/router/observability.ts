import type { TelemetrySpanHandle } from '@/platform/telemetry';
import { telemetryProxy } from '@/platform/telemetry';

type RouterLifecycleEvent = {
  fromLocation?: { href: string; pathname: string };
  hashChanged?: boolean;
  hrefChanged?: boolean;
  pathChanged?: boolean;
  toLocation: { href: string; pathname: string };
};

type ObservableRouter = {
  state?: {
    matches?: Array<{ routeId?: string }>;
  };
  subscribe: (
    eventType:
      | 'onBeforeNavigate'
      | 'onBeforeRouteMount'
      | 'onRendered'
      | 'onResolved',
    fn: (event: RouterLifecycleEvent) => void
  ) => () => void;
};

type ActiveNavigation = {
  href: string;
  span: TelemetrySpanHandle;
  start: number;
};

const normalizePathname = (pathname: string) => {
  let end = pathname.length;
  while (end > 1 && pathname.charCodeAt(end - 1) === 47) end -= 1;
  return pathname.slice(0, end);
};

const routeTemplateFromRouterState = (router: ObservableRouter) => {
  const routeId = router.state?.matches?.at(-1)?.routeId;
  return routeId ? normalizePathname(routeId) : undefined;
};

const UNMATCHED_ROUTE_TEMPLATE = '/unmatched';

const shouldTraceNavigation = (event: RouterLifecycleEvent) =>
  event.hrefChanged !== false &&
  !(event.hashChanged === true && event.pathChanged === false);

const finishNavigation = (
  router: ObservableRouter,
  active: ActiveNavigation | undefined,
  event: RouterLifecycleEvent,
  status: 'rendered'
) => {
  if (!active || active.href !== event.toLocation.href) return undefined;

  const durationMs = performance.now() - active.start;
  const routeTemplate =
    routeTemplateFromRouterState(router) ?? UNMATCHED_ROUTE_TEMPLATE;

  active.span.setAttributes({
    'navigation.duration_ms': durationMs,
    'navigation.status': status,
    'route.template': routeTemplate,
  });
  active.span.setStatus('ok');
  active.span.end();

  telemetryProxy.recordMetric({
    attributes: {
      'navigation.status': status,
      'route.template': routeTemplate,
    },
    name: 'app.router.navigation.duration',
    type: 'histogram',
    unit: 'ms',
    value: durationMs,
  });

  return undefined;
};

export const attachRouterObservability = (router: ObservableRouter) => {
  let activeNavigation: ActiveNavigation | undefined;

  const unsubscribeBeforeNavigate = router.subscribe(
    'onBeforeNavigate',
    (event) => {
      if (!shouldTraceNavigation(event)) {
        activeNavigation?.span.end();
        activeNavigation = undefined;
        return;
      }

      activeNavigation?.span.end();

      activeNavigation = {
        href: event.toLocation.href,
        span: telemetryProxy.startManualSpan({
          attributes: {
            'navigation.hash_changed': event.hashChanged,
            'navigation.path_changed': event.pathChanged,
            'route.template': UNMATCHED_ROUTE_TEMPLATE,
          },
          name: 'router.navigation',
          op: 'router.navigation',
        }),
        start: performance.now(),
      };
    }
  );

  const unsubscribeResolved = router.subscribe('onResolved', (event) => {
    if (!activeNavigation || activeNavigation.href !== event.toLocation.href) {
      return;
    }

    activeNavigation.span.addEvent('navigation.resolved');
  });

  const unsubscribeRendered = router.subscribe('onRendered', (event) => {
    activeNavigation = finishNavigation(
      router,
      activeNavigation,
      event,
      'rendered'
    );
  });

  return () => {
    activeNavigation?.span.end();
    unsubscribeBeforeNavigate();
    unsubscribeResolved();
    unsubscribeRendered();
  };
};
