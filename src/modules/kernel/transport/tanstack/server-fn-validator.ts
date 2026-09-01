import type { z } from 'zod';

import { ServerFnError } from './server-fn-error';

/**
 * Converts schema failures before TanStack's handler phase into the same
 * closed error type used by application handlers. The global function
 * middleware supplies request correlation, logging, and HTTP semantics.
 */
export const serverFnValidator =
  <TSchema extends z.ZodType>(schema: TSchema) =>
  async (input: z.input<TSchema>): Promise<z.output<TSchema>> => {
    const parsed = await schema.safeParseAsync(input);
    if (!parsed.success) {
      throw new ServerFnError('BAD_REQUEST', { cause: parsed.error });
    }
    return parsed.data;
  };
