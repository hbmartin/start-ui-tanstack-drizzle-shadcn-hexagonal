import { validateServerBuildConfig } from '@/modules/kernel/backend';
import { readRuntimeEnv } from '@/platform/env/runtime';
import { parseRuntimeProfile } from '@/platform/runtime/runtime-profile';

validateServerBuildConfig(
  parseRuntimeProfile(readRuntimeEnv().START_UI_RUNTIME_PROFILE)
);
