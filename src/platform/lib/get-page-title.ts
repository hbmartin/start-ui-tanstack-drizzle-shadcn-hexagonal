const DEFAULT_APP_NAME = 'Start UI';

let appName = DEFAULT_APP_NAME;

/**
 * Applied once at boot by `configureAdopter()` (`src/app/adopter`) so every
 * page title reflects the adopter's product name without `src/platform`
 * importing the adopter zone.
 */
export const setBrandAppName = (name: string) => {
  appName = name.trim() || DEFAULT_APP_NAME;
};

export const getBrandAppName = () => appName;

export const getPageTitle = (pageTitle?: string, titlePrefix = '') => {
  const prefix = titlePrefix ? `${titlePrefix} ` : '';
  return pageTitle
    ? `${prefix}${pageTitle} | ${appName}`
    : `${prefix}${appName}`;
};
