import type { QueryClient } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { type ReactNode, useEffect } from 'react';
import '@/platform/lib/temporal/polyfill';
import '@/app/i18n/setup';
import '@fontsource-variable/inter';

import { QueryClientProvider } from '@/platform/lib/tanstack-query/provider';

import { Sonner } from '@/platform/components/ui/sonner';
import { CspProvider } from '@/platform/components/ui/csp-provider';

import { telemetryProxy } from '@/composition/telemetry';
import { useCurrentSessionQuery } from '@/modules/auth/client';
import { readCspNonceFromMeta } from '@/platform/http/csp-nonce';

export const Providers = (props: {
  children: ReactNode;
  client: QueryClient;
  cspNonce?: string;
  forcedTheme?: string;
}) => {
  const cspNonce = props.cspNonce ?? readCspNonceFromMeta();

  return (
    <CspProvider nonce={cspNonce}>
      <ThemeProvider
        attribute="class"
        storageKey="theme"
        disableTransitionOnChange
        nonce={cspNonce}
        forcedTheme={props.forcedTheme}
      >
        <QueryClientProvider client={props.client}>
          <ProviderContent>{props.children}</ProviderContent>
        </QueryClientProvider>
      </ThemeProvider>
    </CspProvider>
  );
};

function ProviderContent(props: { children: ReactNode }) {
  return (
    <>
      <TelemetryUserSync />
      {props.children}
      <Sonner />
    </>
  );
}

function TelemetryUserSync() {
  const { data } = useCurrentSessionQuery();

  useEffect(() => {
    if (!data?.user) {
      telemetryProxy.setUser(null);
      return;
    }

    telemetryProxy.setUser({
      email: data.user.email,
      id: data.user.id,
      role: data.user.role,
    });
  }, [data?.user]);

  return null;
}
