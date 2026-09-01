import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    kind: 'trusted-proxy-chain' as const,
    resolve: vi.fn(() => '203.0.113.10'),
  },
  createTrustedClientIpAdapter: vi.fn(),
  createHandlers: vi.fn(),
  production: true,
  receive: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock('@/modules/kernel/backend', () => ({
  appErrorToResponse: vi.fn(() => new Response(null, { status: 500 })),
  createTransactionRunner: vi.fn(() => ({ run: vi.fn() })),
  getDefaultDbClient: vi.fn(() => ({})),
  getEmailConfig: () => ({ resendWebhookMaxBytes: 1_000_000 }),
  getHttpConfig: () => ({ trustedProxyDepth: 1 }),
  isProdRuntimeEnvironment: () => mocks.production,
}));

vi.mock('@/platform/http/get-client-ip', () => ({
  createTrustedClientIpAdapter: mocks.createTrustedClientIpAdapter,
}));

vi.mock('@/modules/email/transport/http/resend-webhook-handlers', () => ({
  createResendWebhookHandlers: mocks.createHandlers,
}));

vi.mock(
  '@/modules/email/infrastructure/resend/resend-webhook-verifier',
  () => ({
    ResendWebhookVerifier: class {},
  })
);

describe('email backend runtime policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.production = true;
    mocks.createTrustedClientIpAdapter.mockReturnValue(mocks.adapter);
    mocks.createHandlers.mockReturnValue({ receive: mocks.receive });
  });

  it.each([
    { production: true, expected: true },
    { production: false, expected: false },
  ])(
    'sets requireTrustedClientIp=$expected when production=$production',
    async ({ expected, production }) => {
      mocks.production = production;
      const { handleResendWebhookRequest } =
        await import('@/modules/email/backend');

      const response = await handleResendWebhookRequest(
        new Request('https://app.example/api/webhooks/resend', {
          method: 'POST',
        }),
        { runtimeProfile: 'node' }
      );

      expect(response.status).toBe(204);
      expect(mocks.createHandlers).toHaveBeenCalledWith(
        expect.objectContaining({
          requireTrustedClientIp: expected,
          trustedClientIpAdapter: mocks.adapter,
        })
      );
      expect(mocks.createTrustedClientIpAdapter).toHaveBeenCalledWith({
        runtimeProfile: 'node',
        trustedProxyDepth: 1,
      });
    }
  );
});
