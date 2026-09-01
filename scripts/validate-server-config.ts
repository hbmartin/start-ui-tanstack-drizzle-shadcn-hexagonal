import { validateServerConfig } from '@/modules/kernel/backend';

// `pnpm env` validates the local development server, whose explicit runtime
// profile is Node. Production profile entries validate themselves at startup.
validateServerConfig('node');
