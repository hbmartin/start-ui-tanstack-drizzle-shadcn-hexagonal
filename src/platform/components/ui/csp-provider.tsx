import { CSPProvider as BaseCspProvider } from '@base-ui/react/csp-provider';
import type { ComponentProps } from 'react';

type CspProviderProps = ComponentProps<typeof BaseCspProvider>;

export const CspProvider = (props: CspProviderProps) => (
  <BaseCspProvider {...props} />
);
