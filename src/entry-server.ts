import { createStartHandler } from '@tanstack/react-start/server';
import type { ServerEntry } from '@tanstack/react-start/server-entry';

import { observedStreamHandler } from '@/runtime/observed-stream-handler';

const entry: ServerEntry = {
  fetch: createStartHandler(observedStreamHandler),
};

export const createServerEntry = (serverEntry: ServerEntry): ServerEntry =>
  serverEntry;

export default entry;
