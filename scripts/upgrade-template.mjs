#!/usr/bin/env node
/**
 * Pull upstream template releases into an adopter fork.
 *
 * The adopter zone (`src/app/adopter/**` and brand assets in `public/`) is
 * protected by `.gitattributes` `merge=ours`, so a template merge keeps your
 * product identity while everything upstream-owned (security fixes,
 * dependency bumps, architecture changes) comes in. See docs/upgrading.md.
 *
 * Usage:
 *   pnpm upgrade:template -- --list
 *   pnpm upgrade:template -- --tag v4.1.0
 *   pnpm upgrade:template -- --tag v4.1.0 --dry-run
 */
import { parseArgs } from 'node:util';

import { runGit, runGitStrict } from './lib/git-utils.mjs';

const DEFAULT_UPSTREAM_URL = 'https://github.com/hbmartin/start-ui-web.git';
const REMOTE = 'upstream';

const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    base: { type: 'string' },
    'remote-url': { type: 'string', default: DEFAULT_UPSTREAM_URL },
    list: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const log = (message) => console.log(message);

if (values.help) {
  log(`Upgrade this fork from the upstream template.

Options:
  --tag <ref>         Upstream tag (or ref) to merge, e.g. v4.1.0
  --base <ref>        Base ref for the changelog/diff summary
                      (default: your last merged upstream tag, else the merge base)
  --remote-url <url>  Upstream remote URL (default: ${DEFAULT_UPSTREAM_URL})
  --list              List recent upstream tags and exit
  --dry-run           Show the changelog and diff summary without merging
  --help              Show this help`);
  process.exit(0);
}

const ensureCleanWorktree = () => {
  const status = runGitStrict(['status', '--porcelain']).trim();
  if (status) {
    console.error(
      'Working tree is not clean. Commit or stash your changes before upgrading.'
    );
    process.exit(1);
  }
};

const ensureUpstreamRemote = () => {
  const existingUrl = runGit(['remote', 'get-url', REMOTE]);
  if (existingUrl === null) {
    runGitStrict(['remote', 'add', REMOTE, values['remote-url']]);
    log(`Added remote '${REMOTE}' -> ${values['remote-url']}`);
    return;
  }

  if (existingUrl !== values['remote-url']) {
    log(`Using existing remote '${REMOTE}' -> ${existingUrl}`);
  }
};

/**
 * `merge=ours` in .gitattributes is inert until the driver is enabled; this
 * is what actually protects the adopter zone during the merge.
 */
const ensureOursMergeDriver = () => {
  runGitStrict(['config', 'merge.ours.driver', 'true']);
};

const fetchUpstream = () => {
  log(`Fetching ${REMOTE} (with tags)...`);
  runGitStrict(['fetch', REMOTE, '--tags', '--prune']);
};

const listTags = () => {
  const tags = runGitStrict(['tag', '--sort=-creatordate', '--list'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(0, 20);

  if (tags.length === 0) {
    log('No tags found. Is the upstream remote correct?');
    return;
  }

  log('Most recent upstream tags:');
  for (const tag of tags) log(`  ${tag}`);
};

const resolveBaseRef = () => {
  if (values.base) return values.base;

  // Prefer the last upstream tag reachable from HEAD (the previous template
  // version this fork is based on); fall back to the merge base.
  const lastMergedTag = runGit(['describe', '--tags', '--abbrev=0']);
  if (lastMergedTag) return lastMergedTag;

  const mergeBase = runGit(['merge-base', 'HEAD', `${REMOTE}/main`]);
  if (mergeBase) return mergeBase;

  console.error(
    'Could not determine a base ref. Pass one explicitly with --base <ref>.'
  );
  process.exit(1);
};

const printSummary = (base, target) => {
  log(`\nUpgrading from ${base} to ${target}\n`);

  const changelog = runGit(['log', '--oneline', `${base}..${target}`]);
  if (changelog) {
    const lines = changelog.split('\n').filter(Boolean);
    log(`Upstream commits (${lines.length}):`);
    for (const line of lines.slice(0, 30)) log(`  ${line}`);
    if (lines.length > 30) log(`  ... and ${lines.length - 30} more`);
  }

  const diffStat = runGit(['diff', '--shortstat', `${base}...${target}`]);
  if (diffStat) log(`\nDiff summary:${diffStat}`);
};

const merge = (target) => {
  log(`\nMerging ${target} (adopter zone protected by merge=ours)...`);
  const result = runGit([
    'merge',
    '--no-ff',
    target,
    '-m',
    `Merge template release ${target}`,
  ]);

  if (result === null) {
    const conflicted = runGit(['diff', '--name-only', '--diff-filter=U']);
    console.error('\nMerge produced conflicts. Resolve them, then run:');
    console.error('  git add <files> && git merge --continue');
    if (conflicted) {
      console.error('\nConflicted files:');
      for (const file of conflicted.split('\n').filter(Boolean)) {
        console.error(`  ${file}`);
      }
    }
    process.exit(1);
  }

  log('\nMerge complete. Next steps:');
  log('  pnpm install');
  log('  pnpm db:generate  # only if upstream changed schema');
  log('  pnpm verify');
};

ensureUpstreamRemote();
fetchUpstream();
ensureOursMergeDriver();

if (values.list) {
  listTags();
  process.exit(0);
}

if (!values.tag) {
  console.error(
    'Pass the upstream tag to merge: pnpm upgrade:template -- --tag <ref>\n' +
      'Use --list to see recent tags.'
  );
  process.exit(1);
}

ensureCleanWorktree();

const base = resolveBaseRef();
printSummary(base, values.tag);

if (values['dry-run']) {
  log('\nDry run — no merge performed.');
  process.exit(0);
}

merge(values.tag);
