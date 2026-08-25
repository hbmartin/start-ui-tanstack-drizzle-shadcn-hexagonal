import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '@/app/i18n/en';
import { selectRuntimeLocales } from '@/app/i18n/select-runtime-locales';

afterEach(() => {
  vi.doUnmock('@/modules/kernel');
  vi.doUnmock('@/modules/kernel/domain/capability-selection.generated');
  vi.resetModules();
});

describe('static core preset selection', () => {
  it('omits demo translations without weakening compile-time locale types', () => {
    const selected = selectRuntimeLocales({ en }, false);

    expect(selected.en).not.toHaveProperty('book');
    expect(selected.en).not.toHaveProperty('genre');
    expect(selected.en).toHaveProperty('auth');
    expect(selectRuntimeLocales({ en }, true).en).toHaveProperty('book');
  });

  it('removes demo permissions and navigation when the generated selection is core', async () => {
    vi.doMock('@/modules/kernel', () => ({
      isCapabilityEnabled: () => false,
    }));

    const permissions = await import('@/modules/auth/domain/permissions');
    const { MAIN_NAV_LINKS } =
      await import('@/app/shell/presentation/app/main-nav-config');

    expect(permissions.permissionStatements).not.toHaveProperty('book');
    expect(permissions.permissionStatements).not.toHaveProperty('genre');
    expect(permissions.rolePermissions.admin).not.toHaveProperty('book');
    expect(permissions.defaultUserPermissions).not.toHaveProperty('book');
    expect(MAIN_NAV_LINKS.some(({ to }) => to === '/app/books')).toBe(false);
  });

  it('omits demo services from the aggregate composition', async () => {
    vi.doMock('@/modules/kernel/domain/capability-selection.generated', () => ({
      ACTIVE_CAPABILITY_PRESET: 'core',
      ENABLED_CAPABILITY_IDS: ['audit', 'email', 'auth', 'profile', 'user'],
      isCapabilityEnabled: () => false,
    }));

    const { getServices } = await import('@/composition');
    const services = getServices({});

    expect(services).not.toHaveProperty('book');
    expect(services).not.toHaveProperty('genre');
  }, 15_000);
});
