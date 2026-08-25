import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertCapabilityAvailable: vi.fn((capabilityId: string) => {
    throw Object.assign(new Error(`${capabilityId} unavailable`), {
      code: 'NOT_FOUND',
      status: 404,
    });
  }),
  getBookUseCases: vi.fn(),
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
vi.mock('@/composition/book', () => ({
  getBookUseCases: mocks.getBookUseCases,
}));
describe('book server-function capability ingress', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects book dependencies before constructing book services', async () => {
    const { getBookServerRuntimeDeps } =
      await import('@/modules/book/transport/server-functions/server-functions');

    await expect(getBookServerRuntimeDeps()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(mocks.assertCapabilityAvailable).toHaveBeenCalledWith('book');
    expect(mocks.getBookUseCases).not.toHaveBeenCalled();
  });
});
