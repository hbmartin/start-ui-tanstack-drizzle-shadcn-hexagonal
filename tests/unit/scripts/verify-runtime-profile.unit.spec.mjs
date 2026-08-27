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
const cloudflareRuntimeOwners =
  'var Sentry=await import("./assets/esm-fixture.js");' +
  'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import("./assets/sentry-request-fixture.js");' +
  'var {application,sentryRequestIsolationReady}=await initializeCloudflareSentryApplication(Sentry,async()=>{const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");return createApplicationServerEntry("cloudflare")});' +
  'var {tracing}=await import("cloudflare:workers");' +
  'var {createNoOpTelemetry,reportTelemetryFailure}=await import("./assets/telemetry-entry-fixture.js");' +
  'var {createCloudflareTelemetryAdapter}=await import("./assets/telemetry-adapter-fixture.js");' +
  'var {runWithCloudflareDatabase}=await import("./assets/database-request-fixture.js");' +
  'var {configureCloudflareRequestTelemetry}=await import("./assets/request-telemetry-fixture.js");' +
  'var {scheduleCloudflareRequestFlush}=await import("./assets/request-lifecycle-fixture.js");' +
  'var lastKnownNativeTelemetry=createNoOpTelemetry();' +
  cloudflareSentryOwner;
const cloudflareSentryOptionsDeclaration =
  'const {sentryOptions}=configureCloudflareRequestTelemetry({environment,nativeTelemetry,request,sentry:Sentry,sentryRequestIsolationReady});';
const cloudflareNativeTelemetrySetup =
  'let nativeTelemetry=lastKnownNativeTelemetry;try{nativeTelemetry=createCloudflareTelemetryAdapter({analytics:environment.START_UI_TELEMETRY_METRICS,tracing});lastKnownNativeTelemetry=nativeTelemetry}catch(failure){reportTelemetryFailure("otel.cloudflare.configure",failure)}';
const cloudflareRequestFlush =
  'scheduleCloudflareRequestFlush(request,(completion)=>context.waitUntil(completion));';

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
  writeJson(root, 'dist/server/.vite/manifest.json', {
    'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js':
      {
        file: 'assets/esm-fixture.js',
        isDynamicEntry: true,
        name: 'esm',
        src: 'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js',
      },
    'src/runtime/create-application-server-entry.ts': {
      file: 'assets/create-application-server-entry-fixture.js',
      isDynamicEntry: true,
      name: 'create-application-server-entry',
      src: 'src/runtime/create-application-server-entry.ts',
    },
    'src/platform/telemetry/index.ts': {
      file: 'assets/telemetry-entry-fixture.js',
      isDynamicEntry: true,
      name: 'telemetry',
      src: 'src/platform/telemetry/index.ts',
    },
    'src/runtime/cloudflare/database-request.ts': {
      file: 'assets/database-request-fixture.js',
      isDynamicEntry: true,
      name: 'database-request',
      src: 'src/runtime/cloudflare/database-request.ts',
    },
    'src/runtime/cloudflare/request-lifecycle.ts': {
      file: 'assets/request-lifecycle-fixture.js',
      isDynamicEntry: true,
      name: 'request-lifecycle',
      src: 'src/runtime/cloudflare/request-lifecycle.ts',
    },
    'src/runtime/cloudflare/request-telemetry.ts': {
      file: 'assets/request-telemetry-fixture.js',
      isDynamicEntry: true,
      name: 'request-telemetry',
      src: 'src/runtime/cloudflare/request-telemetry.ts',
    },
    'src/runtime/cloudflare/sentry-request.ts': {
      file: 'assets/sentry-request-fixture.js',
      isDynamicEntry: true,
      name: 'sentry-request',
      src: 'src/runtime/cloudflare/sentry-request.ts',
    },
    'src/runtime/cloudflare/telemetry-adapter.ts': {
      file: 'assets/telemetry-adapter-fixture.js',
      isDynamicEntry: true,
      name: 'telemetry-adapter',
      src: 'src/runtime/cloudflare/telemetry-adapter.ts',
    },
  });
  write(
    root,
    'dist/server/index.js',
    `${cloudflareRuntimeOwners}var worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{${cloudflareRequestFlush}}}};export{worker_entry_default as default};"cloudflare:workers";START_UI_TELEMETRY_METRICS`
  );
  write(
    root,
    'dist/server/assets/esm-fixture.js',
    'const setAsyncLocalStorageAsyncContextStrategy=()=>{};const withScope=(handle)=>handle();const wrapRequestHandler=(_options,handle)=>handle();export{setAsyncLocalStorageAsyncContextStrategy,withScope,wrapRequestHandler};'
  );
  write(
    root,
    'dist/server/assets/sentry-request-fixture.js',
    'import{reportTelemetryFailure}from"./telemetry-fixture.js";import{n as registerRequestCompletion,r as snapshotRequestCompletions}from"./request-completion-fixture.js";const sentrySentinelResponse=(applicationCompletion)=>new Response(new ReadableStream({start(controller){applicationCompletion.then(()=>controller.close(),()=>controller.close())}}),{headers:{"content-type":"text/plain; charset=utf-8"},status:200});const sentryLifecycleRequest=(request)=>{if(request.method!=="HEAD"&&request.method!=="OPTIONS")return request;return new Request(request.url,{headers:request.headers,method:"GET"})};const initializeCloudflareSentryIsolation=(api)=>{try{api.setAsyncLocalStorageAsyncContextStrategy();return true}catch(failure){reportTelemetryFailure("sentry.cloudflare.async_context",failure);return false}};const initializeCloudflareSentryApplication=async(api,loadApplication)=>{const sentryRequestIsolationReady=initializeCloudflareSentryIsolation(api);return{application:await loadApplication(),sentryRequestIsolationReady}};const runWithCloudflareSentry=async({api,handle,request,requestOptions})=>{let applicationOutcome;let applicationWork;const runApplicationOnce=()=>{applicationWork??=Promise.resolve().then(async()=>{try{return{response:await handle(),type:"responded"}}catch(failure){return{failure,type:"failed"}}});return applicationWork};try{const sentryResponse=await api.withScope(()=>api.wrapRequestHandler({...requestOptions,request:sentryLifecycleRequest(request)},async()=>{applicationOutcome=await runApplicationOnce();if(applicationOutcome.type==="failed")throw applicationOutcome.failure;return sentrySentinelResponse(Promise.allSettled(snapshotRequestCompletions(request)))}));if(sentryResponse.body){const sentryCompletion=sentryResponse.arrayBuffer().then(()=>void 0).catch((failure)=>{reportTelemetryFailure("sentry.cloudflare.request_stream",failure)});registerRequestCompletion(request,sentryCompletion)}}catch(failure){if(applicationOutcome?.type==="failed")throw applicationOutcome.failure;reportTelemetryFailure("sentry.cloudflare.request",failure)}if(applicationOutcome?.type==="responded")return applicationOutcome.response;if(applicationOutcome?.type==="failed")throw applicationOutcome.failure;reportTelemetryFailure("sentry.cloudflare.request",new Error("Sentry request wrapper skipped application handler"));applicationOutcome=await runApplicationOnce();if(applicationOutcome.type==="failed")throw applicationOutcome.failure;return applicationOutcome.response};export{initializeCloudflareSentryApplication,runWithCloudflareSentry};'
  );
  write(
    root,
    'dist/server/assets/database-request-fixture.js',
    'import{createHyperdriveDbClient,runWithRuntimeDatabaseClient}from"./client-fixture.js";import{validateServerConfig}from"./backend-fixture.js";import{reportTelemetryFailure}from"./telemetry-fixture.js";const closeDatabase=async(database)=>{try{await database.$close()}catch(failure){reportTelemetryFailure("database.cloudflare.close",failure)}};const captureDatabaseConnectionFailure=()=>{};const bindCloudflareDatabaseToResponse=({database,request,response})=>{if(!response.body){closeDatabase(database);return response}if(response.bodyUsed||response.body.locked)throw new TypeError("locked");const{readable,writable}=new TransformStream();response.body.pipeTo(writable,{signal:request.signal}).catch(()=>void 0).then(()=>closeDatabase(database));return new Response(readable,response)};const runWithCloudflareDatabase=async({binding,handle,request})=>{let database;try{database=await createHyperdriveDbClient(binding)}catch(failure){captureDatabaseConnectionFailure(failure);throw failure}return runWithRuntimeDatabaseClient(database,async()=>{try{validateServerConfig("cloudflare",{databaseAdapter:database.$adapter});const response=await handle();return bindCloudflareDatabaseToResponse({database,request,response})}catch(failure){await closeDatabase(database);throw failure}})};export{runWithCloudflareDatabase};'
  );
  write(
    root,
    'dist/server/assets/request-telemetry-fixture.js',
    'import{reportTelemetryFailure,setTelemetry}from"./telemetry-fixture.js";const createCloudflareSentryOptions=()=>({});const createSentryTelemetryAdapter=()=>({});const createTelemetryAdapterChain=()=>({});const configureCloudflareRequestTelemetry=({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>{setTelemetry(nativeTelemetry);if(!environment.SENTRY_DSN||!sentryRequestIsolationReady){return{}}try{const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});setTelemetry(createTelemetryAdapterChain([nativeTelemetry,sentryTelemetry]));return{sentryOptions}}catch(failure){reportTelemetryFailure("sentry.cloudflare.configure",failure);return{}}};export{configureCloudflareRequestTelemetry};'
  );
  write(
    root,
    'dist/server/assets/request-lifecycle-fixture.js',
    'import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";import{getTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";const scheduleCloudflareRequestFlush=(request,waitUntil)=>{const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0);try{waitUntil(flush)}catch(failure){reportTelemetryFailure("otel.cloudflare.wait_until",failure)}};export{scheduleCloudflareRequestFlush};'
  );
  write(
    root,
    'dist/server/assets/telemetry-entry-fixture.js',
    'import{createNoOpTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";export{createNoOpTelemetry,reportTelemetryFailure};'
  );
  write(
    root,
    'dist/server/assets/telemetry-adapter-fixture.js',
    'const createCloudflareTelemetryAdapter=()=>({});export{createCloudflareTelemetryAdapter};'
  );
  write(
    root,
    'dist/server/assets/create-application-server-entry-fixture.js',
    'const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>{const{telemetryProxy}=await import("./telemetry-fixture.js");const tanstack=await import("./entry-server-fixture.js");return tanstack.createServerEntry({async fetch(request){const handleRequest=async()=>{const telemetryCaptureState=createRequestExceptionCaptureState();bindRequestExceptionState(request,telemetryCaptureState);const context={requestId:crypto.randomUUID(),runtimeProfile,telemetryCaptureState};try{return await tanstack.default.fetch(request,{context})}catch(error){if(isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error))telemetryProxy.captureException(error,{});throw error}finally{try{lifecycle?.onRequestSettled(request)}catch{}}};if(!requestScope)return handleRequest();let applicationResult;const runApplicationOnce=()=>{applicationResult??=handleRequest();return applicationResult};try{return requestScope(runApplicationOnce)}catch(failure){reportTelemetryFailure("sentry.request_scope",failure);return applicationResult??runApplicationOnce()}}})};export{createApplicationServerEntry};'
  );
  write(
    root,
    'dist/server/assets/entry-server-fixture.js',
    'const createServerEntry=(entry)=>entry;const application={fetch:()=>new Response()};export{createServerEntry,application as default};'
  );
  write(
    root,
    'dist/server/assets/client-fixture.js',
    'const createHyperdriveDbClient=()=>({});const runWithRuntimeDatabaseClient=(_database,handle)=>handle();export{createHyperdriveDbClient,runWithRuntimeDatabaseClient};'
  );
  write(
    root,
    'dist/server/assets/backend-fixture.js',
    'const validateServerConfig=()=>{};export{validateServerConfig};'
  );
  write(
    root,
    'dist/server/assets/request-completion-fixture.js',
    'const forceFlushRequestTelemetry=()=>Promise.resolve();const registerRequestCompletion=()=>{};const snapshotRequestCompletions=()=>[];export{forceFlushRequestTelemetry,registerRequestCompletion as n,snapshotRequestCompletions as r};'
  );
  write(
    root,
    'dist/server/assets/telemetry-fixture.js',
    'const createNoOpTelemetry=()=>({});const getTelemetry=()=>({});const reportTelemetryFailure=()=>{};const setTelemetry=()=>{};const telemetryProxy={};export{createNoOpTelemetry,getTelemetry,reportTelemetryFailure,setTelemetry,telemetryProxy};'
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

  it('accepts merged Sentry request-state declarations', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'let applicationOutcome;let applicationWork;',
          'let applicationOutcome,applicationWork;'
        )
    );

    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  });

  it('accepts merged request-telemetry adapter declarations', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-telemetry-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});',
          'const sentryOptions=createCloudflareSentryOptions(sentry,request,environment),sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});'
        )
    );

    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  });

  it('rejects an expression-bodied Sentry request owner cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const runWithCloudflareSentry=.*?;export\{initializeCloudflareSentryApplication/u,
          'const runWithCloudflareSentry=async({api,handle,request,requestOptions})=>(Error,Promise,Response,api.withScope,api.wrapRequestHandler,handle());export{initializeCloudflareSentryApplication'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded request body');
  });

  it.each([
    [
      'database response owner',
      'dist/server/assets/database-request-fixture.js',
      '({database,request,response})=>',
      '({database,request,response},leak=exfiltrate(request,response))=>',
      'database response owner must accept exact active inputs',
    ],
    [
      'request telemetry owner',
      'dist/server/assets/request-telemetry-fixture.js',
      '({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>',
      '({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady},leak=exfiltrate(request))=>',
      'request telemetry owner must accept exact active inputs',
    ],
    [
      'Sentry request owner',
      'dist/server/assets/sentry-request-fixture.js',
      'async({api,handle,request,requestOptions})=>',
      'async({api,handle,request,requestOptions},leak=exfiltrate(request))=>',
      'Sentry request owner must accept exact active request inputs',
    ],
    [
      'application execution owner',
      'dist/server/assets/sentry-request-fixture.js',
      'const runApplicationOnce=()=>',
      'const runApplicationOnce=(leak=exfiltrate(request))=>',
      'Sentry request runner must own one parameterless execution body',
    ],
  ])(
    'rejects a side-effecting extra parameter on the %s',
    (_label, relativePath, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    [
      'request telemetry owner',
      'dist/server/assets/request-telemetry-fixture.js',
      /const configureCloudflareRequestTelemetry=.*?;export\{configureCloudflareRequestTelemetry/u,
      'const configureCloudflareRequestTelemetry=({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>(setTelemetry(nativeTelemetry),createCloudflareSentryOptions(sentry,request,environment),{});export{configureCloudflareRequestTelemetry',
      'request telemetry owner must own its configuration body',
    ],
    [
      'Sentry application owner',
      'dist/server/assets/sentry-request-fixture.js',
      /const initializeCloudflareSentryApplication=.*?;const runWithCloudflareSentry/u,
      'const initializeCloudflareSentryApplication=async(api,loadApplication)=>initializeCloudflareSentryIsolation(api);const runWithCloudflareSentry',
      'Sentry application owner must own its initialization body',
    ],
    [
      'application runner',
      'dist/server/assets/sentry-request-fixture.js',
      /const runApplicationOnce=.*?;try\{/u,
      'const runApplicationOnce=()=>(Promise,applicationWork);try{',
      'Sentry request runner must own one parameterless execution body',
    ],
  ])(
    'rejects an expression-bodied %s cleanly',
    (_label, relativePath, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    [
      'a duplicate fetch property',
      (source) =>
        source.replace(
          '}};export{worker_entry_default as default};',
          '},fetch:()=>new Response("bypassed")};export{worker_entry_default as default};'
        ),
      'must not contain duplicate properties',
    ],
    [
      'a spread fetch override',
      (source) =>
        source.replace(
          '}};export{worker_entry_default as default};',
          '},...{fetch:()=>new Response("bypassed")}};export{worker_entry_default as default};'
        ),
      'must not contain spread properties',
    ],
    [
      'a later Worker owner redeclaration',
      (source) =>
        source.replace(
          ';export{worker_entry_default as default};',
          ';var worker_entry_default={fetch:()=>new Response("bypassed")};export{worker_entry_default as default};'
        ),
      'must export one default Worker object',
    ],
    [
      'a later Worker object assignment',
      (source) =>
        source.replace(
          ';export{worker_entry_default as default};',
          ';worker_entry_default={fetch:()=>new Response("bypassed")};export{worker_entry_default as default};'
        ),
      'must not mutate or alias the default Worker object',
    ],
    [
      'a call-based Worker fetch mutation',
      (source) =>
        source.replace(
          ';export{worker_entry_default as default};',
          ';Object.assign(worker_entry_default,{fetch:()=>new Response("bypassed")});export{worker_entry_default as default};'
        ),
      'must not mutate or alias the default Worker object',
    ],
    [
      'a re-exported default Worker decoy',
      (source) =>
        source.replace(
          'export{worker_entry_default as default};',
          'export{worker_entry_default as default}from"./assets/evil.js";'
        ),
      'must export one default Worker object',
    ],
  ])('rejects %s with last-write semantics', (_label, mutate, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      mutate(fs.readFileSync(entryPath, 'utf8'))
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it.each([
    [
      'Sentry SDK',
      'var Sentry=await import',
      'var Sentry=import',
      'must await the trusted Sentry SDK import',
    ],
    [
      'Sentry request owners',
      'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import',
      'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=import',
      'must await trusted owner initializeCloudflareSentryApplication import',
    ],
    [
      'database owner',
      'var {runWithCloudflareDatabase}=await import',
      'var {runWithCloudflareDatabase}=import',
      'must await trusted owner runWithCloudflareDatabase import',
    ],
    [
      'request telemetry owner',
      'var {configureCloudflareRequestTelemetry}=await import',
      'var {configureCloudflareRequestTelemetry}=import',
      'must await trusted owner configureCloudflareRequestTelemetry import',
    ],
    [
      'request lifecycle owner',
      'var {scheduleCloudflareRequestFlush}=await import',
      'var {scheduleCloudflareRequestFlush}=import',
      'must await trusted owner scheduleCloudflareRequestFlush import',
    ],
    [
      'application factory',
      'const {createApplicationServerEntry}=await import',
      'const {createApplicationServerEntry}=import',
      'must await the application server-entry import',
    ],
  ])('rejects an unawaited %s import', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs.readFileSync(entryPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it('rejects an unawaited outer Cloudflare request owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'return await fetchCloudflareApplication(',
          'return fetchCloudflareApplication('
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await its Sentry-owned response before flushing');
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
      `${cloudflareRuntimeOwners}const worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.MISSING_DATABASE,handle:handleApplication,request});try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{${cloudflareRequestFlush}}}};export{worker_entry_default as default};"cloudflare:workers";"START_UI_DATABASE";START_UI_TELEMETRY_METRICS`
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
      `${cloudflareRuntimeOwners}function neverCalled(environment,handle,request){return runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle,request})}const worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}return new Response()}};export{worker_entry_default as default};"cloudflare:workers";START_UI_DATABASE;START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must use trusted owner application exactly once');
  });

  it('rejects an unreachable Hyperdrive client assignment', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'try{database=await createHyperdriveDbClient(binding)}',
          'try{if(false){database=await createHyperdriveDbClient(binding)}}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must perform one direct client assignment');
  });

  it('rejects a database declaration that substitutes an active input', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'let database;try{',
          'let database,pwn=(handle=async()=>({body:null}));try{'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must declare one request-local database client');
  });

  it('rejects a decoy database response lifetime binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'return bindCloudflareDatabaseToResponse({database,request,response})',
          'if(false)bindCloudflareDatabaseToResponse({database,request,response});return response'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must validate, handle, and bind one response');
  });

  it('rejects an unawaited Hyperdrive client', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'database=await createHyperdriveDbClient(binding)',
          'database=createHyperdriveDbClient(binding)'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await its Hyperdrive client');
  });

  it('rejects an unawaited database application response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('const response=await handle()', 'const response=handle()')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await the active application handler');
  });

  it('rejects a database connection failure converted to a response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'captureDatabaseConnectionFailure(failure);throw failure',
          'return new Response("bypassed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve connection failures');
  });

  it('rejects a scoped database failure converted to a response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'await closeDatabase(database);throw failure',
          'return new Response("bypassed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve scoped request failures');
  });

  it('rejects substituted database helper imports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{createHyperdriveDbClient,runWithRuntimeDatabaseClient}from"./client-fixture.js";',
          'import{createHyperdriveDbClient as realCreateHyperdriveDbClient,runWithRuntimeDatabaseClient}from"./client-fixture.js";const createHyperdriveDbClient=()=>({});'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted helper createHyperdriveDbClient exactly once'
    );
  });

  it('rejects a no-op database close owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const closeDatabase=.*?;const captureDatabaseConnectionFailure=/u,
          'const closeDatabase=async()=>{};const captureDatabaseConnectionFailure='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('database close owner must accept one active client');
  });

  it('rejects an identity database response binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const bindCloudflareDatabaseToResponse=.*?;const runWithCloudflareDatabase=/u,
          'const bindCloudflareDatabaseToResponse=({database,request,response})=>response;const runWithCloudflareDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('database response owner must own its stream lifecycle body');
  });

  it.each(['closeDatabase', 'bindCloudflareDatabaseToResponse'])(
    'rejects a later %s redeclaration',
    (owner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(
        root,
        'dist/server/assets/database-request-fixture.js'
      );
      write(
        root,
        'dist/server/assets/database-request-fixture.js',
        fs
          .readFileSync(chunkPath, 'utf8')
          .replace(`const ${owner}=`, `var ${owner}=`)
          .replace(
            ';const runWithCloudflareDatabase=',
            `;var ${owner}=()=>{};const runWithCloudflareDatabase=`
          )
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`must define trusted helper ${owner} exactly once`);
    }
  );

  it('rejects a shadowed response-stream built-in', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';const runWithCloudflareDatabase=',
          ';const TransformStream=class{constructor(){throw new Error("bypassed")}};const runWithCloudflareDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted TransformStream built-in');
  });

  it.each([
    ['a default import', 'import Response from"./evil.js";', 'Response'],
    [
      'a namespace import',
      'import*as TransformStream from"./evil.js";',
      'TransformStream',
    ],
  ])('rejects %s built-in shadowing', (_label, declaration, builtIn) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      `${declaration}${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must use the trusted ${builtIn} built-in`);
  });

  it.each(['globalThis', 'self'])(
    'rejects %s built-in mutation in the database owner chunk',
    (globalAlias) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(
        root,
        'dist/server/assets/database-request-fixture.js'
      );
      write(
        root,
        'dist/server/assets/database-request-fixture.js',
        `${globalAlias}.Response=class{};${fs.readFileSync(chunkPath, 'utf8')}`
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must not access alternate global built-ins');
    }
  );

  it('rejects call-based poisoning of a database stream built-in', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      `Object.assign(Response.prototype,{body:null});${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted Response built-in');
  });

  it.each([
    [
      'then',
      '.then(()=>closeDatabase(database))',
      '[then](()=>closeDatabase(database))',
      'must close after stream completion',
    ],
    [
      'catch',
      '.catch(()=>void 0)',
      '["catch"](()=>void 0)',
      'must isolate producer termination',
    ],
    [
      'pipeTo',
      '.pipeTo(writable,{signal:request.signal})',
      '[pipeTo](writable,{signal:request.signal})',
      'must pipe the active body',
    ],
  ])(
    'rejects a computed database pipeline %s member',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(
        root,
        'dist/server/assets/database-request-fixture.js'
      );
      write(
        root,
        'dist/server/assets/database-request-fixture.js',
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it('rejects a Cloudflare database owner after an unwrapped response path', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/index.js',
      `${cloudflareRuntimeOwners}const worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});if(true)return new Response();try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{${cloudflareRequestFlush}}}};export{worker_entry_default as default};"cloudflare:workers";START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must have exactly one Sentry-owned return path');
  });

  it('rejects request-body consumption before the owned request path', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try{',
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});void request.arrayBuffer();try{'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only its bounded runtime ownership sequence');
  });

  it.each([
    [
      'native telemetry declaration',
      'let nativeTelemetry=lastKnownNativeTelemetry;',
      'let nativeTelemetry=lastKnownNativeTelemetry,pwn=request.arrayBuffer();',
    ],
    [
      'application handler declaration',
      'const handleApplication=()=>application.fetch(request,{context:void 0});',
      'const handleApplication=()=>application.fetch(request,{context:void 0}),pwn=request.arrayBuffer();',
    ],
  ])('rejects side-effect work in the %s', (_label, search, replacement) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs.readFileSync(entryPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only its bounded runtime ownership sequence');
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
          'const handleApplication=()=>application.fetch(request,{context:void 0})',
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
        `${cloudflareSentryOwner}var worker_entry_default`,
        `${cloudflareSentryOwner}const bindingKey="binding";var worker_entry_default`
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
          'const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=',
          'var handleApplication=()=>application.fetch(request,{context:void 0});var handleApplication=()=>new Response("bypassed");const handleDatabase='
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
          'const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=',
          'var handleApplication=()=>application.fetch(request,{context:void 0});var {replacement:handleApplication}={replacement:()=>new Response("bypassed")};const handleDatabase='
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
          'const handleApplication=()=>application.fetch(request,{context:void 0});',
          'const handleApplication=(request=new Request("https://bypassed.test"))=>application.fetch(request,{context:void 0});'
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
            cloudflareSentryOptionsDeclaration,
            `${redeclaration}${cloudflareSentryOptionsDeclaration}`
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
          'const handleApplication=()=>application.fetch(request,{context:void 0});',
          'try{throw new Request("https://bypassed.test")}catch(request){var handleApplication=()=>application.fetch(request,{context:void 0})}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not override active parameter request');
  });

  it('rejects a destructured catch parameter captured by an application callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0});',
          'try{throw {request:new Request("https://bypassed.test")}}catch({request}){var handleApplication=()=>application.fetch(request,{context:void 0})}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not override active parameter request');
  });

  it('rejects an active callback captured from a catch binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});',
          'try{throw ()=>new Response("bypassed")}catch(handleApplication){var handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request})}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not shadow active binding handleApplication');
  });

  it('allows a nested-function-local catch parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'var worker_entry_default=',
          'const unrelated=()=>{try{throw 1}catch(request){return request}};var worker_entry_default='
        )
    );

    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  });

  it('rejects redeclared validated Sentry options', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          'var {sentryOptions}=configureCloudflareRequestTelemetry({environment,nativeTelemetry,request,sentry:Sentry,sentryRequestIsolationReady});var {sentryOptions}={sentryOptions:void 0};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must declare validated Sentry options exactly once'
    );
  });

  it('rejects Sentry options not initialized by request telemetry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          'const {sentryOptions}=bypassTelemetry();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must initialize validated Sentry options from request telemetry'
    );
  });

  it('rejects an unreachable validated Sentry options declaration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `if(false){var ${cloudflareSentryOptionsDeclaration.slice('const '.length)}}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must declare validated Sentry options directly');
  });

  it('rejects mutable validated Sentry options', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          cloudflareSentryOptionsDeclaration.replace('const ', 'let ')
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must keep validated Sentry options immutable');
  });

  it('rejects missing request telemetry configuration inputs', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          'const {sentryOptions}=configureCloudflareRequestTelemetry();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must pass one validated request telemetry input');
  });

  it('rejects disabled request isolation passed to telemetry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'sentryRequestIsolationReady});',
          'sentryRequestIsolationReady:false});'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Cloudflare request telemetry configurator must receive validated request isolation readiness'
    );
  });

  it('rejects a fetch-local request telemetry configurator', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `const configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0});${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must not override trusted owner configureCloudflareRequestTelemetry'
    );
  });

  it('rejects a request telemetry configurator from an untrusted chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace('request-telemetry-fixture.js', 'telemetry-bypass.js')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must initialize trusted owner configureCloudflareRequestTelemetry from its runtime owner'
    );
  });

  it('rejects a missing request telemetry owner chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace('request-telemetry-fixture.js', 'request-telemetry-missing.js')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('request-telemetry-missing.js');
  });

  it('rejects an aliased request telemetry configurator import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{configureCloudflareRequestTelemetry}=await import',
          '{bypass:configureCloudflareRequestTelemetry}=await import'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner configureCloudflareRequestTelemetry by exact shorthand'
    );
  });

  it('rejects a request telemetry configurator re-export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'export{configureCloudflareRequestTelemetry}from"./bypass.js";'
    );
    write(
      root,
      'dist/server/assets/bypass.js',
      'const configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0});export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must export trusted owner configureCloudflareRequestTelemetry from one local binding'
    );
  });

  it('rejects a reassigned request telemetry configurator export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'let configureCloudflareRequestTelemetry=()=>({sentryOptions:{}});configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0});export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must not mutate trusted owner configureCloudflareRequestTelemetry'
    );
  });

  it('rejects a block-level request telemetry configurator reinitialization', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'var configureCloudflareRequestTelemetry=()=>({sentryOptions:{}});{var configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0})}export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must define trusted owner configureCloudflareRequestTelemetry as one local function'
    );
  });

  it('rejects an unreachable request telemetry configurator declaration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'if(false){var configureCloudflareRequestTelemetry=()=>({})}export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must define trusted owner configureCloudflareRequestTelemetry as one local function'
    );
  });

  it('rejects a request telemetry owner without Sentry configuration behavior', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'const configureCloudflareRequestTelemetry=()=>({});export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'trusted owner configureCloudflareRequestTelemetry must call createCloudflareSentryOptions'
    );
  });

  it('rejects unreachable request telemetry configuration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'import{reportTelemetryFailure,setTelemetry}from"./telemetry-fixture.js";const createCloudflareSentryOptions=()=>({});const createSentryTelemetryAdapter=()=>({});const createTelemetryAdapterChain=()=>({});const configureCloudflareRequestTelemetry=({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>{setTelemetry(nativeTelemetry);if(!environment.SENTRY_DSN||!sentryRequestIsolationReady)return{};try{if(false){const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});setTelemetry(createTelemetryAdapterChain([nativeTelemetry,sentryTelemetry]))}return{sentryOptions:void 0};return{};return{}}catch(failure){reportTelemetryFailure("sentry.cloudflare.configure",failure);return{}}};export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must create one Sentry options value');
  });

  it('rejects substituted request telemetry helper imports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-telemetry-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{reportTelemetryFailure,setTelemetry}from"./telemetry-fixture.js";',
          'import{reportTelemetryFailure,setTelemetry as realSetTelemetry}from"./telemetry-fixture.js";const setTelemetry=()=>{};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import trusted helper setTelemetry exactly once');
  });

  it('rejects an aliased Cloudflare Sentry request owner import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import',
          '{initializeCloudflareSentryApplication,bypass:runWithCloudflareSentry}=await import'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner initializeCloudflareSentryApplication by exact shorthand'
    );
  });

  it('rejects an aliased Cloudflare database owner import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{runWithCloudflareDatabase}=await import',
          '{bypass:runWithCloudflareDatabase}=await import'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner runWithCloudflareDatabase by exact shorthand'
    );
  });

  it('rejects a Sentry SDK chunk missing request-wrapper exports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/esm-fixture.js',
      'const setAsyncLocalStorageAsyncContextStrategy=()=>{};const withScope=(handle)=>handle();export{setAsyncLocalStorageAsyncContextStrategy,withScope};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must export required Sentry SDK owner wrapRequestHandler');
  });

  it('rejects a Sentry SDK chunk without package provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sentryEntry = Object.values(manifest).find(
      (entry) => entry.file === 'assets/esm-fixture.js'
    );
    sentryEntry.src = 'src/vendor/sentry.js';
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must originate from @sentry/cloudflare');
  });

  it.each([
    [
      'telemetry entry',
      'assets/telemetry-entry-fixture.js',
      'src/platform/telemetry/index.ts',
    ],
    [
      'native telemetry adapter',
      'assets/telemetry-adapter-fixture.js',
      'src/runtime/cloudflare/telemetry-adapter.ts',
    ],
    [
      'database request owner',
      'assets/database-request-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
    ],
    [
      'request lifecycle owner',
      'assets/request-lifecycle-fixture.js',
      'src/runtime/cloudflare/request-lifecycle.ts',
    ],
    [
      'request telemetry owner',
      'assets/request-telemetry-fixture.js',
      'src/runtime/cloudflare/request-telemetry.ts',
    ],
    [
      'Sentry request owner',
      'assets/sentry-request-fixture.js',
      'src/runtime/cloudflare/sentry-request.ts',
    ],
  ])('rejects forged %s provenance', (_label, file, expectedSource) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const ownerEntry = Object.values(manifest).find(
      (entry) => entry.file === file
    );
    ownerEntry.src = 'src/runtime/cloudflare/forged.ts';
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must originate from ${expectedSource}`);
  });

  it.each([
    ['telemetry entry', 'assets/telemetry-entry-fixture.js'],
    ['native telemetry adapter', 'assets/telemetry-adapter-fixture.js'],
  ])('rejects a missing %s chunk', (_label, file) => {
    const root = fixture();
    createCloudflareArtifact(root);
    fs.rmSync(path.join(root, 'dist/server', file));

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(file);
  });

  it('rejects a telemetry entry that exports a substituted helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/telemetry-entry-fixture.js',
      'import{createNoOpTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";const bypass=()=>({captureException:()=>{}});export{bypass as createNoOpTelemetry,reportTelemetryFailure};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must re-export trusted helper createNoOpTelemetry directly');
  });

  it('rejects a native telemetry adapter exported from a bypass owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/telemetry-adapter-fixture.js',
      'const createCloudflareTelemetryAdapter=()=>({});const bypass=()=>({});export{bypass as createCloudflareTelemetryAdapter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must export trusted owner createCloudflareTelemetryAdapter from one local binding'
    );
  });

  it('rejects duplicate same-name Sentry SDK owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/esm-fixture.js',
      'var setAsyncLocalStorageAsyncContextStrategy=()=>{};var withScope=(handle)=>handle();var withScope=()=>new Response("bypassed");var wrapRequestHandler=(_options,handle)=>handle();export{setAsyncLocalStorageAsyncContextStrategy,withScope,wrapRequestHandler};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must define required Sentry SDK owner withScope exactly once');
  });

  it('rejects Sentry SDK exports aliased to a bypass function', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/esm-fixture.js',
      'const setAsyncLocalStorageAsyncContextStrategy=()=>{};const bypass=()=>{};export{setAsyncLocalStorageAsyncContextStrategy,bypass as withScope,bypass as wrapRequestHandler};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must export required Sentry SDK owner withScope');
  });

  it('rejects a Cloudflare application initialized without the Sentry SDK', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'initializeCloudflareSentryApplication(Sentry,async()',
          'initializeCloudflareSentryApplication(undefined,async()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must initialize request isolation with the active Sentry API');
  });

  it('rejects a Cloudflare application loader that discards its application', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'return createApplicationServerEntry("cloudflare")',
          'createApplicationServerEntry("cloudflare")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must return its isolated Cloudflare application');
  });

  it('rejects an application factory imported after its use', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const importFactory =
      'const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");';
    const returnApplication =
      'return createApplicationServerEntry("cloudflare")';
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          importFactory + returnApplication,
          returnApplication + ';' + importFactory
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import createApplicationServerEntry before using it');
  });

  it('rejects unawaited outer application isolation initialization', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '=await initializeCloudflareSentryApplication(',
          '=initializeCloudflareSentryApplication('
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await application request isolation initialization');
  });

  it('rejects local substitution of the application server-entry factory', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        '{createApplicationServerEntry}=await import',
        '{createApplicationServerEntry:realCreateApplicationServerEntry}=await import'
      )
      .replace(
        'return createApplicationServerEntry("cloudflare")',
        'const createApplicationServerEntry=()=>({fetch:()=>new Response("bypassed")});return createApplicationServerEntry("cloudflare")'
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import createApplicationServerEntry by exact shorthand');
  });

  it('rejects a forged universal application server-entry chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/create-application-server-entry-fixture.js',
      'const createApplicationServerEntry=()=>({fetch:()=>new Response("bypassed")});export{createApplicationServerEntry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('universal application server entry must be async');
  });

  it('rejects an unawaited Cloudflare application load', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'application:await loadApplication()',
          'application:loadApplication()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await its active application loader');
  });

  it('rejects an unreachable Sentry application execution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'response:await handle()',
          'response:(false?await handle():new Response("bypassed"))'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await the active application handler');
  });

  it('rejects a Sentry runner that converts application failure to success', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'return{failure,type:"failed"}',
          'return{response:new Response("bypassed"),type:"responded"}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must return the active application failure');
  });

  it('rejects an injected early return after the Sentry request scope', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'if(applicationOutcome?.type==="responded")',
          'if(request.headers.get("x-bypass"))return new Response("bypassed");if(applicationOutcome?.type==="responded")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must have one bounded post-SDK path');
  });

  it('rejects an injected early return inside the Sentry request scope', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';if(sentryResponse.body)',
          ';if(request.headers.get("x-bypass"))return new Response("bypassed");if(sentryResponse.body)'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must execute one bounded SDK request scope');
  });

  it('rejects a conditional Sentry request-scope initializer', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const sentryResponse=await api.withScope(',
          'const sentryResponse=request.headers.get("x-bypass")?new Response("bypassed"):await api.withScope('
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must enter SDK isolation directly');
  });

  it('rejects extra Sentry request-wrapper options', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          '{...requestOptions,request:sentryLifecycleRequest(request)}',
          '{...requestOptions,captureErrors:true,request:sentryLifecycleRequest(request)}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must pass exact active request options');
  });

  it('rejects a side-effecting Sentry request-handler parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'async()=>{applicationOutcome=await runApplicationOnce()',
          'async(leak=exfiltrate(request))=>{applicationOutcome=await runApplicationOnce()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded application body');
  });

  it('rejects a second application outcome inside the Sentry wrapper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';if(applicationOutcome.type==="failed")',
          ';applicationOutcome={response:new Response("bypassed"),type:"responded"};if(applicationOutcome.type==="failed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded application body');
  });

  it('rejects a finalizer that overrides the Sentry application outcome', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'catch(failure){return{failure,type:"failed"}}});',
          'catch(failure){return{failure,type:"failed"}}finally{return undefined}});'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must return one application outcome');
  });

  it('rejects duplicate Sentry isolation owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const initializeCloudflareSentryIsolation=',
          'var initializeCloudflareSentryIsolation='
        )
        .replace(
          'export{initializeCloudflareSentryApplication',
          'var initializeCloudflareSentryIsolation=()=>false;export{initializeCloudflareSentryApplication'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must define trusted helper initializeCloudflareSentryIsolation exactly once'
    );
  });

  it('rejects a fake Promise owner that skips Sentry application execution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'Promise.resolve().then(async()',
          '({then:(_callback)=>Promise.resolve({response:new Response("bypassed"),type:"responded"})}).then(async()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted Promise owner');
  });

  it.each([
    ['a default import', 'import Promise from"./evil.js";', 'Promise'],
    [
      'call-based poisoning',
      'Object.assign(Promise,{resolve:()=>({then:()=>Promise.resolve()})});',
      'Promise',
    ],
  ])('rejects %s of a Sentry built-in', (_label, injection, builtIn) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      `${injection}${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must use the trusted ${builtIn} built-in`);
  });

  it('rejects alternate-global mutation of a Sentry built-in', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      `self.Promise=class{};${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not access alternate global built-ins');
  });

  it('rejects a substituted Sentry lifecycle request helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const sentryLifecycleRequest=.*?;const initializeCloudflareSentryIsolation/u,
          'const sentryLifecycleRequest=(request)=>(Request,request);const initializeCloudflareSentryIsolation'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must bound request normalization');
  });

  it('rejects a substituted Sentry sentinel helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const sentrySentinelResponse=.*?;const sentryLifecycleRequest/u,
          'const sentrySentinelResponse=(applicationCompletion)=>(ReadableStream,new Response());const sentryLifecycleRequest'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must create one bounded streaming response');
  });

  it('rejects a generator Sentry sentinel stream callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('{start(controller){', '{*start(controller){')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own one stream start callback');
  });

  it.each([
    ['registerRequestCompletion', 'n', '{}'],
    ['snapshotRequestCompletions', 'r', '[]'],
  ])('rejects a substituted %s import', (helper, importedName, fallback) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    const importEntry = `${importedName} as ${helper}`;
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(importEntry, `${importedName} as real${helper}`)
        .replace(
          ';const sentrySentinelResponse=',
          `;const ${helper}=()=>${fallback};const sentrySentinelResponse=`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must import trusted helper ${helper} exactly once`);
  });

  it('rejects a substituted Sentry telemetry reporter import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{reportTelemetryFailure}from"./telemetry-fixture.js";',
          'import{reportTelemetryFailure as realReportTelemetryFailure}from"./telemetry-fixture.js";const reportTelemetryFailure=()=>{};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import trusted helper reportTelemetryFailure exactly once');
  });

  it.each([
    [
      'async Sentry isolation owner',
      'const initializeCloudflareSentryIsolation=(api)=>',
      'const initializeCloudflareSentryIsolation=async(api)=>',
      'must define Sentry async-context isolation',
    ],
    [
      'async lifecycle request owner',
      'const sentryLifecycleRequest=(request)=>',
      'const sentryLifecycleRequest=async(request)=>',
      'must bound request normalization',
    ],
    [
      'generator application owner',
      'const initializeCloudflareSentryApplication=async(api,loadApplication)=>',
      'const initializeCloudflareSentryApplication=async function*(api,loadApplication)',
      'must accept exact initialization inputs',
    ],
    [
      'generator Sentry request owner',
      'const runWithCloudflareSentry=async({api,handle,request,requestOptions})=>',
      'const runWithCloudflareSentry=async function*({api,handle,request,requestOptions})',
      'must accept exact active request inputs',
    ],
  ])('rejects an %s', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it.each([
    [
      'non-function sentinel start callback',
      '{start(controller){applicationCompletion.then(()=>controller.close(),()=>controller.close())}}',
      '{start:0}',
      'must own one stream start callback',
    ],
    [
      'non-function sentinel settlement callback',
      'applicationCompletion.then(()=>controller.close(),()=>controller.close())',
      'applicationCompletion.then(null,()=>controller.close())',
      'must close its stream on completion',
    ],
    [
      'expression-bodied Sentry request wrapper',
      'async()=>{applicationOutcome=await runApplicationOnce();if(applicationOutcome.type==="failed")throw applicationOutcome.failure;return sentrySentinelResponse(Promise.allSettled(snapshotRequestCompletions(request)))}',
      'async()=>runApplicationOnce()',
      'must own its bounded application body',
    ],
    [
      'non-function SDK drain settlement callback',
      '.then(()=>void 0).catch(',
      '.then(null).catch(',
      'must settle its SDK response drain',
    ],
    [
      'expression-bodied SDK drain failure callback',
      '.catch((failure)=>{reportTelemetryFailure("sentry.cloudflare.request_stream",failure)})',
      '.catch((failure)=>reportTelemetryFailure("sentry.cloudflare.request_stream",failure))',
      'must isolate its SDK response drain',
    ],
  ])('rejects a %s cleanly', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it('rejects Cloudflare owners initialized out of dependency order', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const databaseImport =
      'var {runWithCloudflareDatabase}=await import("./assets/database-request-fixture.js");';
    const applicationInitialization =
      'var {application,sentryRequestIsolationReady}=await initializeCloudflareSentryApplication(Sentry,async()=>{const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");return createApplicationServerEntry("cloudflare")});';
    const source = fs.readFileSync(entryPath, 'utf8');
    write(
      root,
      'dist/server/index.js',
      source
        .replace(databaseImport, '')
        .replace(
          applicationInitialization,
          databaseImport + applicationInitialization
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must initialize Cloudflare runtime owners in dependency order');
  });

  it('rejects Sentry configuration before native telemetry initialization', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareNativeTelemetrySetup + cloudflareSentryOptionsDeclaration,
          cloudflareSentryOptionsDeclaration + cloudflareNativeTelemetrySetup
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must initialize native telemetry before Sentry options');
  });

  it('rejects unreachable native telemetry configuration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareNativeTelemetrySetup,
          `let nativeTelemetry=lastKnownNativeTelemetry;if(false){${cloudflareNativeTelemetrySetup.replace('let nativeTelemetry=lastKnownNativeTelemetry;', '')}}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must directly configure native telemetry');
  });

  it('rejects resetting native telemetry before Sentry configuration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareNativeTelemetrySetup + cloudflareSentryOptionsDeclaration,
          `${cloudflareNativeTelemetrySetup}nativeTelemetry=createNoOpTelemetry();${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must assign active native telemetry exactly once');
  });

  it('rejects call-based mutation of active native telemetry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `Object.assign(nativeTelemetry,{forceFlush:()=>Promise.resolve()});${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not alias active native telemetry');
  });

  it('rejects poisoning the retained native telemetry fallback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          `${cloudflareSentryOwner}var worker_entry_default`,
          `${cloudflareSentryOwner}lastKnownNativeTelemetry=createNoOpTelemetry();var worker_entry_default`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must only retain the verified native telemetry adapter');
  });

  it('rejects a destructured native telemetry fallback owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'var lastKnownNativeTelemetry=createNoOpTelemetry();',
          'var {captureException:lastKnownNativeTelemetry}=createNoOpTelemetry();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must bind its native telemetry fallback directly');
  });

  it('rejects local substitution of the native telemetry adapter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        '{createCloudflareTelemetryAdapter}=await import',
        '{createCloudflareTelemetryAdapter:realCreateCloudflareTelemetryAdapter}=await import'
      )
      .replace(
        'var {runWithCloudflareDatabase}=await import',
        'var createCloudflareTelemetryAdapter=()=>createNoOpTelemetry();var {runWithCloudflareDatabase}=await import'
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner createCloudflareTelemetryAdapter by exact shorthand'
    );
  });

  it('rejects an empty Cloudflare request finalizer', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(`finally{${cloudflareRequestFlush}}`, 'finally{}')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must use trusted owner scheduleCloudflareRequestFlush exactly once'
    );
  });

  it('rejects a Cloudflare request owner that catches application failures', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '}finally{' + cloudflareRequestFlush,
          '}catch(failure){throw failure}finally{' + cloudflareRequestFlush
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not intercept application failures');
  });

  it('rejects a telemetry flush owned by the wrong execution context', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'context.waitUntil(completion)',
          'environment.waitUntil(completion)'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the active execution context');
  });

  it('rejects a request lifecycle owner without a bounded force flush', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      'const scheduleCloudflareRequestFlush=(_request,_waitUntil)=>{};export{scheduleCloudflareRequestFlush};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'trusted owner scheduleCloudflareRequestFlush must call forceFlushRequestTelemetry'
    );
  });

  it('rejects unreachable request lifecycle work', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      'import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";import{getTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";const scheduleCloudflareRequestFlush=(request,waitUntil)=>{if(false){forceFlushRequestTelemetry(request,getTelemetry());waitUntil(Promise.resolve())}};export{scheduleCloudflareRequestFlush};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('request flush owner must have one flush and waitUntil scope');
  });

  it('rejects an unbounded request lifecycle completion mapper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('then(()=>void 0)', 'then(()=>new Promise(()=>{}))')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must settle after bounded completion');
  });

  it('rejects a computed request lifecycle completion member', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('.then(()=>void 0)', '[then](()=>void 0)')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must bound its flush completion');
  });

  it('rejects an expression-bodied request lifecycle owner cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const scheduleCloudflareRequestFlush=.*?;export\{scheduleCloudflareRequestFlush/u,
          'const scheduleCloudflareRequestFlush=(request,waitUntil)=>(forceFlushRequestTelemetry(request,getTelemetry()),waitUntil(Promise.resolve()));export{scheduleCloudflareRequestFlush'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded lifecycle body');
  });

  it('rejects a request lifecycle flush declaration with sabotage work', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0);',
          'const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0),sabotage=(()=>{throw new Error("bypass")})();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must isolate one immutable flush completion');
  });

  it('rejects a request lifecycle failure handler that rethrows', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'reportTelemetryFailure("otel.cloudflare.wait_until",failure)',
          'reportTelemetryFailure("otel.cloudflare.wait_until",failure);throw failure'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not propagate waitUntil failures');
  });

  it('rejects substituted request lifecycle helper imports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";',
          'import{forceFlushRequestTelemetry as realForceFlushRequestTelemetry}from"./request-completion-fixture.js";const forceFlushRequestTelemetry=()=>Promise.resolve();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted helper forceFlushRequestTelemetry exactly once'
    );
  });

  it('rejects the wrong export imported as a request lifecycle helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const lifecyclePath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-completion-fixture.js',
      'const forceFlushTelemetry=()=>Promise.resolve();const forceFlushRequestTelemetry=()=>Promise.resolve();const registerRequestCompletion=()=>{};const snapshotRequestCompletions=()=>[];export{forceFlushTelemetry,forceFlushRequestTelemetry,registerRequestCompletion as n,snapshotRequestCompletions as r};'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(lifecyclePath, 'utf8')
        .replace(
          'import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";',
          'import{forceFlushTelemetry as forceFlushRequestTelemetry}from"./request-completion-fixture.js";'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import the forceFlushRequestTelemetry export from its owner chunk'
    );
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
          cloudflareSentryOptionsDeclaration,
          `const fetchCloudflareApplication=({handle})=>handle();const application={fetch:()=>new Response("bypassed")};const runWithCloudflareDatabase=({handle})=>handle();${cloudflareSentryOptionsDeclaration}`
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
          'const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try',
          'let handleApplication=()=>application.fetch(request,{context:void 0});let handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});handleApplication=()=>new Response("application bypassed");handleDatabase=()=>new Response("database bypassed");try'
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
          cloudflareSentryOptionsDeclaration,
          `Object.assign(application,{fetch:()=>new Response("bypassed")});${cloudflareSentryOptionsDeclaration}`
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
        `${cloudflareSentryOwner}var worker_entry_default`,
        `${cloudflareSentryOwner}const appAlias=application;var worker_entry_default`
      )
      .replace(
        cloudflareSentryOptionsDeclaration,
        `Object.assign(appAlias,{fetch:()=>new Response("bypassed")});${cloudflareSentryOptionsDeclaration}`
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

  it('rejects malformed Vite manifest entries with a bounded diagnostic', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeJson(root, 'dist/server/.vite/manifest.json', { malformed: null });

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain valid Vite manifest entries');
  });

  it.each([
    [
      'an unreachable framework fetch',
      'try{return await tanstack.default.fetch(request,{context})}',
      'try{if(false)return await tanstack.default.fetch(request,{context});return new Response("bypassed")}',
      'must execute the live TanStack application request path',
    ],
    [
      'an application owner return before its imports',
      'const tanstack=await import("./entry-server-fixture.js");',
      'return new Response("bypassed");const tanstack=await import("./entry-server-fixture.js");',
      'must import owners before returning one TanStack server entry',
    ],
    [
      'request-body consumption in the request-state prelude',
      'bindRequestExceptionState(request,telemetryCaptureState);',
      'void request.arrayBuffer();',
      'universal request owner must establish exact request state',
    ],
    [
      'a substituted runtime profile in the request context',
      'requestId:crypto.randomUUID(),runtimeProfile,telemetryCaptureState',
      'requestId:crypto.randomUUID(),runtimeProfile:"substituted",telemetryCaptureState',
      'universal request owner must establish exact request state',
    ],
    [
      'a framework-failure catch that returns before rethrowing',
      'if(isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error))telemetryProxy.captureException(error,{});',
      'return {bypassed:true};',
      'universal request owner must preserve framework failures',
    ],
    [
      'a malformed application execution memoizer',
      'applicationResult??=handleRequest();',
      'return handleRequest();',
      'universal request owner must memoize one application execution',
    ],
  ])(
    'rejects %s in the universal application chunk',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath =
        'dist/server/assets/create-application-server-entry-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it('rejects mutation of a trusted helper in its owner chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/request-completion-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';export{forceFlushRequestTelemetry,',
          ';forceFlushRequestTelemetry=()=>Promise.resolve();export{forceFlushRequestTelemetry,'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not mutate trusted helper forceFlushRequestTelemetry');
  });

  it.each([
    [
      'a sabotaging response declarator',
      'const response=await handle();',
      'const response=await handle(),sabotage=response.body?.cancel();',
      'database owner must isolate one application response',
    ],
    [
      'a malformed body guard',
      'if(!response.body){closeDatabase(database);return response}',
      ';',
      'database response owner must close bodyless responses',
    ],
    [
      'a malformed response pipeline',
      'response.body.pipeTo(writable,{signal:request.signal}).catch(()=>void 0).then(()=>closeDatabase(database));',
      'pipeline;',
      'database response owner must close after stream completion',
    ],
    [
      'a connection-failure reporter that substitutes the failure',
      'captureDatabaseConnectionFailure(failure);throw failure',
      'captureDatabaseConnectionFailure(failure,failure={substituted:true});throw failure',
      'database owner must report connection failures',
    ],
    [
      'a request-failure cleanup that substitutes the failure',
      'await closeDatabase(database);throw failure',
      'await closeDatabase(database,failure={substituted:true});throw failure',
      'database owner must close the active client after request failure',
    ],
  ])('rejects %s cleanly', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/database-request-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it.each([
    [
      'a readiness declaration with application substitution',
      'const sentryRequestIsolationReady=initializeCloudflareSentryIsolation(api);',
      'const sentryRequestIsolationReady=initializeCloudflareSentryIsolation(api),substitute=(loadApplication=async()=>({fetch:()=>new Response("bypassed")}));',
      'Sentry application owner must isolate its readiness state',
    ],
    [
      'an isolation initializer with a side-effecting extra argument',
      'initializeCloudflareSentryIsolation(api);',
      'initializeCloudflareSentryIsolation(api,loadApplication=async()=>({fetch:()=>new Response("bypassed")}));',
      'Sentry application owner must initialize the active SDK isolation',
    ],
    [
      'sentinel metadata without a status',
      ',status:200',
      '',
      'Sentry sentinel owner must emit exact bounded response metadata',
    ],
    [
      'a malformed SDK response drain',
      'sentryResponse.arrayBuffer().then',
      'sentryResponse.then',
      'Sentry request owner must drain one bounded SDK response',
    ],
    [
      'a malformed application memoizer',
      'applicationWork??=Promise.resolve().then(async()=>',
      'return Promise.resolve();Promise.resolve().then(async()=>',
      'Sentry request runner must own one memoized application execution',
    ],
  ])(
    'rejects %s with a bounded diagnostic',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath = 'dist/server/assets/sentry-request-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    [
      'application.fetch',
      'dist/server/index.js',
      'application.fetch(request,{context:void 0})',
      'application.fetch(request,{context:void 0},request.arrayBuffer())',
      'active application handler must invoke application.fetch with the active request',
    ],
    [
      'the outer Sentry request owner',
      'dist/server/index.js',
      'fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})',
      'fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions},request.arrayBuffer())',
      'Worker fetch must return or await its Sentry-owned response',
    ],
    [
      'the Sentry request wrapper',
      'dist/server/index.js',
      'runWithCloudflareSentry({api:Sentry,handle,request,requestOptions:{captureErrors:false,context,options:sentryOptions,request}})',
      'runWithCloudflareSentry({api:Sentry,handle,request,requestOptions:{captureErrors:false,context,options:sentryOptions,request}},request.arrayBuffer())',
      'Cloudflare Sentry owner must invoke runWithCloudflareSentry',
    ],
    [
      'the Worker database owner',
      'dist/server/index.js',
      'runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request})',
      'runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request},request.arrayBuffer())',
      'active database handler must return its database-owned response',
    ],
    [
      'the Hyperdrive client factory',
      'dist/server/assets/database-request-fixture.js',
      'createHyperdriveDbClient(binding)',
      'createHyperdriveDbClient(binding,handle=async()=>new Response("bypassed"))',
      'database owner must create its client from Hyperdrive',
    ],
    [
      'the runtime database scope',
      'dist/server/assets/database-request-fixture.js',
      '}})};export{runWithCloudflareDatabase};',
      '}},request={signal:void 0})};export{runWithCloudflareDatabase};',
      'database owner must return its runtime database scope',
    ],
    [
      'the database response binder',
      'dist/server/assets/database-request-fixture.js',
      'bindCloudflareDatabaseToResponse({database,request,response})',
      'bindCloudflareDatabaseToResponse({database,request,response},response.body?.cancel())',
      'database owner must return its response lifetime binding',
    ],
  ])(
    'rejects a side-effecting extra argument at %s',
    (_label, relativePath, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(root, relativePath);
      const source = fs.readFileSync(chunkPath, 'utf8');
      const mutated = source.replace(search, replacement);
      write(root, relativePath, mutated);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    [
      'validateServerConfig("cloudflare",{databaseAdapter:database.$adapter})',
      'validateServerConfig("cloudflare")',
    ],
    [
      'validateServerConfig("cloudflare",{databaseAdapter:database.$adapter})',
      'validateServerConfig("cloudflare",{})',
    ],
  ])(
    'rejects an incomplete Cloudflare database validation payload',
    (search, replacement) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath = 'dist/server/assets/database-request-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('database owner must validate the Cloudflare adapter in scope');
    }
  );

  it('rejects unknown profiles', () => {
    expect(() => verifyRuntimeProfile('auto', fixture())).toThrow(
      'unknown profile auto'
    );
  });
});
