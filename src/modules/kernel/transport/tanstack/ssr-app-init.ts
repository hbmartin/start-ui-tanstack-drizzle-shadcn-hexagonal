import { getUserLanguage } from './user-language';

export const createSsrAppHandlers = () => {
  const init = () => ({
    language: getUserLanguage(),
  });

  return { init };
};
