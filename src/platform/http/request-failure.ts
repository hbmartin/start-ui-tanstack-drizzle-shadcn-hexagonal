const responseFromFailure = (failure: unknown): Response | undefined => {
  try {
    if (failure instanceof Response) return failure;

    if (typeof failure !== 'object' || failure === null) return undefined;

    const response = (failure as { response?: unknown }).response;
    return response instanceof Response ? response : undefined;
  } catch {
    return undefined;
  }
};

const isTanStackControlFlow = (failure: unknown) => {
  if (typeof failure !== 'object' || failure === null) return false;
  try {
    const candidate = failure as {
      isNotFound?: unknown;
      isRedirect?: unknown;
    };
    return candidate.isNotFound === true || candidate.isRedirect === true;
  } catch {
    return false;
  }
};

export const isUnexpectedRequestFailure = (failure: unknown) => {
  if (isTanStackControlFlow(failure)) return false;
  const statusCode = responseFromFailure(failure)?.status;
  return statusCode === undefined || statusCode >= 500;
};
