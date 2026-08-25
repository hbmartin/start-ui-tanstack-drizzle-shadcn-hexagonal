import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isDevVarsFile = (name) =>
  name === '.dev.vars' || name.startsWith('.dev.vars.');

export const findCloudflareDevVars = (root = process.cwd()) =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isDevVarsFile(entry.name))
    .map((entry) => path.join(root, entry.name));

export const assertSafeCloudflareBuildInput = (root = process.cwd()) => {
  const devVarsFiles = findCloudflareDevVars(root);
  if (devVarsFiles.length > 0) {
    throw new Error(
      `Cloudflare production build refuses local dev-var files: ${devVarsFiles
        .map((filePath) => path.basename(filePath))
        .join(
          ', '
        )}. Use explicit CI inputs or remote Wrangler secrets; never package .dev.vars.`
    );
  }
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  try {
    assertSafeCloudflareBuildInput();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
