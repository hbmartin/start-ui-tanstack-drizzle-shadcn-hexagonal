import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const sensitiveEnvironmentKeys = new Set(['LLM_API_KEY', 'OPENROUTER_API_KEY']);

export const scrubJittestChildEnvironment = (environment) =>
  Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([key]) => !sensitiveEnvironmentKeys.has(key)
    )
  );

const originalExecFile = childProcess.execFile;

const scrubbedExecFile = function scrubbedExecFile(
  file,
  args,
  options,
  callback
) {
  if (typeof args === 'function') return originalExecFile(file, args);
  if (typeof options === 'function' || options === undefined) {
    return originalExecFile(file, args, options);
  }
  return originalExecFile(
    file,
    args,
    {
      ...options,
      env: scrubJittestChildEnvironment(options.env ?? process.env),
    },
    callback
  );
};

Object.defineProperty(scrubbedExecFile, promisify.custom, {
  configurable: true,
  value: (file, args, options = {}) =>
    new Promise((resolve, reject) => {
      scrubbedExecFile(file, args, options, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    }),
});

childProcess.execFile = scrubbedExecFile;

syncBuiltinESMExports();
