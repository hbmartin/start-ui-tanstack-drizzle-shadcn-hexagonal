import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleBookUploadRequest: vi.fn(),
}));

vi.mock('@/app/capabilities/is-capability-route-enabled', () => ({
  isCapabilityRouteEnabled: () => false,
}));
vi.mock('@/composition/book-upload', () => ({
  handleBookUploadRequest: mocks.handleBookUploadRequest,
}));

describe('upload capability ingress', () => {
  it('returns 404 before constructing the disabled upload handler', async () => {
    const { Route } = await import('@/routes/api/upload');
    const post = (Route as ExplicitAny).options.server.handlers.POST;

    const response = await post({
      request: new Request('http://localhost/api/upload', { method: 'POST' }),
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(404);
    expect(mocks.handleBookUploadRequest).not.toHaveBeenCalled();
  });
});
