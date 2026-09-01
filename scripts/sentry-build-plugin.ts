export type SentryBuildPluginEnvironment = Readonly<{
  authToken?: string;
  disabled: boolean;
  dsn?: string;
  organization?: string;
  project?: string;
}>;

export const shouldEnableSentryBuildPlugin = (
  environment: SentryBuildPluginEnvironment
) =>
  !environment.disabled &&
  Boolean(
    environment.dsn &&
    environment.organization &&
    environment.project &&
    environment.authToken
  );
