/**
 * Deploy-target isolation primitive. Outbound calls to shared external
 * accounts (email today, billing later) are stamped with the running
 * environment's deploy target; inbound callbacks carrying a different target
 * belong to another environment's deploy and must be ignored instead of acted
 * on. Comparison is case-insensitive so provider round-trips that change
 * casing do not create false foreign matches.
 */
export const DEPLOY_TARGET_TAG_NAME = 'deploy_target';

export type DeployTargetCheckOutcome =
  | { type: 'deploy_target_matched' }
  /** No incoming target (legacy or externally-originated event) — callers decide; the email webhook processes it. */
  | { type: 'deploy_target_unknown' }
  | { type: 'deploy_target_foreign'; incoming: string };

const normalizeDeployTarget = (value: string) => value.trim().toLowerCase();

export function checkDeployTarget(
  expected: string,
  incoming: string | null | undefined
): DeployTargetCheckOutcome {
  if (incoming === undefined || incoming === null || !incoming.trim()) {
    return { type: 'deploy_target_unknown' };
  }

  const normalizedIncoming = normalizeDeployTarget(incoming);
  if (normalizedIncoming === normalizeDeployTarget(expected)) {
    return { type: 'deploy_target_matched' };
  }

  return { type: 'deploy_target_foreign', incoming: normalizedIncoming };
}
