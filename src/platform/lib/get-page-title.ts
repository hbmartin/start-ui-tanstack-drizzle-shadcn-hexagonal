export const getPageTitle = (
  pageTitle: string | undefined,
  titlePrefix: string,
  appName: string
) => {
  const prefix = titlePrefix ? `${titlePrefix} ` : '';
  return pageTitle
    ? `${prefix}${pageTitle} | ${appName}`
    : `${prefix}${appName}`;
};
