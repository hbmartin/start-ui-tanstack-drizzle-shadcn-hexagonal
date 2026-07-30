import { describe, expect, it } from 'vitest';

import { checkDeployTarget } from '@/modules/kernel/domain/deploy-target';

describe('checkDeployTarget', () => {
  it('matches an identical deploy target', () => {
    expect(checkDeployTarget('staging', 'staging')).toEqual({
      type: 'deploy_target_matched',
    });
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(checkDeployTarget('staging', '  Staging ')).toEqual({
      type: 'deploy_target_matched',
    });
    expect(checkDeployTarget('STAGING', 'staging')).toEqual({
      type: 'deploy_target_matched',
    });
  });

  it('flags a different deploy target as foreign with the normalized value', () => {
    expect(checkDeployTarget('staging', 'Production')).toEqual({
      type: 'deploy_target_foreign',
      incoming: 'production',
    });
  });

  it.each([undefined, null, '', '   '])(
    'reports %j incoming targets as unknown',
    (incoming) => {
      expect(checkDeployTarget('staging', incoming)).toEqual({
        type: 'deploy_target_unknown',
      });
    }
  );
});
