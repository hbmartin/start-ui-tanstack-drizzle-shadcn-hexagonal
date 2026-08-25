export type RequestExceptionCaptureState = {
  readonly captured: Set<unknown>;
};

const requestExceptionStates = new WeakMap<
  Request,
  RequestExceptionCaptureState
>();

export const createRequestExceptionCaptureState =
  (): RequestExceptionCaptureState => ({ captured: new Set() });

export const isRequestExceptionCaptureState = (
  value: unknown
): value is RequestExceptionCaptureState => {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return (value as RequestExceptionCaptureState).captured instanceof Set;
  } catch {
    return false;
  }
};

export const claimRequestException = (
  state: RequestExceptionCaptureState,
  failure: unknown
) => {
  if (state.captured.has(failure)) return false;
  state.captured.add(failure);
  return true;
};

export const bindRequestExceptionState = (
  request: Request,
  state: RequestExceptionCaptureState
) => {
  requestExceptionStates.set(request, state);
};

export const getRequestExceptionState = (request: Request) =>
  requestExceptionStates.get(request);
