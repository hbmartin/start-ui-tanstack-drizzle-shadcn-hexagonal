import type { ApplicationResult } from '@/modules/kernel/application/result';

import type {
  AuthEmailPort,
  AuthEmailSendSignInOtpOutcome,
} from '../ports/auth-email-port';
import type {
  AuthorizationGateway,
  AuthorizationGatewayOutcome,
} from '../ports/authorization-gateway';
import type {
  SessionGateway,
  SessionGatewayOutcome,
} from '../ports/session-gateway';
export type AuthUseCaseDeps = {
  sessionGateway: SessionGateway;
  authorizationGateway: AuthorizationGateway;
  authEmailPort: AuthEmailPort;
};

export type AuthSessionOutcome = SessionGatewayOutcome;

export type AuthPermissionOutcome = AuthorizationGatewayOutcome;

export type AuthSendSignInOtpOutcome = AuthEmailSendSignInOtpOutcome;

export type AuthResult<TOutcome> = ApplicationResult<TOutcome>;
