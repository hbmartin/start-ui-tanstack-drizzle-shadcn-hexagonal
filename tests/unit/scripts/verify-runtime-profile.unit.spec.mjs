import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyRuntimeProfile } from '../../../scripts/verify-runtime-profile.mjs';

const temporaryDirectories = [];

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-artifact-'));
  temporaryDirectories.push(root);
  return root;
};

const write = (root, relativePath, contents = '') => {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
};

const writeJson = (root, relativePath, value) =>
  write(root, relativePath, `${JSON.stringify(value)}\n`);

const cloudflareSentryOwner =
  'const fetchCloudflareApplication=({context,handle,request,sentryOptions})=>sentryOptions?runWithCloudflareSentry({api:Sentry,handle,request,requestOptions:{captureErrors:false,context,options:sentryOptions,request}}):handle();';

const createNodeArtifact = (root) => {
  writeJson(root, '.output/node/nitro.json', {
    preset: 'node-server',
    publicDir: 'public',
    serverEntry: 'server/index.mjs',
  });
  write(root, '.output/node/server/index.mjs');
  write(
    root,
    '.output/node/server/_ssr/ssr.mjs',
    'const {initNodeTelemetry}=await import("../_libs/telemetry-bridge.mjs");await initNodeTelemetry();createApplicationServerEntry("node", undefined, runWithNodeSentryRequestIsolation);NodeTracerProvider'
  );
  write(
    root,
    '.output/node/server/_libs/telemetry-bridge.mjs',
    'import {n as initializeNodeTelemetryOnce} from "../_ssr/telemetry-owner.mjs";export {initializeNodeTelemetryOnce as initNodeTelemetry};'
  );
  write(
    root,
    '.output/node/server/_ssr/telemetry-owner.mjs',
    'const initializeSentryNodeRequestContext=()=>{};const create=()=>new SentryContextManager();const initNodeTelemetry=async()=>{await initializeSentryNodeRequestContext();create()};export {initNodeTelemetry as n};'
  );
  fs.mkdirSync(path.join(root, '.output/node/public'));
};

const createVercelArtifact = (root) => {
  writeJson(root, '.vercel/output/nitro.json', {
    preset: 'vercel',
    publicDir: 'static',
    serverEntry: 'functions/__server.func/index.mjs',
  });
  writeJson(root, '.vercel/output/config.json', { version: 3 });
  writeJson(root, '.vercel/output/functions/__server.func/.vc-config.json', {
    runtime: 'nodejs24.x',
    supportsResponseStreaming: true,
  });
  write(root, '.vercel/output/functions/__server.func/index.mjs');
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
    'createApplicationServerEntry("vercel", vercelRequestLifecycle, runWithVercelSentryRequestIsolation);"@vercel/functions";"@vercel/otel"'
  );
  fs.mkdirSync(path.join(root, '.vercel/output/static'));
};

const createCloudflareArtifact = (root) => {
  writeJson(root, 'wrangler.json', {
    compatibility_date: '2026-08-24',
    compatibility_flags: ['nodejs_compat'],
    hyperdrive: [
      {
        binding: 'START_UI_DATABASE',
        id: '00000000-0000-0000-0000-000000000000',
      },
    ],
    main: 'src/server.ts',
    name: 'acme-app',
  });
  writeJson(root, 'dist/server/wrangler.json', {
    assets: { directory: '../client' },
    compatibility_date: '2026-08-24',
    compatibility_flags: ['nodejs_compat'],
    hyperdrive: [
      {
        binding: 'START_UI_DATABASE',
        id: '00000000-0000-0000-0000-000000000000',
      },
    ],
    main: 'index.js',
    name: 'acme-app',
  });
  write(
    root,
    'dist/server/index.js',
    `${cloudflareSentryOwner}createApplicationServerEntry("cloudflare");const worker_entry_default={async fetch(request,environment,context){const sentryOptions=configure();const handleApplication=()=>application.fetch(request);const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{}}};export{worker_entry_default as default};"cloudflare:workers";START_UI_TELEMETRY_METRICS`
  );
  fs.mkdirSync(path.join(root, 'dist/client'));
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('runtime artifact verifier', () => {
  it('accepts each exact target artifact contract', () => {
    const root = fixture();
    createNodeArtifact(root);
    createVercelArtifact(root);
    createCloudflareArtifact(root);

    expect(verifyRuntimeProfile('node', root)).toBe('node');
    expect(verifyRuntimeProfile('vercel', root)).toBe('vercel');
    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  });

  it('rejects a missing output directory or wrong compiled profile', () => {
    const missingPublicRoot = fixture();
    createNodeArtifact(missingPublicRoot);
    fs.rmSync(path.join(missingPublicRoot, '.output/node/public'), {
      recursive: true,
    });
    expect(() => verifyRuntimeProfile('node', missingPublicRoot)).toThrow(
      '.output/node/public'
    );

    const wrongProfileRoot = fixture();
    createNodeArtifact(wrongProfileRoot);
    write(
      wrongProfileRoot,
      '.output/node/server/_ssr/ssr.mjs',
      'createApplicationServerEntry("vercel")'
    );
    expect(() => verifyRuntimeProfile('node', wrongProfileRoot)).toThrow(
      'exactly one node profile marker'
    );

    const mixedProfileRoot = fixture();
    createNodeArtifact(mixedProfileRoot);
    write(
      mixedProfileRoot,
      '.output/node/server/_ssr/ssr.mjs',
      'createApplicationServerEntry("node");createApplicationServerEntry("vercel")'
    );
    expect(() => verifyRuntimeProfile('node', mixedProfileRoot)).toThrow(
      'exactly one node profile marker'
    );
  });

  it('rejects incompatible Vercel function metadata', () => {
    const root = fixture();
    createVercelArtifact(root);
    writeJson(root, '.vercel/output/functions/__server.func/.vc-config.json', {
      runtime: 'nodejs22.x',
      supportsResponseStreaming: false,
    });
    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'Vercel Node 24 runtime'
    );
  });

  it('rejects a Cloudflare artifact with a detached database binding token', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/index.js',
      `${cloudflareSentryOwner}createApplicationServerEntry("cloudflare");const worker_entry_default={async fetch(request,environment,context){const sentryOptions=configure();const handleApplication=()=>application.fetch(request);const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.MISSING_DATABASE,handle:handleApplication,request});try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{}}};export{worker_entry_default as default};"cloudflare:workers";"START_UI_DATABASE";START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must bind the Cloudflare database owner to environment.START_UI_DATABASE'
    );
  });

  it('rejects a Cloudflare artifact without its source Hyperdrive binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const sourceConfig = JSON.parse(
      fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8')
    );
    delete sourceConfig.hyperdrive;
    writeJson(root, 'wrangler.json', sourceConfig);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare source Hyperdrive bindings');
  });

  it('rejects generated Hyperdrive binding drift', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const generatedConfig = JSON.parse(
      fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
    );
    generatedConfig.hyperdrive[0].binding = 'DETACHED_DATABASE';
    writeJson(root, 'dist/server/wrangler.json', generatedConfig);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare generated Hyperdrive binding name');
  });

  it('rejects a Cloudflare database owner hidden in an unreachable helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/index.js',
      `${cloudflareSentryOwner}createApplicationServerEntry("cloudflare");function neverCalled(environment,handle,request){return runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle,request})}const worker_entry_default={async fetch(request,environment,context){return new Response()}};export{worker_entry_default as default};"cloudflare:workers";START_UI_DATABASE;START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must use trusted owner application exactly once');
  });

  it('rejects a Cloudflare database owner after an unwrapped response path', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/index.js',
      `${cloudflareSentryOwner}createApplicationServerEntry("cloudflare");const worker_entry_default={async fetch(request,environment,context){const sentryOptions=configure();const handleApplication=()=>application.fetch(request);const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});if(true)return new Response();try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{}}};export{worker_entry_default as default};"cloudflare:workers";START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must have exactly one Sentry-owned return path');
  });

  it('rejects a Cloudflare artifact with a bypassed Sentry owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOwner,
          'const fetchCloudflareApplication=({handle})=>handle();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare Sentry owner must accept the active request inputs');
  });

  it('rejects a Cloudflare artifact with a bypassed application handler', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request)',
          'const handleApplication=()=>new Response("bypassed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must use trusted owner application exactly once');
  });

  it('rejects duplicate runtime-effective Cloudflare owner properties', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'binding:environment.START_UI_DATABASE,handle:handleApplication,request',
          'binding:environment.START_UI_DATABASE,handle:handleApplication,request,binding:environment.MISSING_DATABASE'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Cloudflare database owner must not contain duplicate properties'
    );
  });

  it('rejects computed runtime-effective Cloudflare owner properties', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        `${cloudflareSentryOwner}createApplicationServerEntry`,
        `${cloudflareSentryOwner}const bindingKey="binding";createApplicationServerEntry`
      )
      .replace(
        'binding:environment.START_UI_DATABASE,handle:handleApplication,request',
        'binding:environment.START_UI_DATABASE,handle:handleApplication,request,[bindingKey]:environment.MISSING_DATABASE'
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare database owner must use static property keys');
  });

  it('rejects legal var redeclaration of a Cloudflare owner callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request);const handleDatabase=',
          'var handleApplication=()=>application.fetch(request);var handleApplication=()=>new Response("bypassed");const handleDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must declare its application handler exactly once');
  });

  it('rejects destructuring var redeclaration of a Cloudflare owner callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request);const handleDatabase=',
          'var handleApplication=()=>application.fetch(request);var {replacement:handleApplication}={replacement:()=>new Response("bypassed")};const handleDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must declare its application handler exactly once');
  });

  it('rejects a default parameter that substitutes the application request', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request);',
          'const handleApplication=(request=new Request("https://bypassed.test"))=>application.fetch(request);'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('active application handler must accept no substitutable inputs');
  });

  it('rejects a default parameter that substitutes the database callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase',
          'const handleDatabase=(handleApplication=()=>new Response("bypassed"))=>runWithCloudflareDatabase'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('active database handler must accept no substitutable inputs');
  });

  it.each([
    ['request', 'var request=new Request("https://bypassed.test");'],
    [
      'environment',
      'var environment={START_UI_DATABASE:{connectionString:"postgresql://bypassed.test/app"}};',
    ],
  ])(
    'rejects var redeclaration of the active fetch %s parameter',
    (parameter, redeclaration) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const entryPath = path.join(root, 'dist/server/index.js');
      write(
        root,
        'dist/server/index.js',
        fs
          .readFileSync(entryPath, 'utf8')
          .replace(
            'const sentryOptions=configure();',
            `${redeclaration}const sentryOptions=configure();`
          )
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`Worker fetch must not override active parameter ${parameter}`);
    }
  );

  it('rejects an extra parameter that shadows the Sentry wrapper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '({context,handle,request,sentryOptions})=>',
          '({context,handle,request,sentryOptions},runWithCloudflareSentry=({handle})=>handle())=>'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare Sentry owner must accept exactly one request input');
  });

  it('rejects a catch parameter captured by a hoisted application callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request);',
          'try{throw new Request("https://bypassed.test")}catch(request){var handleApplication=()=>application.fetch(request)}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not override active parameter request');
  });

  it('rejects fetch-local substitutions for trusted Cloudflare owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const sentryOptions=configure();',
          'const fetchCloudflareApplication=({handle})=>handle();const application={fetch:()=>new Response("bypassed")};const runWithCloudflareDatabase=({handle})=>handle();const sentryOptions=configure();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not override trusted owner application');
  });

  it('rejects reassigned Cloudflare request-owner callbacks', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request);const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try',
          'let handleApplication=()=>application.fetch(request);let handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});handleApplication=()=>new Response("application bypassed");handleDatabase=()=>new Response("database bypassed");try'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not mutate active binding handleApplication');
  });

  it('rejects destructuring reassignment of Cloudflare request-owner callbacks', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try',
          'let handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});[handleDatabase]=[()=>new Response("database bypassed")];try'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not mutate active binding handleDatabase');
  });

  it('rejects nested callback substitution of Cloudflare request owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try',
          'let handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});const substitute=()=>{handleDatabase=()=>new Response("database bypassed")};substitute();try'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not mutate active binding handleDatabase');
  });

  it('rejects call-based mutation of a trusted Cloudflare owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const sentryOptions=configure();',
          'Object.assign(application,{fetch:()=>new Response("bypassed")});const sentryOptions=configure();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must use trusted owner application exactly once');
  });

  it('rejects top-level aliases used to mutate a trusted Cloudflare owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        `${cloudflareSentryOwner}createApplicationServerEntry`,
        `${cloudflareSentryOwner}const appAlias=application;createApplicationServerEntry`
      )
      .replace(
        'const sentryOptions=configure();',
        'Object.assign(appAlias,{fetch:()=>new Response("bypassed")});const sentryOptions=configure();'
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not alias trusted owner application');
  });

  it.each([
    [
      'node',
      createNodeArtifact,
      '.output/node/server/_ssr/ssr.mjs',
      'runWithNodeSentryRequestIsolation',
    ],
    [
      'vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
      'runWithVercelSentryRequestIsolation',
    ],
  ])(
    'rejects a %s artifact with detached Sentry request isolation',
    (profile, createArtifact, entry, owner) => {
      const root = fixture();
      createArtifact(root);
      const entryPath = path.join(root, entry);
      write(
        root,
        entry,
        `${fs
          .readFileSync(entryPath, 'utf8')
          .replace(owner, 'undefined')};const detachedOwner = "${owner}"`
      );
      expect(() => verifyRuntimeProfile(profile, root)).toThrow(
        `${profile} server entry owner ${owner}`
      );
    }
  );

  it('rejects a Node artifact without its async-context owner', () => {
    const root = fixture();
    createNodeArtifact(root);
    const owner = '.output/node/server/_ssr/telemetry-owner.mjs';
    const ownerPath = path.join(root, owner);
    write(
      root,
      owner,
      fs
        .readFileSync(ownerPath, 'utf8')
        .replace('new SentryContextManager()', 'new MissingContextOwner()')
    );
    write(
      root,
      '.output/node/server/vendor/unused-sentry.mjs',
      'export class SentryContextManager {}'
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must link its Node async-context owner'
    );
  });

  it('rejects async-context symbols that are unreachable from the initializer', () => {
    const root = fixture();
    createNodeArtifact(root);
    write(
      root,
      '.output/node/server/_ssr/telemetry-owner.mjs',
      'const initializeSentryNodeRequestContext=()=>{};const unused=()=>new SentryContextManager();const alsoUnused=()=>initializeSentryNodeRequestContext();const initNodeTelemetry=async()=>{};export {initNodeTelemetry as n};'
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must link its Node async-context owner'
    );
  });

  it('rejects async-context symbols inside an uncalled nested helper', () => {
    const root = fixture();
    createNodeArtifact(root);
    write(
      root,
      '.output/node/server/_ssr/telemetry-owner.mjs',
      'const initializeSentryNodeRequestContext=()=>{};const initNodeTelemetry=async()=>{const unused=()=>{initializeSentryNodeRequestContext();new SentryContextManager()}};export {initNodeTelemetry as n};'
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must link its Node async-context owner'
    );
  });

  it('rejects a Node artifact that does not await telemetry initialization', () => {
    const root = fixture();
    createNodeArtifact(root);
    const entry = '.output/node/server/_ssr/ssr.mjs';
    const entryPath = path.join(root, entry);
    write(
      root,
      entry,
      fs
        .readFileSync(entryPath, 'utf8')
        .replace('await initNodeTelemetry()', 'initNodeTelemetry()')
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must await its imported Node telemetry initializer'
    );
  });

  it.each([
    [
      'node',
      createNodeArtifact,
      '.output/node/server/_ssr/ssr.mjs',
      'runWithNodeSentryRequestIsolation',
    ],
    [
      'vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
      'runWithVercelSentryRequestIsolation',
    ],
  ])(
    'rejects a %s artifact with isolation attached only to a dead call',
    (profile, createArtifact, entry, owner) => {
      const root = fixture();
      createArtifact(root);
      write(
        root,
        entry,
        `createApplicationServerEntry("${profile}");if(false){createApplicationServerEntry("${profile}",undefined,${owner})}`
      );

      expect(() => verifyRuntimeProfile(profile, root)).toThrow(
        `exactly one ${profile} profile marker`
      );
    }
  );

  it('rejects Worker identity drift and recursively leaked dev vars', () => {
    const identityRoot = fixture();
    createCloudflareArtifact(identityRoot);
    expect(() =>
      verifyRuntimeProfile('cloudflare', identityRoot, {
        expectedAppSlug: 'different-app',
      })
    ).toThrow('Cloudflare APP_SLUG identity');

    const devVarsRoot = fixture();
    createCloudflareArtifact(devVarsRoot);
    write(devVarsRoot, 'dist/server/nested/.dev.vars.preview', 'SECRET=x\n');
    expect(() =>
      verifyRuntimeProfile('cloudflare', devVarsRoot, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not contain .dev.vars');
  });

  it.each([[], 'nodejs_compatibility'])(
    'rejects malformed source AsyncLocalStorage compatibility flags: %j',
    (compatibilityFlags) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const sourceConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8')
      );
      writeJson(root, 'wrangler.json', {
        ...sourceConfig,
        compatibility_flags: compatibilityFlags,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare Sentry AsyncLocalStorage compatibility');
    }
  );

  it.each([[], 'nodejs_compatibility'])(
    'rejects malformed generated AsyncLocalStorage compatibility flags: %j',
    (compatibilityFlags) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const generatedConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
      );
      writeJson(root, 'dist/server/wrangler.json', {
        ...generatedConfig,
        compatibility_flags: compatibilityFlags,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare generated AsyncLocalStorage compatibility');
    }
  );

  it.each([undefined, 20260824, '2026/08/24'])(
    'rejects malformed source compatibility date: %j',
    (compatibilityDate) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const sourceConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8')
      );
      writeJson(root, 'wrangler.json', {
        ...sourceConfig,
        compatibility_date: compatibilityDate,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare source compatibility date format');
    }
  );

  it.each([undefined, 20260824, '2026/08/24'])(
    'rejects malformed generated compatibility date: %j',
    (compatibilityDate) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const generatedConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
      );
      writeJson(root, 'dist/server/wrangler.json', {
        ...generatedConfig,
        compatibility_date: compatibilityDate,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare generated compatibility date format');
    }
  );

  it('rejects generated compatibility date drift', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const generatedConfig = JSON.parse(
      fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
    );
    writeJson(root, 'dist/server/wrangler.json', {
      ...generatedConfig,
      compatibility_date: '2026-08-23',
    });
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare generated compatibility date drift');
  });

  it('rejects runtime-specific provider leakage recursively', () => {
    const cloudflareRoot = fixture();
    createCloudflareArtifact(cloudflareRoot);
    write(
      cloudflareRoot,
      'dist/server/assets/leaked.js',
      'const provider = new AsyncLocalStorageContextManager();'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', cloudflareRoot, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'forbidden cloudflare runtime token AsyncLocalStorageContextManager'
    );

    const localSqliteRoot = fixture();
    createCloudflareArtifact(localSqliteRoot);
    write(
      localSqliteRoot,
      'dist/server/assets/local-sqlite-sink.js',
      'const localSqliteEnabled = true; CREATE TABLE telemetry_summary;'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', localSqliteRoot, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('forbidden cloudflare runtime token telemetry_summary');

    const nodeRoot = fixture();
    createNodeArtifact(nodeRoot);
    write(
      nodeRoot,
      '.output/node/server/chunks/leaked.mjs',
      'import "@vercel/otel";'
    );
    expect(() => verifyRuntimeProfile('node', nodeRoot)).toThrow(
      'forbidden node runtime token @vercel/otel'
    );

    const vercelTraceRoot = fixture();
    createVercelArtifact(vercelTraceRoot);
    write(
      vercelTraceRoot,
      '.vercel/output/functions/__server.func/chunks/leaked.mjs',
      'initOpenTelemetryServer();'
    );
    expect(() => verifyRuntimeProfile('vercel', vercelTraceRoot)).toThrow(
      'forbidden vercel runtime token initOpenTelemetryServer'
    );

    const vercelSqliteRoot = fixture();
    createVercelArtifact(vercelSqliteRoot);
    write(
      vercelSqliteRoot,
      '.vercel/output/functions/__server.func/chunks/local-sqlite-sink.mjs',
      'CREATE TABLE telemetry_summary;'
    );
    expect(() => verifyRuntimeProfile('vercel', vercelSqliteRoot)).toThrow(
      'forbidden vercel runtime token telemetry_summary'
    );
  });

  it('rejects unknown profiles', () => {
    expect(() => verifyRuntimeProfile('auto', fixture())).toThrow(
      'unknown profile auto'
    );
  });
});
