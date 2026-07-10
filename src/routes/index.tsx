import { createFileRoute } from '@tanstack/react-router';

import { PageHome } from '@/app/shell/presentation';

export const Route = createFileRoute('/')({
  component: PageHome,
});
