import { getEnvClient } from '../src/platform/env/client';
import {
  isProdRuntimeEnvironment,
  readRuntimeEnv,
} from '../src/platform/env/runtime';
import { parseRuntimeProfile } from '../src/platform/runtime/runtime-profile';

const raw = readRuntimeEnv();
const profile = raw.START_UI_RUNTIME_PROFILE;
getEnvClient(
  isProdRuntimeEnvironment(raw) || profile !== undefined
    ? parseRuntimeProfile(profile)
    : undefined
);
