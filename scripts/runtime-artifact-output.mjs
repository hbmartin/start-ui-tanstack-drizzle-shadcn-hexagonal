import fs from 'node:fs';
import path from 'node:path';

const relativeOutputByProfile = {
  cloudflare: 'dist',
  node: '.output/node',
  vercel: '.vercel/output',
};

export const runtimeArtifactOutputDirectory = (profile, repositoryRoot) => {
  const relativeOutput = relativeOutputByProfile[profile];
  if (!relativeOutput) {
    throw new Error(`Unknown runtime artifact profile ${String(profile)}`);
  }

  const lexicalRoot = path.resolve(repositoryRoot);
  if (lexicalRoot === path.parse(lexicalRoot).root) {
    throw new Error(
      'Refusing to resolve runtime artifacts from a filesystem root'
    );
  }

  const resolvedRoot = fs.realpathSync.native(lexicalRoot);

  const outputDirectory = path.resolve(resolvedRoot, relativeOutput);
  if (!outputDirectory.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Runtime artifact output escaped the repository root');
  }
  return outputDirectory;
};

const readPathMetadata = (candidatePath) => {
  try {
    return fs.lstatSync(candidatePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};

const assertPathComponentIsNotSymlink = (candidatePath) => {
  const metadata = readPathMetadata(candidatePath);
  if (metadata?.isSymbolicLink()) {
    throw new Error(
      `Refusing to remove runtime artifacts through symbolic link ${candidatePath}`
    );
  }
  return metadata !== undefined;
};

const assertArtifactPathHasNoSymlinks = (outputDirectory, repositoryRoot) => {
  let currentPath = repositoryRoot;
  for (const segment of path
    .relative(repositoryRoot, outputDirectory)
    .split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    if (!assertPathComponentIsNotSymlink(currentPath)) return;
  }
};

export const removeRuntimeArtifactOutput = (profile, repositoryRoot) => {
  const outputDirectory = runtimeArtifactOutputDirectory(
    profile,
    repositoryRoot
  );
  const resolvedRoot = fs.realpathSync.native(path.resolve(repositoryRoot));
  assertArtifactPathHasNoSymlinks(outputDirectory, resolvedRoot);
  fs.rmSync(outputDirectory, { force: true, recursive: true });
};
