import { isCapabilityEnabled } from '@/modules/kernel';

type CapabilityLookup = (capabilityId: string) => boolean;

const bookRoutePatterns = [
  /^\/api\/upload\/?$/u,
  /^\/app\/books(?:\/|$)/u,
  /^\/manager\/books(?:\/|$)/u,
] as const;

export const isCapabilityRouteEnabled = (
  pathname: string,
  isEnabled: CapabilityLookup = isCapabilityEnabled
) =>
  isEnabled('book') ||
  !bookRoutePatterns.some((pattern) => pattern.test(pathname));
