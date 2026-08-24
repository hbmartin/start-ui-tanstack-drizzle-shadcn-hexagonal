export const ALLOWED_AUTH_HTTP_REQUESTS = [
  {
    body: { email: 'user@example.com', otp: '123456' },
    method: 'POST',
    pathname: '/api/auth/sign-in/email-otp',
  },
  {
    body: { provider: 'github' },
    method: 'POST',
    pathname: '/api/auth/sign-in/social',
  },
  {
    body: { email: 'user@example.com', type: 'sign-in' },
    method: 'POST',
    pathname: '/api/auth/email-otp/send-verification-otp',
  },
  { method: 'GET', pathname: '/api/auth/callback/github' },
  {
    method: 'GET',
    pathname: '/api/auth/callback/github?code=opaque&state=opaque',
  },
] as const;

export const DENIED_AUTH_HTTP_REQUESTS = [
  { method: 'POST', pathname: '/api/auth/admin/remove-user' },
  { method: 'POST', pathname: '/api/auth/admin/set-role' },
  { method: 'GET', pathname: '/api/auth/open-api/generate-schema' },
  { method: 'GET', pathname: '/api/auth/reference' },
  { method: 'POST', pathname: '/api/auth/sign-up/email' },
  { method: 'POST', pathname: '/api/auth/sign-out' },
  { method: 'POST', pathname: '/api/auth/delete-user' },
  { method: 'POST', pathname: '/api/auth/revoke-sessions' },
  { method: 'POST', pathname: '/api/auth/request-password-reset' },
  { method: 'POST', pathname: '/api/auth/update-user' },
  { method: 'GET', pathname: '/api/auth/list-accounts' },
  { method: 'GET', pathname: '/api/auth/sign-in/email-otp' },
  { method: 'GET', pathname: '/api/auth/get-session' },
  { method: 'POST', pathname: '/api/auth/get-session' },
  { method: 'GET', pathname: '/api/auth/callback' },
  { method: 'GET', pathname: '/api/auth/callback/github/extra' },
  { method: 'GET', pathname: '/api/auth/callback/github.com' },
  { method: 'GET', pathname: '/api/auth/callback/gitlab' },
  { method: 'POST', pathname: '/api/auth/callback/github' },
  { method: 'GET', pathname: '/api/auth/callback/github%2Fadmin' },
  { method: 'GET', pathname: '/api/auth/callback/%67ithub' },
  { method: 'GET', pathname: '/api/auth//callback/github' },
  { method: 'GET', pathname: '/api//auth/callback/github' },
  { method: 'GET', pathname: '/api/auth/callback/github/' },
  { method: 'GET', pathname: '/api/auth-future/callback/github' },
  {
    body: { email: 'user@example.com', type: 'email-verification' },
    method: 'POST',
    pathname: '/api/auth/email-otp/send-verification-otp',
  },
  {
    body: { email: 'user@example.com', type: 'forget-password' },
    method: 'POST',
    pathname: '/api/auth/email-otp/send-verification-otp',
  },
  {
    body: { provider: 'gitlab' },
    method: 'POST',
    pathname: '/api/auth/sign-in/social',
  },
  {
    body: { provider: 'github', requestSignUp: true },
    method: 'POST',
    pathname: '/api/auth/sign-in/social',
  },
] as const;

export type AuthHttpRequestFixture = {
  body?: unknown;
  method: string;
  pathname: string;
};

export const createAuthHttpRequest = (fixture: AuthHttpRequestFixture) =>
  new Request(`http://localhost${fixture.pathname}`, {
    body: fixture.body === undefined ? undefined : JSON.stringify(fixture.body),
    headers:
      fixture.body === undefined
        ? undefined
        : { 'content-type': 'application/json' },
    method: fixture.method,
  });
