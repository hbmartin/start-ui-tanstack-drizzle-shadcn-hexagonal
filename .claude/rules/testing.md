---
paths:
  - 'tests/**/*.{test,spec}.{ts,tsx,mjs}'
  - 'src/**/*.{test,spec}.{ts,tsx,mjs}'
---

# Testing Rules

Authoritative reference: `AGENTS.md` and `TESTING.md`.

Use the cheapest layer that proves the behavior. Assert observable results and
durable side effects rather than private call sequences. Database adapter
changes require integration coverage when SQL serialization or driver behavior
matters. Run `pnpm test:affected` after changes and escalate to the browser,
E2E, visual, or runtime artifact gates described in `AGENTS.md`.
