type SameSite = 'lax' | 'strict' | 'none';

export type AuthCookieAttributes = {
  httpOnly: true;
  path: '/';
  sameSite: SameSite;
  secure: boolean;
};

export type AuthCookieSecurityOptions = {
  cookies?: {
    session_token: {
      attributes: AuthCookieAttributes;
      name: '__Host-session';
    };
  };
  defaultCookieAttributes: AuthCookieAttributes;
  useSecureCookies: false;
};

export type AuthCookieSecurityOptionsInput = {
  isProduction?: boolean;
};

export function createAuthCookieSecurityOptions(
  baseUrl: string,
  input: AuthCookieSecurityOptionsInput = {}
): AuthCookieSecurityOptions {
  const parsedBaseUrl = new URL(baseUrl);
  const secure = parsedBaseUrl.protocol === 'https:';
  if (input.isProduction && !secure) {
    throw new TypeError(
      'Production auth cookies require an HTTPS VITE_BASE_URL.'
    );
  }

  const attributes = {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure,
  } satisfies AuthCookieAttributes;

  return {
    defaultCookieAttributes: attributes,
    useSecureCookies: false,
    ...(secure
      ? {
          cookies: {
            session_token: {
              attributes,
              name: '__Host-session',
            },
          },
        }
      : undefined),
  };
}
