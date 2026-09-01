import fs from 'node:fs';

const required = [
  'GITHUB_EVENT_NAME',
  'POLICY_SHA',
  'BASE_SHA',
  'HEAD_SHA',
  'CONFIG_SHA',
];
for (const name of required) {
  if (!process.env[name])
    throw new Error(`${name} is required for JiTTest metadata`);
}

const metadata = {
  schema: 1,
  event: process.env.GITHUB_EVENT_NAME,
  policySha: process.env.POLICY_SHA,
  baseSha: process.env.BASE_SHA,
  headSha: process.env.HEAD_SHA,
  configSha256: process.env.CONFIG_SHA,
  cliVersion: '0.4.0',
  model: 'anthropic/claude-sonnet-4',
  maxCostUsd: 5,
  maxTokens: 200_000,
  releaseEvidence: true,
};

fs.writeFileSync(
  '.jittest/run-metadata.json',
  `${JSON.stringify(metadata, null, 2)}\n`
);
