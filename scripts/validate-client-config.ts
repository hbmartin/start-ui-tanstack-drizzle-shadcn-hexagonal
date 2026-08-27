import { getEnvClient } from '../src/platform/env/client';
import { readRuntimeEnv } from '../src/platform/env/runtime';
import { parseRuntimeProfile } from '../src/platform/runtime/runtime-profile';

const profile = readRuntimeEnv().START_UI_RUNTIME_PROFILE;
getEnvClient(profile === undefined ? undefined : parseRuntimeProfile(profile));
