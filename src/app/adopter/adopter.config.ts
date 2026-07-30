import type { BrandMark } from '@/platform/components/brand/brand-context';
import { StartUiMark } from '@/platform/components/brand/start-ui-mark';

/**
 * ADOPTER ZONE — the single product-identity surface of the template.
 *
 * Everything a fork changes about who the product *is* lives here (plus the
 * brand assets in `public/`): name, mark, theme-token overrides, default
 * feature flags. These paths are protected by `.gitattributes` `merge=ours`,
 * so `pnpm upgrade:template` can merge upstream template releases without
 * clobbering your identity — see `docs/upgrading.md`.
 *
 * Environment-driven identity bits stay env-overridable and are part of the
 * same seam: `VITE_ENV_NAME` / `VITE_ENV_COLOR` / `VITE_ENV_EMOJI` (env hint),
 * `VITE_AUTH_SIGNUP_ENABLED` (signup), and `DEPLOY_TARGET`.
 */
export type AdopterConfig = {
  /** Product name shown in page titles and PWA metadata. */
  appName: string;
  tagline?: string;
  supportEmail?: string;
  brand: {
    /** Mark rendered by the platform `Logo` (nav, login, home). */
    mark: BrandMark;
  };
  /**
   * CSS custom-property overrides layered over the platform theme
   * (`src/platform/styles/app.css`), e.g. `{ '--color-primary': '#0f766e' }`.
   */
  themeTokens: Record<`--${string}`, string>;
  /** Default feature-flag values consumed via the router `flags` context. */
  featureFlags: Record<string, boolean>;
};

export const adopterConfig: AdopterConfig = {
  appName: 'Start UI',
  brand: { mark: StartUiMark },
  themeTokens: {},
  featureFlags: {},
};
