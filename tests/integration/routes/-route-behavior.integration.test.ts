import { QueryClient } from '@tanstack/react-query';
import { isRedirect } from '@tanstack/react-router';
import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bookCreate: vi.fn(),
  bookDeleteById: vi.fn(),
  bookGetAll: vi.fn(),
  bookGetById: vi.fn(),
  bookUpdateById: vi.fn(),
  currentSession: vi.fn(),
  genreGetAll: vi.fn(),
  refetchSession: vi.fn(),
  startSignIn: vi.fn(),
  verifyEmailOtp: vi.fn(),
  userCreate: vi.fn(),
  userDeleteById: vi.fn(),
  userGetAll: vi.fn(),
  userGetById: vi.fn(),
  userGetUserSessions: vi.fn(),
  userRevokeUserSession: vi.fn(),
  userRevokeUserSessions: vi.fn(),
  userUpdateById: vi.fn(),
  envClient: {
    VITE_BASE_URL: 'http://localhost:3000',
    VITE_AUTH_SIGNUP_ENABLED: true,
    VITE_S3_BUCKET_PUBLIC_URL: 'http://localhost:9000/default',
    VITE_VISUAL_TEST: false,
  },
}));

vi.mock('@/platform/env/client', () => ({
  envClient: mocks.envClient,
}));

vi.mock('@/platform/env/config', () => ({
  envClient: mocks.envClient,
  getBaseUrl: () => mocks.envClient.VITE_BASE_URL,
  isDevEnvironment: () => false,
}));

vi.mock('@/modules/auth/client', () => ({
  AUTH_SIGNUP_ENABLED: true,
  WithPermissions: ({ children }: { children: ReactNode }) => children,
  authQueries: {
    currentSession: () => ({
      queryKey: ['auth', 'v1', 'currentSession'],
      queryFn: mocks.currentSession,
    }),
  },
  checkRolePermission: () => true,
  clearAllQueryStateForAuthBoundary: (queryClient: QueryClient) =>
    queryClient.clear(),
  startSignIn: mocks.startSignIn,
  verifyEmailOtp: mocks.verifyEmailOtp,
  useAuthSession: () => ({ data: null, refetch: mocks.refetchSession }),
  useCurrentScopeKey: () => 'test-scope',
}));

vi.mock('@/modules/book/server', () => ({
  bookCreate: mocks.bookCreate,
  bookDeleteById: mocks.bookDeleteById,
  bookGetAll: mocks.bookGetAll,
  bookGetById: mocks.bookGetById,
  bookUpdateById: mocks.bookUpdateById,
}));

vi.mock('@/modules/genre/server', () => ({
  genreGetAll: mocks.genreGetAll,
}));

vi.mock('@/modules/user/server', () => ({
  userCreate: mocks.userCreate,
  userDeleteById: mocks.userDeleteById,
  userGetAll: mocks.userGetAll,
  userGetById: mocks.userGetById,
  userGetUserSessions: mocks.userGetUserSessions,
  userRevokeUserSession: mocks.userRevokeUserSession,
  userRevokeUserSessions: mocks.userRevokeUserSessions,
  userUpdateById: mocks.userUpdateById,
}));

vi.mock('@/app/devtools/presentation', () => ({
  EnvHint: () => null,
  LoginEmailHint: () => null,
  LoginEmailOtpHint: () => null,
  TanStackDevtoolsPanel: () => null,
  getEnvHintTitlePrefix: () => '',
}));

import { RouteError } from '@/platform/components/errors/route-error';

import {
  ForbiddenRouteError,
  isForbiddenRouteContext,
} from '@/modules/auth/presentation';
import { bookQueries } from '@/modules/book/client';
import { genreQueries } from '@/modules/genre/client';
import {
  toBookId,
  toScopeKey,
  toUserId,
  unwrapParseResult,
} from '@/modules/kernel/testing';
import { userQueries } from '@/modules/user/client';
import { Route as AppBooksIndexRoute } from '@/routes/app/books/index';
import { Route as LoginRoute } from '@/routes/login/route';
import { Route as LoginVerifyRoute } from '@/routes/login/verify.index';
import { Route as ManagerBooksIdRoute } from '@/routes/manager/books/$id.index';
import { Route as ManagerBooksUpdateRoute } from '@/routes/manager/books/$id.update.index';
import { Route as ManagerBooksIndexRoute } from '@/routes/manager/books/index';
import { Route as ManagerBooksNewRoute } from '@/routes/manager/books/new.index';
import { Route as ManagerRoute } from '@/routes/manager/route';
import { Route as ManagerUsersIdRoute } from '@/routes/manager/users/$id.index';
import { Route as ManagerUsersUpdateRoute } from '@/routes/manager/users/$id.update.index';
import { Route as ManagerUsersIndexRoute } from '@/routes/manager/users/index';

const scopeKey = unwrapParseResult(toScopeKey('user:admin-1:admin'));

const book = {
  author: 'J.R.R. Tolkien',
  coverId: null,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  genre: {
    color: '#005F78',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    id: 'genre-1',
    name: 'Fantasy',
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  },
  genreId: 'genre-1',
  id: 'book-1',
  publisher: 'Allen & Unwin',
  title: 'The Hobbit',
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
};

const user = {
  email: 'admin@example.com',
  emailVerified: true,
  id: 'admin-1',
  image: null,
  name: 'Admin User',
  onboardedAt: new Date('2024-01-01T00:00:00.000Z'),
  role: 'admin',
};

const genrePage = {
  items: [book.genre],
  nextCursor: undefined,
  total: 1,
};

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const makeSession = (role: 'admin' | 'user' = 'admin') => ({
  scope: {
    role,
    userId: `${role}-1`,
  },
  scopeKey: `user:${role}-1:${role}`,
  session: {
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    id: `session-${role}-1`,
  },
  user: {
    email: `${role}@example.com`,
    id: `${role}-1`,
    image: null,
    name: `${role} User`,
    onboardedAt: new Date('2024-01-01T00:00:00.000Z'),
    role,
  },
});

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

const makeRouteContext = (input?: {
  queryClient?: QueryClient;
  session?: ReturnType<typeof makeSession> | null;
}) => {
  const session =
    input && 'session' in input ? input.session : makeSession('admin');

  return {
    auth: {
      getSession: vi.fn(async () => session),
      getSessionSnapshot: vi.fn(() => session),
    },
    queryClient: input?.queryClient ?? createTestQueryClient(),
    scope: session?.scope,
    scopeKey: session?.scopeKey ?? 'anonymous',
  };
};

const routeOptions = (route: unknown) => (route as ExplicitAny).options;

const parseSearch = (route: unknown, search: unknown) => {
  const validateSearch = routeOptions(route).validateSearch;

  return typeof validateSearch === 'function'
    ? validateSearch(search)
    : validateSearch.parse(search);
};

const getThrown = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return error as ExplicitAny;
  }

  throw new Error('Expected function to throw');
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('route integration behavior', () => {
  it('validates list search and wires loader deps from normalized values', () => {
    expect(parseSearch(ManagerBooksIndexRoute, {})).toEqual({
      searchTerm: '',
    });
    expect(
      parseSearch(ManagerBooksIndexRoute, {
        extra: 'ignored',
        searchTerm: 'Dune',
      })
    ).toEqual({ searchTerm: 'Dune' });

    expect(
      routeOptions(ManagerBooksIndexRoute).loaderDeps({
        search: parseSearch(ManagerBooksIndexRoute, { searchTerm: 'Dune' }),
      })
    ).toEqual({ searchTerm: 'Dune' });

    // `email` is no longer part of the verify URL — it travels through router
    // navigation state — so an `email` search param is ignored, not parsed.
    expect(
      parseSearch(LoginVerifyRoute, { email: 'not-an-email' })
    ).not.toHaveProperty('email');
    expect(
      parseSearch(LoginVerifyRoute, {
        email: 'x@example.com',
        redirect: '/app',
      })
    ).toMatchObject({ redirect: '/app' });
  });

  it('runs list loaders and seeds infinite query cache entries by scope and search', async () => {
    const queryClient = createTestQueryClient();
    const context = makeRouteContext({ queryClient });
    const bookPage = { items: [book], nextCursor: undefined, total: 1 };
    const userPage = { items: [user], nextCursor: undefined, total: 1 };

    mocks.bookGetAll.mockResolvedValue(bookPage);
    mocks.userGetAll.mockResolvedValue(userPage);

    const bookResult = await routeOptions(ManagerBooksIndexRoute).loader({
      context,
      deps: { searchTerm: 'Hobbit' },
    });
    const userResult = await routeOptions(ManagerUsersIndexRoute).loader({
      context,
      deps: { searchTerm: 'admin' },
    });

    expect(mocks.bookGetAll).toHaveBeenCalledWith({
      data: expect.objectContaining({ searchTerm: 'Hobbit' }),
    });
    expect(mocks.userGetAll).toHaveBeenCalledWith({
      data: expect.objectContaining({ searchTerm: 'admin' }),
    });
    expect(
      queryClient.getQueryData(
        bookQueries.getAllInfinite({ scopeKey, searchTerm: 'Hobbit' }).queryKey
      )
    ).toEqual(bookResult);
    expect(
      queryClient.getQueryData(
        userQueries.getAllInfinite({ scopeKey, searchTerm: 'admin' }).queryKey
      )
    ).toEqual(userResult);
  });

  it('runs entity loaders and seeds detail query cache entries', async () => {
    const queryClient = createTestQueryClient();
    const context = makeRouteContext({ queryClient });

    mocks.bookGetById.mockResolvedValue(book);

    const result = await routeOptions(ManagerBooksIdRoute).loader({
      context,
      params: { id: 'book-1' },
    });

    expect(mocks.bookGetById).toHaveBeenCalledWith({
      data: { id: 'book-1' },
    });
    expect(result).toEqual(book);
    expect(
      queryClient.getQueryData(
        bookQueries.getById({
          id: unwrapParseResult(toBookId('book-1')),
          scopeKey,
        }).queryKey
      )
    ).toEqual(book);
  });

  it('starts book form dependencies together and blocks on critical data', async () => {
    const queryClient = createTestQueryClient();
    const context = makeRouteContext({ queryClient });
    const pendingBook = createDeferred<typeof book>();
    const pendingGenres = createDeferred<typeof genrePage>();

    mocks.bookGetById.mockReturnValueOnce(pendingBook.promise);
    mocks.genreGetAll.mockReturnValueOnce(pendingGenres.promise);

    const updateLoaderPromise = routeOptions(ManagerBooksUpdateRoute).loader({
      context,
      params: { id: 'book-1' },
    });

    await vi.waitFor(() => {
      expect(mocks.bookGetById).toHaveBeenCalledOnce();
      expect(mocks.genreGetAll).toHaveBeenCalledOnce();
    });

    pendingBook.resolve(book);
    pendingGenres.resolve(genrePage);
    await expect(updateLoaderPromise).resolves.toEqual(book);

    expect(
      queryClient.getQueryData(genreQueries.getAllList({ scopeKey }).queryKey)
    ).toEqual(genrePage);

    const newQueryClient = createTestQueryClient();
    const newContext = makeRouteContext({ queryClient: newQueryClient });
    mocks.genreGetAll.mockResolvedValueOnce(genrePage);
    await routeOptions(ManagerBooksNewRoute).loader({ context: newContext });
    expect(mocks.genreGetAll).toHaveBeenCalledTimes(2);
    expect(
      newQueryClient.getQueryData(
        genreQueries.getAllList({ scopeKey }).queryKey
      )
    ).toEqual(genrePage);
  });

  it('starts secondary user sessions without blocking user detail', async () => {
    const queryClient = createTestQueryClient();
    const context = makeRouteContext({ queryClient });
    const pendingUser = createDeferred<typeof user>();
    const sessionPage = { items: [], nextCursor: undefined, total: 0 };
    const pendingSessions = createDeferred<typeof sessionPage>();

    mocks.userGetById.mockReturnValueOnce(pendingUser.promise);
    mocks.userGetUserSessions.mockReturnValueOnce(pendingSessions.promise);

    const loaderPromise = routeOptions(ManagerUsersIdRoute).loader({
      context,
      params: { id: 'admin-1' },
    });

    await vi.waitFor(() => {
      expect(mocks.userGetById).toHaveBeenCalledOnce();
      expect(mocks.userGetUserSessions).toHaveBeenCalledOnce();
    });

    const sessionsQuery = userQueries.getUserSessionsInfinite({
      limit: 5,
      scopeKey,
      userId: unwrapParseResult(toUserId('admin-1')),
    });
    expect(queryClient.getQueryState(sessionsQuery.queryKey)?.status).toBe(
      'pending'
    );

    pendingUser.resolve(user);
    await expect(loaderPromise).resolves.toEqual(user);
    expect(queryClient.getQueryState(sessionsQuery.queryKey)?.status).toBe(
      'pending'
    );

    pendingSessions.resolve(sessionPage);
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(sessionsQuery.queryKey)).toEqual({
        pageParams: [undefined],
        pages: [sessionPage],
      });
    });
  });

  it('uses route guards for auth redirects through route beforeLoad hooks', async () => {
    const location = {
      hash: '#book-results',
      href: '/manager/books?searchTerm=Hobbit#book-results',
      pathname: '/manager/books',
      searchStr: '?searchTerm=Hobbit',
    };

    const loggedOutContext = makeRouteContext({ session: null });
    const loginRedirect = await getThrown(() =>
      routeOptions(ManagerRoute).beforeLoad({
        context: loggedOutContext,
        location,
      })
    );

    expect(isRedirect(loginRedirect)).toBe(true);
    expect(loginRedirect.options).toMatchObject({
      replace: true,
      search: { redirect: '/manager/books?searchTerm=Hobbit#book-results' },
      to: '/login',
    });
    expect(loggedOutContext.auth.getSession).toHaveBeenCalledWith({
      requireFresh: true,
    });

    const loginContext = makeRouteContext();
    const returnRedirect = await getThrown(() =>
      routeOptions(LoginRoute).beforeLoad({
        context: loginContext,
        search: { redirect: '/manager/books?searchTerm=Hobbit#book-results' },
      })
    );

    expect(isRedirect(returnRedirect)).toBe(true);
    expect(returnRedirect.options).toMatchObject({
      hash: 'book-results',
      replace: true,
      search: { searchTerm: 'Hobbit' },
      to: '/manager/books',
    });
    expect(loginContext.auth.getSession).toHaveBeenCalledWith(undefined);
  });

  it('maps authorization failures to forbidden route context', async () => {
    const routeContext = makeRouteContext({ session: makeSession('user') });
    const forbiddenContext = await routeOptions(ManagerRoute).beforeLoad({
      context: routeContext,
      location: {
        hash: '',
        href: '/manager/users',
        pathname: '/manager/users',
        searchStr: '',
      },
    });
    const genericErrorElement = routeOptions(ManagerRoute).errorComponent({
      error: new Error('boom'),
    });
    const forbiddenErrorElement = routeOptions(ManagerRoute).errorComponent({
      error: new ForbiddenRouteError(),
    });

    expect(isForbiddenRouteContext(forbiddenContext)).toBe(true);
    expect(routeContext.auth.getSession).toHaveBeenCalledWith({
      requireFresh: true,
    });
    expect(isValidElement<{ type: string }>(genericErrorElement)).toBe(true);
    expect(isValidElement<{ type: string }>(forbiddenErrorElement)).toBe(true);
    expect(genericErrorElement.type).toBe(RouteError);
    expect(forbiddenErrorElement.props.type).toBe('403');
  });

  it('does not run manager user loaders for forbidden route context', async () => {
    const routeContext = makeRouteContext({ session: makeSession('user') });
    const forbiddenContext = await routeOptions(ManagerRoute).beforeLoad({
      context: routeContext,
      location: {
        hash: '',
        href: '/manager/users',
        pathname: '/manager/users',
        searchStr: '',
      },
    });

    expect(isForbiddenRouteContext(forbiddenContext)).toBe(true);

    expect(
      await routeOptions(ManagerUsersIndexRoute).loader({
        context: forbiddenContext,
        deps: { searchTerm: 'admin' },
      })
    ).toBeUndefined();
    expect(
      await routeOptions(ManagerUsersIdRoute).loader({
        context: forbiddenContext,
        params: { id: 'admin-1' },
      })
    ).toBeUndefined();
    expect(
      await routeOptions(ManagerUsersUpdateRoute).loader({
        context: forbiddenContext,
        params: { id: 'admin-1' },
      })
    ).toBeUndefined();
    expect(mocks.userGetAll).not.toHaveBeenCalled();
    expect(mocks.userGetById).not.toHaveBeenCalled();
    expect(mocks.userGetUserSessions).not.toHaveBeenCalled();
  });

  it('does not run manager book form loaders for forbidden route context', async () => {
    const routeContext = makeRouteContext({ session: makeSession('user') });
    const forbiddenContext = await routeOptions(ManagerRoute).beforeLoad({
      context: routeContext,
      location: {
        hash: '',
        href: '/manager/books/new',
        pathname: '/manager/books/new',
        searchStr: '',
      },
    });

    expect(
      await routeOptions(ManagerBooksNewRoute).loader({
        context: forbiddenContext,
      })
    ).toBeUndefined();
    expect(
      await routeOptions(ManagerBooksUpdateRoute).loader({
        context: forbiddenContext,
        params: { id: 'book-1' },
      })
    ).toBeUndefined();
    expect(mocks.bookGetById).not.toHaveBeenCalled();
    expect(mocks.genreGetAll).not.toHaveBeenCalled();
  });

  it('seeds the app book loader cache without manager search params', async () => {
    const queryClient = createTestQueryClient();
    const context = makeRouteContext({ queryClient });
    const bookPage = { items: [book], nextCursor: undefined, total: 1 };

    mocks.bookGetAll.mockResolvedValue(bookPage);

    const result = await routeOptions(AppBooksIndexRoute).loader({ context });

    expect(mocks.bookGetAll).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ searchTerm: expect.any(String) }),
    });
    expect(
      queryClient.getQueryData(
        bookQueries.getAllInfinite({ scopeKey }).queryKey
      )
    ).toEqual(result);
  });
});
