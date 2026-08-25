import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertCapabilityAvailable: vi.fn((capabilityId: string) => {
    throw Object.assign(new Error(`${capabilityId} unavailable`), {
      code: 'NOT_FOUND',
      status: 404,
    });
  }),
  getGenreUseCases: vi.fn(),
}));

vi.mock('@tanstack/react-start', () => {
  const builder = {
    handler: () => builder,
    validator: () => builder,
  };
  return {
    createServerFn: () => builder,
    createServerOnlyFn: (fn: unknown) => fn,
  };
});

vi.mock('@/platform/lib/tanstack-start/server-function-handler', () => ({
  createServerFunctionInvoker: () => ({ withOperation: () => vi.fn() }),
}));
vi.mock('@/modules/kernel/backend', () => ({
  assertCapabilityAvailable: mocks.assertCapabilityAvailable,
}));
vi.mock('@/composition/genre', () => ({
  getGenreUseCases: mocks.getGenreUseCases,
}));

describe('genre server-function capability ingress', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects dependencies before constructing genre services', async () => {
    const { getGenreServerRuntimeDeps } =
      await import('@/modules/genre/transport/server-functions/server-functions');

    await expect(getGenreServerRuntimeDeps()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(mocks.assertCapabilityAvailable).toHaveBeenCalledWith('genre');
    expect(mocks.getGenreUseCases).not.toHaveBeenCalled();
  });
});
