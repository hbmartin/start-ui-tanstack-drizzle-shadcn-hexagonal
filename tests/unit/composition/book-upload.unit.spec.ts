import { beforeEach, describe, expect, it, vi } from 'vitest';

const bookUploadMocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const uploadHandler = vi.fn();

  return {
    logger,
    uploadHandler,
    bookCoverUploadRouteDefinition: vi.fn(() => 'book-cover-route-def'),
    createUploadRequestHandler: vi.fn(() => uploadHandler),
    telemetry: {
      startSpan: vi.fn((_options: unknown, fn: () => unknown) => fn()),
    },
  };
});

vi.mock('@/composition/auth', () => ({
  getAuthUseCases: vi.fn(() => ({
    getCurrentSession: vi.fn(),
  })),
}));

vi.mock('@/composition/book', () => ({
  getBookUseCases: vi.fn(() => ({})),
}));

vi.mock('@/composition/kernel', () => ({
  getKernel: vi.fn(() => ({
    logger: bookUploadMocks.logger,
    telemetry: bookUploadMocks.telemetry,
  })),
}));

vi.mock('@/modules/book/transport/upload/book-cover', () => ({
  bookCoverUploadRouteDefinition:
    bookUploadMocks.bookCoverUploadRouteDefinition,
}));

vi.mock('@/modules/kernel/backend', () => ({
  BetterUploadObjectStorage: class {
    createUploadRequestHandler = bookUploadMocks.createUploadRequestHandler;
  },
}));

vi.mock('@/platform/telemetry', () => ({
  getTelemetry: vi.fn(() => bookUploadMocks.telemetry),
  telemetryProxy: bookUploadMocks.telemetry,
}));

describe('book upload composition', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    bookUploadMocks.telemetry.startSpan.mockImplementation(
      (_options: unknown, fn: () => unknown) => fn()
    );
    bookUploadMocks.createUploadRequestHandler.mockReturnValue(
      bookUploadMocks.uploadHandler
    );
  });

  it('wraps upload requests in a telemetry span and delegates to the storage handler', async () => {
    const response = new Response('uploaded', { status: 201 });
    bookUploadMocks.uploadHandler.mockResolvedValueOnce(response);
    const { handleBookUploadRequest } =
      await import('@/composition/book-upload');
    const request = new Request('https://app.example/api/upload', {
      method: 'POST',
    });

    await expect(handleBookUploadRequest(request)).resolves.toBe(response);

    expect(bookUploadMocks.telemetry.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'http.request.method': 'POST',
          'operation.name': 'book.uploadRequest',
          'operation.type': 'http_handler',
          'upload.provider': 'better-upload',
        }),
        name: 'book.uploadRequest',
        op: 'upload.http',
      }),
      expect.any(Function)
    );
    expect(bookUploadMocks.createUploadRequestHandler).toHaveBeenCalledWith({
      bookCover: 'book-cover-route-def',
    });
    expect(bookUploadMocks.uploadHandler).toHaveBeenCalledWith(request);
  });
});
