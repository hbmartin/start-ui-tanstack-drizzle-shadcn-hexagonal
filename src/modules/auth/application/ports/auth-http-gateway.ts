import type { RuntimeProfile } from '@/platform/runtime/runtime-profile';

export interface AuthHttpGateway {
  handle(
    request: Request,
    runtimeProfile: RuntimeProfile
  ): Promise<Response> | Response;
}
