import { reportTelemetryFailure } from '@/platform/telemetry';

export type TelemetryProviderClaim = {
  acquire: () => boolean;
  name: string;
  release: () => void;
};

const releaseClaims = (claims: TelemetryProviderClaim[]) => {
  for (const claim of claims.toReversed()) {
    try {
      claim.release();
    } catch (failure) {
      reportTelemetryFailure('otel.provider.release', failure);
    }
  }
};

export const claimTelemetryProviderOwnership = (
  claims: TelemetryProviderClaim[]
): (() => void) => {
  const acquired: TelemetryProviderClaim[] = [];
  try {
    for (const claim of claims) {
      if (!claim.acquire()) {
        throw new Error(`OTel ${claim.name} owner unavailable`);
      }
      acquired.push(claim);
    }
  } catch (failure) {
    releaseClaims(acquired);
    throw failure;
  }

  return () => releaseClaims(acquired);
};
