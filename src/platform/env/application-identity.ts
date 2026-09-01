import { z } from 'zod';

const applicationSlugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const applicationNameControlCharacterPattern = /\p{Cc}/u;

export const applicationIdentitySchema = z.object({
  APP_NAME: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !applicationNameControlCharacterPattern.test(value), {
      message: 'APP_NAME must not contain control characters',
    }),
  APP_SLUG: z.string().trim().min(2).max(63).regex(applicationSlugPattern),
});

export type ApplicationIdentity = Readonly<{
  name: string;
  slug: string;
}>;

export const parseApplicationIdentity = (
  source: Record<string, unknown>
): ApplicationIdentity => {
  const parsed = applicationIdentitySchema.parse(source);
  return { name: parsed.APP_NAME, slug: parsed.APP_SLUG };
};
