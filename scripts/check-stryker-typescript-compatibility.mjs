import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootRequire = createRequire(path.resolve('package.json'));
const mutationRequire = createRequire(
  path.resolve('tools/mutation/package.json')
);

const rootTypeScript = rootRequire('typescript');
const preprocessingTypeScript = mutationRequire('typescript');
const nativePackage = mutationRequire('@typescript/native/package.json');

if (rootTypeScript.version !== '7.0.2') {
  throw new Error(
    `Root compiler must resolve TypeScript 7.0.2, received ${rootTypeScript.version}.`
  );
}
if (preprocessingTypeScript.version !== '6.0.3') {
  throw new Error(
    `Stryker preprocessing must resolve TypeScript 6.0.3, received ${preprocessingTypeScript.version}.`
  );
}
if (nativePackage.version !== '7.0.2') {
  throw new Error(
    `Stryker native checker must resolve TypeScript 7.0.2, received ${nativePackage.version}.`
  );
}

await import(
  pathToFileURL(mutationRequire.resolve('@typescript/native/unstable/sync'))
    .href
);

const checkerPackagePath = mutationRequire.resolve(
  '@stryker-mutator/typescript-checker/package.json'
);
const checkerModule = await import(
  pathToFileURL(
    path.join(
      path.dirname(checkerPackagePath),
      'dist/src/ts-native/native-typescript-checker.js'
    )
  ).href
);
const checker = new checkerModule.NativeTypescriptChecker(
  { info() {} },
  {
    check: async () => [
      {
        fileName: 'compatibility-fixture.ts',
        line: 1,
        column: 1,
        code: 2322,
        text: 'Type mismatch compatibility fixture',
      },
    ],
    dispose() {},
    isProjectFile: () => true,
  }
);
const classification = await checker.check([
  { id: 'compile-error-fixture', fileName: 'compatibility-fixture.ts' },
]);

if (classification['compile-error-fixture']?.status !== 'compileError') {
  throw new Error(
    'Stryker native checker did not classify a compiler failure.'
  );
}

console.log(
  `Stryker compatibility passed: root TS${rootTypeScript.version}, isolated preprocessing TS${preprocessingTypeScript.version}, native TS${nativePackage.version}, and compile-error classification.`
);
