import { isCapabilityEnabled } from '../../domain/capability-selection.generated';
import { ServerFnError } from './server-fn-error';

type CapabilityLookup = (capabilityId: string) => boolean;

export const assertCapabilityAvailable = (
  capabilityId: string,
  isEnabled: CapabilityLookup = isCapabilityEnabled
) => {
  if (!isEnabled(capabilityId)) throw new ServerFnError('NOT_FOUND');
};
