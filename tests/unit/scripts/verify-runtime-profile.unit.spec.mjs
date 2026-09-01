import fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseSync } from 'oxc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectArtifactOwnerConsumerSourcesForTesting,
  inspectArtifactOwnerCallerComponentsForTesting,
  inspectAstParentMapBoundForTesting,
  inspectAstTraversalForTesting,
  inspectAstDigestForTesting,
  inspectCloudflareAnalysisBudgetForTesting,
  inspectCloudflareAnalysisBucketsForTesting,
  inspectCloudflareAggregateResolutionDepthForTesting,
  inspectCloudflareAppOnlyTopLevelInertForTesting,
  inspectCloudflareDeferredArgumentHazardForTesting,
  inspectCloudflareDirectLocalProxyFactoryResultForTesting,
  inspectCloudflareFactorySpecializationLifecycleForTesting,
  inspectCloudflareInvokedParameterProjectionsForTesting,
  inspectCloudflareImportedFactoryCycleForTesting,
  inspectCloudflareImportedFactoryContextReentryForTesting,
  inspectCloudflareImportedStaticPrimitiveMembersForTesting,
  inspectCloudflareKnownIsolatedExpressionForTesting,
  inspectCloudflareKnownIsolatedReceiverExpressionForTesting,
  inspectCloudflareLoadEffectsForTesting,
  inspectCloudflareLoadInternalIsolatedReceiverForTesting,
  inspectCloudflareShallowLoadEffectsForTesting,
  inspectCloudflareStaticPropertyKeysForTesting,
  inspectCloudflareSyntheticMutationTargetKeysForTesting,
  inspectCloudflareUncertainReceiverIndexForTesting,
  inspectCloudflareModuleGraphBoundForTesting,
  inspectCloudflareReviewedLoadEffectsForTesting,
  inspectCloudflareReviewedClosurePolicyForTesting,
  inspectCloudflareReviewedClosureProgramIsolationForTesting,
  inspectCloudflareReviewedFactoryResultPathForTesting,
  inspectCloudflareReviewedAggregateArtifactProofForTesting,
  inspectCloudflareReviewedAggregateSpreadsForTesting,
  inspectCloudflareReviewedExportArtifactLoadEffectsForTesting,
  inspectCloudflareReviewedExportArtifactProofForTesting,
  inspectCloudflareReviewedExportConsumerProofForTesting,
  inspectCloudflareReviewedExportMutationPlanForTesting,
  inspectCloudflareReviewedFreshExportReceiversForTesting,
  inspectCloudflareReviewedMutationRelocationForTesting,
  inspectCloudflareReviewedMixedClosureOwnershipForTesting,
  inspectCloudflareReviewedModuleRegionForTesting,
  inspectCloudflareReviewedPolicyValidationForTesting,
  inspectCloudflareReviewedOriginDirectAliasProofForTesting,
  inspectCloudflareReviewedStaticMemberDeferredResultForTesting,
  inspectCloudflareReviewedStaticMemberProgramCacheForTesting,
  inspectCloudflareReviewedStructuralProgramDigestForTesting,
  inspectCloudflareProvisionalReceiverDetailsForTesting,
  inspectCloudflareProductionKernelStaticShapeForTesting,
  inspectCloudflareReceiverDetailsForTesting,
  inspectCloudflareSpreadStabilityCacheForTesting,
  inspectCloudflareReviewedReceiverMutationsForTesting,
  inspectCloudflareReviewedSingletonReceiverRootsForTesting,
  inspectCloudflareFactoryOriginLineagesForTesting,
  inspectFreeIdentifierReferencesForTesting,
  inspectParsedModulePathIdentityForTesting,
  inspectTopLevelOwnerConsumerBoundForTesting,
  verifyLegacyCloudflareTelemetryFixtureForTesting,
  verifyRuntimeProfile as verifyRuntimeProfileImplementation,
} from '../../../scripts/verify-runtime-profile.mjs';

const compareCodePointStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const referenceAstDigestIgnoredKeys = new Set(['end', 'loc', 'raw', 'start']);
const referenceAstDigestReplacer = (key, value) => {
  if (referenceAstDigestIgnoredKeys.has(key)) return undefined;
  return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
};
const dynamicOwnerSourceNames = {
  tanstack: 'src/entry-server.ts',
  telemetryProxy: 'src/platform/telemetry/index.ts',
};

const fixtureEmptyPluginAdaptersSource =
  'node_modules/.pnpm/@tanstack+start-server-core@1.169.15_fixture/node_modules/@tanstack/start-server-core/dist/esm/empty-plugin-adapters.js';
const fixtureCloudflareProvenanceKey = Buffer.alloc(32, 7).toString(
  'base64url'
);
// These compressed bytes are the exact reviewed production-v5 chunks whose
// digests and module ownership are authenticated by the verifier policy.
const reviewedRolldownRuntimeChunkGzip =
  'H4sIAAAAAAAAE3VVTW/bMAw9x7+CcYFCRgWn52ZZMWy7DGgzILtlQeHYdOLWlgJZbhu0+e8jJTt2mvVSV+Qj9fT4kcnkwuCm0Ar+Xhtdlpl+URPTKFtUGD/WwXNi4OEhNZhYhBnM14+Y2tifp603w/y30bveTYZCIdvQ2H0H26Cdvyi2/sA67dG9ndHsM8XOanMed59UWH8W6JyDGLJbPc9P4M5m9zuc5x1ym9Rtkh6562Bx7x2+BOvqrlCEF7mSYLCWgMZEMPsKwv19C0ZFDsIZ7dboF/Yvr1fTYGTNnt0jg7YxCnIFl5cgjHtXrighfa+jyKUl+AHSxKZbyhW5sGM2gi1xRRczKDh01FJdVVr9WrT80rWESmcDaoKO8P7OLuH+n8Eb4OtOG1vfwNsBDlHcHn2ohHRNINWUZeQsnTs6yuHO38qSb0zKUoLSD/W+Wuuy7uQo0YJNDNWALyS6o1wbEJxAUeGA6FJk1HeT8Gjp3NK9nY43jFqyaSXJgqqp0CTrEm/AmgZJCmLltB8POZxnXThXbPXCmkJt/iQbugOek7KhVOGdzpoSQ3DZ2kr5yOlQ6t2ec3LlhNUScqMrKshriju6IaNGHjYDe7nW3Fc6d2CYzWYQatd0IRflzJc3KrU0nWEER72ecM9Xng2Gu4FKVHAHkW70YWhcotrYreTDlJxfQNHn6sr3Exlb3LLg9vTaDcciTkly9z5CRfwCjhkTO//SE3U9ypfL10uIJ6cCk1s+raJ4XahMcDf5hFzGkzqORebXw8eNIby+HBSxWAyL+0jK48p16CumB9Wy+ufijitFHUwa1fc6QyoztZYvrB+OY4vyZIx918PtcQOK4WbhTMSEh0YO20H0yZnmuB04/sa8O3xzOdO5zo5dSHomTWmp6rf/6d2j2+nc9iwHBucDcWCCXaAj3Avyvd0VrSpOgc8YVY50N/qOGJmWH+0rum0oRU+eRQr754eDcWOiNGqe3zSYTC5QZf5XKfCJCdtVMKkhkaf0yVTIfi3TUcmTtUQWIz8sR7JZoO74BxNri7MBBwAA';
const reviewedReactChunkGzip =
  'H4sIAAAAAAAAE9UbaZPbtvWz/CuwaiZDxTTXdmeaqRzVUdbaWM1eleSk7naHQ1GQRC9FKjzWVpz9730PFwEQ2iPHh36wVwLehYeHdwFKNtu8qMhnUpGoJGEY55tNnv1zeppk5JYsi3xDusFhkafpIv+YPSvqrEo29NnXYfGf2Q/XSfCh7L56cnj4l4KukjwjWb6g4SZf1CktD4Nttt0cFjSKq29f/D14GXx9aMyzmcP4g/gUbAuYiCugA2SfHH711ZOvyLdpEtOspGSCIDDgAkXAo3y7K5LVuiJe3COntIrIRRpVy7zYlD4ZZ3FAomxBouUySZOoomXA0GbrpCRlXhcxJTEIR+CrYLkgdbagBanWlJyOZ3KYLHMYJ6AfmAAKJ+Oj0dl0RIAuFaOkyPOKLJKCxlVe7Ei+hNGGT1VQCtwPn9xEBazn5xoAQ7ausFkXGZBDWH4YXrybjMKQfHVo7o7nefQT7l3ZI4N/kM9POkhtMhoezcLRyeh0dDYLZ+8vRkBnutvM8zQAVXhdrr6qiLIyQTZRGtCUbmhWdXuvdBoX55PZ8GQ/CWQdpRbS8WT4/d2cl0W0cnCbziZj+HN6/ma0H7esigR0BOZDbWEn58fjk9HkDnGLHDeosBCPzs+m707vQozzrKw3LsTZ6N93LBTwKvrJXufx+eSn4eRNOBkd36GjvPgYFQswiaWtpnfTCzS2O3RUl1u0UgvxdHR6vh9pQze5hXAy/M/7/Qhp9MvOQoB/4x/HszuQ4F9yk1QN4unw/XejcDwbTYaz80k4fX/63flJg5pUtIjg/AD0ss74oVjRaiyGjzNvE+3mlH2fp7SHZ6CTLImX1WlKBoMBMebJr7+Sbj7/AGeySw5gttptKZxMi0hBq7oARwY0gHHHJDHYI/OXX5pkLp1gVyiCCdf99lu5zO4V8hPsu3LFXbYQl6jktfW9L4W+FfuCWj/L8+277QIc3r9qWuMKmJbKU3BiFV30iWTkcf1JAQ5eoDS3PvxHs58R9TgH38VJmVg60IRu0yim0+pOqCmtXBAgubCMqCyTFbrAc7ZfAf8uJulmW+34BC7nVrePoxziWQb+xYMDvwXHL46hT2omecFXid44YBBAgf19JUcFAoyLT2oGjiOCa+zVlCAOs/IT7LRL/3x3lJQoQ5Xj7gZJyeDVlFyaC7YU+gMYpcBtVFRJlLJxWHaUpvMovm4Ohcv0dRy0Yc3q7oBix+tgYIz3IMAV+UcyKgo88FV0TUuIt4QzxQBYMnTYvwSNtSRVLnRFcthvtQ7ycZ3Ea3EK7yYRMEdibEBgGZiHkz5x68YnXalIRmmftpeN4esKN1XskkI7MUIQjbVGVXFvm/GberPZicNhDjYCglAOsXVyF3VB/z9OBp7vrS7thbZKYxnG+jP6saUzIOimxEJ6VdSYm9lUAYn7Gs+N67tUfQerpETyrZN98Fz4sqQcFkW0G2+2ELEI+xyIMX0DM9CVsALl2afrqKCLMexEAVlcKTz7Wx4F0NkOm4+z5uOUf2x87Toqzz9mIPKWFtWu8bnNATAhdLmYICOeP3pcP9d053PD4QbFc9wlYkuLQnvRYh0LO198wb1N35HCotgdRh0/IAMeqAD4Jk8W5DnzVpLJa/WpWXSH8cWAxs1MLSBOYUuG2ULErR/ozsvThViRj3YFQ3whQlpjyQ1swFfPEXyiTXBdWHyT8scoTRaKDlO5wUf5ay3+C1fY+OCBNsQ/BVKRDK+tS0sOWsbRlnrXcpEsvrKx4iTPr+utMKtOd9Dtk+7geZeps9tn3152hUqV0F90yVM0AdhiplDv8HLQvzpc+Y3f3ERVvDaTDYPjJQNgydBtr/EKdUkL2NWbZEEXoOIRQ5nQFf2EldJ/D58erqxEUSgX95TKDU2govt0r54FuKHo9pgcCmC9YHVClV3UgDbTAzNkXIMqn0IBk628v/7NNoeClnl6Q2drmmFog2jBP3BJy48JaISo0QADYS3OVyeOoCaFyJ1CfZPSBWyMWJkCv4lS5l8lbEFxxQyUR20FCYl6mWcMdEGXUZ1WfSK5d0smvaEoSyLQghrBDx76LZ95L1SDvQDYuC4UKwuk6luYylzUwn7EVYg1dxQel8aiC3vk4tXoyLeUw+K6wYfp4FYzW4qZze9ir9Tu2wrH2MnIc669nm/TlIwfs9mP2e3bJ/yfCWFZ6SbaQrjJWXTy4nWSLgqa+STC776w/8UFeN/kE2x6tKHT/Dgq7GQUD7MI28KKJKlXMlXFvssyyUBmZWysepvneUojrSbqKVxMAkTJxuJqdpNf0yPBGCPuC0ldVYcSteeAxvjcoSnoTx0+xk47cfNklWRVt9+MiAOijWT1Zk4LPtLZw6XTmcNGXGvnU3ik5uhJSZVzN8yh7eT79qTWzOFz+4XRpNEpqH6AsrgWBSVlmGQJ+FrDXEzoZkXhNtqlebToPcaODJPFPTWpqyI+1oSzOff89gq63LIUS/Bn3QD9uRlNGtN/jm5Nk1BL57T64DXxjEUxTr4KI5YY6D1scBNEBdf9MREKjC++POz2QPYu/LE2oylD3DpH6Zo6x4zVMQ/MPZFd4QJiXXQrs2m0gJP6hrQzr0Ysc/1P1aFVrFjMBZegjj9QVzaFcwMb+DXuLsQgFp/1md7j1Ql/LIuT5hts63LdLBqGud+xLe25dFQZ1FFnYECaZThtUDMzFKLfle7MMDlp2z0C5SXxmCdk3ODPN42CUpqtqjUMPn3a0+g2R/gyufKJqq0MCe3DoFt/+0w9HZiWp0G7TY+n0cZJZ26YLRWkMRuA2mF2d8wSoQktTCQBUjf8AFfRgedSRYDr93q9YAH2+spUl/rMo+5vURnswJ+rtFZ+K44zm3PqTK0c0wDlSw2J7HxVU+YjvTgDx54vT40VITZp9JR4WVoCAwoZZUVu0M3gpVXEazIuN/HY9QxUJ+g2upeiPuLIV3ydnOdrGWgJRNk1Fi0l+YxYov7FgUae4EOeZB74Re4EbvFEMjrsay8g4yXZ5TXZQH5SYXMLkPDyKCJxDpkaT6A05fpY0GB7iwuTZGVFo4Voad025YlpGu2E7EjQ04ISTqv2TqsrrqU90qNr6Rev1ktI/GFPLq+QTM06Fs95M9yZAHIEHjbM0IEgZvjAOXEAZf+JQQlOcBxU4SdROHlr6XgDMYY0IwEr+IUWnkwj1HKfvWB7LcaD0MijcZmi/aMAFBvIe/gU/vF6asQqTPgt5rlWuXPGz118MVbtk8gGHZAXvi0WDOr87q5O/iApXrqkYIxEmcL+uOmxaN8m+dxFEnWrzB5l3yOhMAeLQCAK1VeqemnvqGghQJzPi+r7NJ9HKXMqvCh0uEAOyWFeG9/6Tp07HS3Q+QiVP0hkttZb8wEjPbqB8KDZJ73hvULsbbbgvC7jDoeNb/m8nmNLvA9pvC9S9yymKTrnZmxDyzJawYCz58GWZ3Q85Iir8meTgaAIOhL+2xjGHFEf73Ex2GfNglB5B2KFi6TcYvuHL5KpoCd3npkI2R/Y8KqiyGPgvV/hAiCgm0TqWh/C0jOO6tW6Gn2K6Zah+3ptrkkC/7CRDBVpwAA8BSY7q0dN0vGZe8++7rJRG5CcjKJ43bd8JvfjfO6YuXPx5Uj36p39/l+/0etohIJou0134jYiKlY15iRl0+0wuagrQOabHUJq5prJIPFQqbKnT3U/Iu9dFU8RZ/ZzbRKTu9jpMaijRzzBHH3i5ZXimmfpHSyZqdoVTpN0G/kKS0oCKVqAhAn9tGW9GJ4gxDS5gRyAlHBCUvHCRfUZGVmRD3QckVrcloo3IMFQXK6Tges+XgPUjPKoIadmtUsK/VJEzh+L5xuKjfHiQwO8EO8tFKDxREMH1C9OHNcxEm7KHn+c4hOdwZ5HIzq0eAbRwOovJzTAMDw6GaP847PZaHI2PJmGb87Ds/NZ+A6AzyfhT8PJGX6eTMPZ29H78Gh4xmYvvp8M3+BDB9dljMng/PSCrXzy7mw2Ph0JdxCG7IYlDJtrilizvBLSGtPQXYyCtwHkkad0kx/BuaUcy2EeMc7qt5fLzOiC73kFsMyEw2ASWg7j9pWDxzRZgVw6J4OPfKGgo2EjQBwmHU/17MHLLpOVT8yzaLTy5KGBsyxuhLRR61xC0aIWQjZ1WZE5VTWEYjqvK5bPb6MSX4JpTX3M98W5ZLeV4q5UXBt+Bi9KjZsfdiVGjNsCoxV5MBArFKUqYmHxiG/JtOstDsNaGZhbcZq8maFmer4idWBe2qmUm2lSsmDOrwuIPEYqzjgahiVNl+4J9ozNMYUPlsxREFXbECEpgCE4v4i+lLBXRAI0Q4aWGcFBY4SijUGekZdSoS8M7j1x3agV/7oHVZnEC/KNhsPsX7VPGMJQFKm88FGgvt5ckaOiq9LgXSZXutSXCWzZSxZwOm7x5O2vXgYat47UuHLULlztk1XQqKJH6tpeHS2RMms3KvqIvPKzr2T1J28skwvjugC5OVaf6DTa8y9dAHAwoeo94tkFz1JFA67QLm+PxBM8eXPNrxx1aoHEAtn18RacJHXHGpv3gGIRXH+m+E/Me0+LZ3sTHP5NNG2czk03eV+5GPQt/NzLq44/2Yk8zIdgss18yIF18pUPcU0IH2JPPcYpSJ2dcD/wENdgojzGQdiY97oJC8F3dWJP9EbsH+UyUGLWiAR1svcbwjov+KOMln201NhC8lur15y6vWF7NtEgYG2my8k9zLlNIJTsyzU+E+F/xE2Fna+IZ7YWCd63Mwm5PIX9kle8SUFkR25k1gzYhTYGNEhsbBnPzKr8AdKo6znus0QLpC/KHtFC6ZNnL3gJLlojfdZ74bUfw8OLu77dW3MsBx8Mu3zZZgvZ6f3SqtfI5ssegd83UwY2Rl7zPezLAYdQsMiimqmX7bp8ZZzLxjd3rfTGAHSm1jNfGpABy15ldtwYaOg2CmtMFbumUuaakaGWieaBe8izqbmAY9iNcr1PuilzB807oD3Y+DDIPeW1JPV10Xjh6Wqy6PLr/SJrfF9nTQGxfipC2mPi2UirXcerDhJH7FJcb3m2QJtmDCAsE9BYKnZAiWsZgb6SlmZYqiWamgaamNiLAvu611JMSo6irc7ApOcpDaHEY+UduCo4uOu9Hm9/haije7YrrUujNKzL5unRvYQldJvkkFFrvVOOYm5qCXcw4k0uJBgb8DbZ9QPZasTvpdgWTbuIbT3n9SGZk28XH6BW+arAxHawbGfhRi/vflYc2tN6cxaLN3Rer35Uz5m0h/U23BJOh3jopIOKS0yhR606uFc4g6STTlvc0XLJX/A3W8BC+qM2gBMxMfexGt1YGbj5LumBvHhnWr/EtJiNF7/hfI4XrlM53mzxqju5oW+jbJFSM09ZQnx6vMZsmg5CDkGyEioAYPuHbJpF7b7dO4l2eV39IZx1UvexPbVynN/ADkncx+Z8WyWbpKyS2Pw1R1li16perTEQLurYykn3M20Iuqm0RZjwGdO62JA6xMNixT8/UAhB8g46LjGMRPw3uCGg4N3jdVrxSI8aD2TDw46B6GC0y+LRJ443hSzbYFrW8zIukjmYxYpW0yzaluu84l9ocUMLOfRQiWxmj+DQFt2dQz9QlAa55dGAa8mJdvnPgbuvntz2euz3w1A48Z8Q/74fE/OX1h/K9k9ryYN/T+uLq3b5u1r+LRCzZLD3J7u44PZ6OB5Uo6Y4UUkqLEn/BxpWwMiBPQAA';
const fixtureTanStackOwnerDigests = {
  createStartHandler:
    '6a9731e0a46846cce538b09b6afe5c18b74ad3e12349bfd87d5e25fe5f86bb70',
  defineHandlerCallback:
    '6a9731e0a46846cce538b09b6afe5c18b74ad3e12349bfd87d5e25fe5f86bb70',
  emptyPluginAdaptersChunk:
    '4ac630a35e14c193022ea8123bebd83f8452615b082cbdceeac56ed3d5fa1050',
  observedStreamHandler:
    '491fa0c918820444852f630fab2c40ab69b3ba30091a8c23cd9c7211aec395ba',
  routerLocalClosure:
    '4095cfe39799c83e4cfc0b053ea1ba8ce9d0bd4a87e545c4a621a8310cf0ebe6',
  serverClosure:
    '40bd64744f6aab4b68916c95d3387c634baa7e27ff0e037c46dc2399602fa062',
  serverEdgeClosure:
    '746f2dd8f008acc79f1783e259e0021736ca9acd54a68e2070ba45c7b0b6e18e',
  startOwnerClosure:
    '271a658e6e1cb30b63de34f38b6f8ea4c9b4024d8cdddc0442b516fe09587d27',
};
const verifyRuntimeProfile = (profile, root, options = {}) => {
  if (profile === 'cloudflare') writeFixtureCloudflareProvenance(root);
  return verifyLegacyCloudflareTelemetryFixtureForTesting(profile, root, {
    cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
    cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
    ...options,
  });
};

const emittedReviewDigest = (verify) => {
  try {
    verify();
    throw new Error('Expected a reviewed artifact digest diagnostic');
  } catch (error) {
    const match = String(error?.message).match(/\(([a-f0-9]{64})\)$/u);
    if (!match) throw error;
    return match[1];
  }
};

const ambientLocaleReviewDigest = (root, locale) => {
  writeFixtureCloudflareProvenance(root);
  const priorLang = process.env.LANG;
  const priorLocale = process.env.LC_ALL;
  process.env.LANG = locale;
  process.env.LC_ALL = locale;
  try {
    return emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
  } finally {
    if (priorLang === undefined) delete process.env.LANG;
    else process.env.LANG = priorLang;
    if (priorLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = priorLocale;
  }
};

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

const fixtureAppOwnedModules = new Map();

const markFixtureAppOwnedChunk = (root, file, modules) => {
  const byFile = fixtureAppOwnedModules.get(root) ?? new Map();
  byFile.set(file, modules);
  fixtureAppOwnedModules.set(root, byFile);
};

const markOptionalFixtureAppOwnedChunk = (root, file, modules) => {
  if (!modules) return;
  markFixtureAppOwnedChunk(root, file, modules);
};

const readFixtureSourceOverride = (
  readFile,
  filePath,
  safeSource,
  candidate,
  options
) => {
  if (
    path.resolve(String(candidate)) === path.resolve(filePath) &&
    options === 'utf8'
  ) {
    return safeSource;
  }
  return readFile(candidate, options);
};

const fixtureJavaScriptFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return fixtureJavaScriptFiles(candidate);
    return entry.isFile() && /\.(?:m?js)$/u.test(entry.name) ? [candidate] : [];
  });

const fixtureCloudflareOwnership = (modules) => {
  const appModules = modules.filter(({ owner }) => owner === 'app').length;
  if (appModules === modules.length) return 'app-only';
  return appModules > 0 ? 'mixed' : 'non-app';
};

const fixtureCloudflareAppSourceId = (sourceId) => {
  if (typeof sourceId !== 'string') return undefined;
  if (!sourceId.startsWith('src/')) return undefined;
  return sourceId;
};

const fixtureCloudflareSourceKey = (source, file) => {
  if (!source) return file;
  return source.key;
};

const fixtureCloudflareManifestModuleId = (source, file) => {
  const appSourceId = fixtureCloudflareAppSourceId(source?.src);
  if (appSourceId) return appSourceId;
  return `non-app:${fixtureCloudflareSourceKey(source, file)}`;
};

const fixtureCloudflareModuleIds = (explicitModules, source, file) => {
  const configuredModules = explicitModules.get(file);
  if (configuredModules) return configuredModules;
  return [fixtureCloudflareManifestModuleId(source, file)];
};

const sortedFixtureCloudflareEdges = (source, field) =>
  [...(source?.[field] ?? [])].sort(compareCodePointStrings);

const fixtureCloudflareChunkRecord = (source, modules, chunkFile) => ({
  dynamicImports: sortedFixtureCloudflareEdges(source, 'dynamicImports'),
  imports: sortedFixtureCloudflareEdges(source, 'imports'),
  modules,
  ownership: fixtureCloudflareOwnership(modules),
  sha256: createHash('sha256').update(fs.readFileSync(chunkFile)).digest('hex'),
});

const fixtureCloudflareChunk = (
  artifactRoot,
  explicitModules,
  manifestSourcesByFile,
  chunkFile
) => {
  const file = path.relative(artifactRoot, chunkFile).split(path.sep).join('/');
  const source = manifestSourcesByFile.get(file);
  const modules = [...fixtureCloudflareModuleIds(explicitModules, source, file)]
    .map((id) => ({
      id,
      owner: id.startsWith('src/') ? 'app' : 'non-app',
    }))
    .sort((left, right) => compareCodePointStrings(left.id, right.id));
  return [file, fixtureCloudflareChunkRecord(source, modules, chunkFile)];
};

const writeFixtureCloudflareProvenance = (
  root,
  { registerDetachedJavaScript = true } = {}
) => {
  const artifactRoot = path.join(root, 'dist/server');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, '.vite/manifest.json'), 'utf8')
  );
  const javascriptFiles = fixtureJavaScriptFiles(artifactRoot);
  if (registerDetachedJavaScript) {
    const manifestFiles = new Set(
      Object.values(manifest)
        .filter(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof entry.file === 'string'
        )
        .map((entry) => entry.file)
    );
    javascriptFiles.forEach((chunkFile) => {
      const file = path
        .relative(artifactRoot, chunkFile)
        .split(path.sep)
        .join('/');
      if (manifestFiles.has(file)) return;
      manifest[`fixture:${file}`] = { file, name: `fixture:${file}` };
      manifestFiles.add(file);
    });
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  }
  const explicitModules = fixtureAppOwnedModules.get(root) ?? new Map();
  const manifestFilesByKey = new Map(
    Object.entries(manifest).flatMap(([key, entry]) =>
      typeof entry?.file === 'string' ? [[key, entry.file]] : []
    )
  );
  const manifestSourcesByFile = new Map(
    Object.entries(manifest)
      .filter(
        ([, entry]) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.file === 'string' &&
          fs
            .statSync(path.join(artifactRoot, entry.file), {
              throwIfNoEntry: false,
            })
            ?.isFile()
      )
      .map(([key, entry]) => [
        entry.file,
        {
          dynamicImports: (entry.dynamicImports ?? []).map((edge) =>
            manifestFilesByKey.get(edge)
          ),
          imports: (entry.imports ?? []).map((edge) =>
            manifestFilesByKey.get(edge)
          ),
          key,
          src: entry.src,
        },
      ])
  );
  const chunks = Object.fromEntries(
    javascriptFiles
      .map((chunkFile) =>
        fixtureCloudflareChunk(
          artifactRoot,
          explicitModules,
          manifestSourcesByFile,
          chunkFile
        )
      )
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const payload = Buffer.from(JSON.stringify({ chunks, version: 1 })).toString(
    'base64url'
  );
  writeJson(root, 'dist/server/start-ui-app-chunk-provenance.json', {
    algorithm: 'hmac-sha256',
    payload,
    signature: createHmac(
      'sha256',
      Buffer.from(fixtureCloudflareProvenanceKey, 'base64url')
    )
      .update(payload)
      .digest('base64url'),
    version: 1,
  });
};

const createReviewedReactAnalyzerFixture = (consumerSource) => {
  const root = fixture();
  const rolldownFile = 'assets/rolldown-runtime-7_rZTKki.js';
  const reactFile = 'assets/react-m4gW-Tkn.js';
  const consumerFile = 'assets/reviewed-consumer.js';
  write(
    root,
    `dist/server/${rolldownFile}`,
    gunzipSync(
      Buffer.from(reviewedRolldownRuntimeChunkGzip, 'base64')
    ).toString('utf8')
  );
  write(
    root,
    `dist/server/${reactFile}`,
    gunzipSync(Buffer.from(reviewedReactChunkGzip, 'base64')).toString('utf8')
  );
  write(root, `dist/server/${consumerFile}`, consumerSource);
  writeJson(root, 'dist/server/.vite/manifest.json', {
    '_react-m4gW-Tkn.js': {
      file: reactFile,
      imports: ['_rolldown-runtime-7_rZTKki.js'],
      name: 'react',
    },
    '_rolldown-runtime-7_rZTKki.js': {
      file: rolldownFile,
      imports: [],
      name: 'rolldown-runtime',
    },
    'src/reviewed-consumer.ts': {
      file: consumerFile,
      imports: ['_rolldown-runtime-7_rZTKki.js', '_react-m4gW-Tkn.js'],
      isEntry: true,
      name: 'reviewed-consumer',
      src: 'src/reviewed-consumer.ts',
    },
  });
  markFixtureAppOwnedChunk(root, reactFile, [
    'node_modules/.pnpm/react@19.2.7/node_modules/react/cjs/react.production.js',
    'node_modules/.pnpm/react@19.2.7/node_modules/react/index.js',
  ]);
  markFixtureAppOwnedChunk(root, rolldownFile, [
    'non-app:66364e236ec24f3d62d60f62f82cca5694450afb05a0f51ab2a16d0d73781ed3',
  ]);
  markFixtureAppOwnedChunk(root, consumerFile, ['src/reviewed-consumer.ts']);
  writeFixtureCloudflareProvenance(root);
  return {
    analysisLabel: consumerFile,
    artifactRoot: path.join(root, 'dist/server'),
  };
};

const replaceManifestBackedHashedDependency = (
  root,
  {
    parentFile,
    parentManifestKey,
    replacementFile,
    replacementManifestKey,
    transform,
    trustedFile,
    trustedManifestKey,
  }
) => {
  const assets = path.join(root, 'dist/server/assets');
  write(
    root,
    `dist/server/assets/${replacementFile}`,
    transform(fs.readFileSync(path.join(assets, trustedFile), 'utf8'))
  );
  const parentPath = path.join(assets, parentFile);
  write(
    root,
    `dist/server/assets/${parentFile}`,
    fs.readFileSync(parentPath, 'utf8').replace(trustedFile, replacementFile)
  );
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest[replacementManifestKey] = {
    ...manifest[trustedManifestKey],
    file: `assets/${replacementFile}`,
  };
  const parentImports = manifest[parentManifestKey].imports;
  parentImports.splice(
    parentImports.indexOf(trustedManifestKey),
    1,
    replacementManifestKey
  );
  delete manifest[trustedManifestKey];
  fs.rmSync(path.join(assets, trustedFile));
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
};

const replaceManifestStaticEdge = (
  root,
  {
    ownerFile,
    ownerManifestKey,
    replacementEntry,
    replacementManifestKey,
    replacementSource,
    trustedManifestKey,
    trustedSource,
  }
) => {
  const ownerPath = path.join(root, ownerFile);
  write(
    root,
    ownerFile,
    fs.readFileSync(ownerPath, 'utf8').replace(trustedSource, replacementSource)
  );
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest[replacementManifestKey] = replacementEntry;
  const ownerImports = manifest[ownerManifestKey].imports;
  ownerImports.splice(
    ownerImports.indexOf(trustedManifestKey),
    1,
    replacementManifestKey
  );
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
};

const cloudflareSentryOwner =
  'const fetchCloudflareApplication=({context,handle,request,sentryOptions})=>sentryOptions?runWithCloudflareSentry({api:Sentry,handle,request,requestOptions:{captureErrors:false,context,options:sentryOptions,request}}):handle();';
const cloudflareRuntimeOwners =
  'var Sentry=await import("./assets/esm-fixture.js");' +
  'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import("./assets/sentry-request-fixture.js");' +
  'var {application,sentryRequestIsolationReady}=await initializeCloudflareSentryApplication(Sentry,async()=>{const kernel=await import("./assets/backend-kernel-fixture.js");kernel.requireRuntimeDatabaseClient();kernel.validateServerBuildConfig("cloudflare");const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");return createApplicationServerEntry("cloudflare")});' +
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
  write(
    root,
    '.output/node/server/index.mjs',
    'import{defineLazyEventHandler,serve}from"./_libs/h3-fixture.mjs";const route=defineLazyEventHandler(()=>import("./_chunks/ssr-renderer.mjs"));serve({fetch:route});const node_server_default={};export{node_server_default as default};'
  );
  write(
    root,
    '.output/node/server/_libs/h3-fixture.mjs',
    'export const defineLazyEventHandler=(load)=>load;export const serve=()=>{};'
  );
  write(
    root,
    '.output/node/server/_chunks/ssr-renderer.mjs',
    'const lazyService=(load)=>load;const service=lazyService(()=>import("../_ssr/ssr.mjs"));const ssrRenderer=()=>service;export{ssrRenderer as default};'
  );
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
  write(
    root,
    '.vercel/output/functions/__server.func/index.mjs',
    'import{defineLazyEventHandler}from"./_libs/h3-fixture.mjs";const route=defineLazyEventHandler(()=>import("./_chunks/ssr-renderer.mjs"));const useNitroApp=()=>({fetch:route});const nitroApp=useNitroApp();const vercel_web_default={async fetch(req,context){void context;return nitroApp.fetch(req)}};export{vercel_web_default as default};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_libs/h3-fixture.mjs',
    'export const defineLazyEventHandler=(load)=>load;'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_chunks/ssr-renderer.mjs',
    'const lazyService=(load)=>load;const service=lazyService(()=>import("../_ssr/ssr.mjs"));const ssrRenderer=()=>service;export{ssrRenderer as default};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
    'var {initVercelTelemetry,runWithVercelSentryRequestIsolation}=await import("../_libs/telemetry-owner.mjs");initVercelTelemetry();var {vercelRequestLifecycle}=await import("./request-lifecycle-fixture.mjs");var {createApplicationServerEntry}=await import("./create-application-server-entry-fixture.mjs");var server_entry_default=await createApplicationServerEntry("vercel",vercelRequestLifecycle,runWithVercelSentryRequestIsolation);export{server_entry_default as default};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_libs/telemetry-owner.mjs',
    'import{r as runWithVercelSentryRequestIsolation,t as initVercelTelemetry}from"../_ssr/telemetry-implementation.mjs";export{initVercelTelemetry,runWithVercelSentryRequestIsolation};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs',
    'import{withIsolationScope}from"../_libs/sentry__core.mjs";import{registerOTel}from"../_libs/vercel__otel.mjs";const runWithSentryNodeRequestIsolation=(operation)=>withIsolationScope(operation);const runWithVercelSentryRequestIsolation=runWithSentryNodeRequestIsolation;const runWithNormalizedOtelSdkEnvironment=(operation)=>operation();const createSentryNodeRequestContextManager=()=>({});const initializeTraceOwner=(config,contextManager)=>runWithNormalizedOtelSdkEnvironment(()=>registerOTel({config,contextManager}));const initializeSignalOwners=()=>({});const installServerTelemetry=()=>{};const initVercelTelemetry=()=>{const config={};const contextManager=createSentryNodeRequestContextManager();initializeTraceOwner(config,contextManager);initializeSignalOwners();installServerTelemetry()};export{runWithVercelSentryRequestIsolation as r,initVercelTelemetry as t};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_libs/sentry__core.mjs',
    'export const withIsolationScope=(operation)=>operation();"@sentry/core";'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_libs/vercel__otel.mjs',
    'export const registerOTel=()=>{};"@vercel/otel";'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs',
    'import{forceFlushRequestTelemetry}from"./request-completion-fixture.mjs";import{getTelemetry}from"./telemetry-fixture.mjs";import{require_functions}from"../_libs/vercel__functions.mjs";const import_functions=require_functions();const vercelRequestLifecycle={onRequestSettled(request){const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0);import_functions.waitUntil(flush)}};export{vercelRequestLifecycle};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/request-completion-fixture.mjs',
    'const forceFlushRequestTelemetry=()=>Promise.resolve();export{forceFlushRequestTelemetry};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/telemetry-fixture.mjs',
    'const getTelemetry=()=>({});export{getTelemetry};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_libs/vercel__functions.mjs',
    'export const require_functions=()=>({waitUntil(){}});"@vercel/functions";'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
    'import{reportTelemetryFailure}from"./telemetry-proxy-fixture.mjs";import{claimRequestException,createRequestExceptionCaptureState,bindRequestExceptionState}from"./request-exception-state-fixture.mjs";import{isUnexpectedRequestFailure}from"./request-failure-fixture.mjs";const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>{const{telemetryProxy}=await import("./telemetry-proxy-fixture.mjs");const tanstack=await import("./entry-server-fixture.mjs");return tanstack.createServerEntry({async fetch(request){const handleRequest=async()=>{const telemetryCaptureState=createRequestExceptionCaptureState();bindRequestExceptionState(request,telemetryCaptureState);const context={requestId:crypto.randomUUID(),runtimeProfile,telemetryCaptureState};try{return await tanstack.default.fetch(request,{context})}catch(error){if(isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error))telemetryProxy.captureException(error,{level:"error",tags:{event:"framework.request.failed",requestId:context.requestId}});throw error}finally{try{lifecycle?.onRequestSettled(request)}catch{}}};if(!requestScope)return handleRequest();let applicationResult;const runApplicationOnce=()=>{applicationResult??=handleRequest();return applicationResult};try{return requestScope(runApplicationOnce)}catch(failure){reportTelemetryFailure("sentry.request_scope",failure);return applicationResult??runApplicationOnce()}}})};export{createApplicationServerEntry};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/telemetry-proxy-fixture.mjs',
    'export const telemetryProxy={captureException(){}};export const reportTelemetryFailure=()=>{};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/request-exception-state-fixture.mjs',
    'export const claimRequestException=()=>true;export const createRequestExceptionCaptureState=()=>({});export const bindRequestExceptionState=()=>{};'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/request-failure-fixture.mjs',
    'export const isUnexpectedRequestFailure=()=>true;'
  );
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/entry-server-fixture.mjs',
    'const entry={fetch(){return new Response()}};export const createServerEntry=(value)=>value;export{entry as default};'
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
    'virtual:cloudflare/worker-entry': {
      dynamicImports: [
        'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js',
        'src/runtime/cloudflare/sentry-request.ts',
        'src/modules/kernel/backend.ts',
        'src/runtime/create-application-server-entry.ts',
        'src/platform/telemetry/index.ts',
        'src/runtime/cloudflare/telemetry-adapter.ts',
        'src/runtime/cloudflare/database-request.ts',
        'src/runtime/cloudflare/request-telemetry.ts',
        'src/runtime/cloudflare/request-lifecycle.ts',
      ],
      file: 'index.js',
      isEntry: true,
      name: 'index',
      src: 'virtual:cloudflare/worker-entry',
    },
    'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js':
      {
        file: 'assets/esm-fixture.js',
        isDynamicEntry: true,
        name: 'esm',
        src: 'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js',
      },
    'src/runtime/create-application-server-entry.ts': {
      file: 'assets/create-application-server-entry-fixture.js',
      imports: [
        '_telemetry-fixture.js',
        '_request-exception-state-fixture.js',
        '_request-failure-fixture.js',
      ],
      dynamicImports: [
        'src/platform/telemetry/index.ts',
        'src/entry-server.ts',
      ],
      isDynamicEntry: true,
      name: 'create-application-server-entry',
      src: 'src/runtime/create-application-server-entry.ts',
    },
    'src/modules/kernel/backend.ts': {
      file: 'assets/backend-kernel-fixture.js',
      imports: [
        '_auth-fixture.js',
        '_telemetry-fixture.js',
        '_client-fixture.js',
        '_runtime-fixture.js',
        '_backend-build-config-fixture.js',
        '_book-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'backend',
      src: 'src/modules/kernel/backend.ts',
    },
    '_backend-fixture.js': {
      file: 'assets/backend-fixture.js',
      imports: [],
      name: 'backend',
    },
    '_auth-fixture.js': {
      file: 'assets/auth-fixture.js',
      imports: [],
      name: 'auth',
    },
    '_backend-build-config-fixture.js': {
      file: 'assets/backend-build-config-fixture.js',
      imports: [],
      name: 'backend',
    },
    '_client-fixture.js': {
      file: 'assets/client-fixture.js',
      imports: [],
      name: 'client',
    },
    '_book-fixture.js': {
      file: 'assets/book-fixture.js',
      imports: [],
      name: 'book',
    },
    '_react-fixture.js': {
      file: 'assets/react-fixture.js',
      imports: [],
      name: 'react',
    },
    '_rolldown-runtime-fixture.js': {
      file: 'assets/rolldown-runtime-fixture.js',
      imports: [],
      name: 'rolldown-runtime',
    },
    '_runtime-fixture.js': {
      file: 'assets/runtime-fixture.js',
      imports: [],
      name: 'runtime',
    },
    '_sanitize-log-fields-fixture.js': {
      file: 'assets/sanitize-log-fields-fixture.js',
      imports: [],
      name: 'sanitize-log-fields',
    },
    '_server-fixture.js': {
      dynamicImports: [
        'tanstack-start-manifest:v',
        'src/router.tsx',
        'src/start.ts',
        fixtureEmptyPluginAdaptersSource,
      ],
      file: 'assets/server-fixture.js',
      imports: ['_createCsrfMiddleware-AAAAAAAA.js'],
      name: 'server',
    },
    '_server.edge-fixture.js': {
      file: 'assets/server.edge-fixture.js',
      imports: ['_react-dom-AAAAAAAA.js'],
      name: 'server.edge',
    },
    '_createCsrfMiddleware-AAAAAAAA.js': {
      file: 'assets/createCsrfMiddleware-AAAAAAAA.js',
      imports: ['_server-fixture.js', '_cycle-marker-AAAAAAAA.js'],
      name: 'createCsrfMiddleware',
    },
    '_cycle-marker-AAAAAAAA.js': {
      file: 'runtime/cycle-marker-AAAAAAAA.js',
      imports: [],
      name: 'cycle-marker',
    },
    [fixtureEmptyPluginAdaptersSource]: {
      file: 'assets/empty-plugin-adapters-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'empty-plugin-adapters',
      src: fixtureEmptyPluginAdaptersSource,
    },
    'src/router.tsx': {
      file: 'assets/router-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'router',
      src: 'src/router.tsx',
    },
    'src/start.ts': {
      file: 'assets/start-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'start',
      src: 'src/start.ts',
    },
    'tanstack-start-manifest:v': {
      file: 'assets/tanstack-start-manifest-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'tanstack-start-manifest',
      src: 'tanstack-start-manifest:v',
    },
    '_react-dom-AAAAAAAA.js': {
      file: 'assets/react-dom-AAAAAAAA.js',
      imports: [],
      name: 'react-dom',
    },
    '_structured-console-fixture.js': {
      file: 'assets/structured-console-fixture.js',
      imports: [],
      name: 'structured-console',
    },
    '_tags-fixture.js': {
      file: 'assets/tags-fixture.js',
      imports: [],
      name: 'tags',
    },
    '_request-completion-fixture.js': {
      file: 'assets/request-completion-fixture.js',
      imports: ['_telemetry-fixture.js'],
      name: 'request-completion',
    },
    '_request-exception-state-fixture.js': {
      file: 'assets/request-exception-state-fixture.js',
      imports: [],
      name: 'request-exception-state',
    },
    '_request-failure-fixture.js': {
      file: 'assets/request-failure-fixture.js',
      imports: [],
      name: 'request-failure',
    },
    '_telemetry-fixture.js': {
      file: 'assets/telemetry-fixture.js',
      imports: [],
      name: 'telemetry',
    },
    'src/entry-server.ts': {
      file: 'assets/entry-server-fixture.js',
      imports: [
        '_rolldown-runtime-fixture.js',
        '_react-fixture.js',
        '_server-fixture.js',
        '_server.edge-fixture.js',
        '_telemetry-fixture.js',
        '_request-completion-fixture.js',
        '_request-exception-state-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'entry-server',
      src: 'src/entry-server.ts',
    },
    'src/platform/telemetry/index.ts': {
      file: 'assets/telemetry-entry-fixture.js',
      imports: [
        '_tags-fixture.js',
        '_telemetry-fixture.js',
        '_request-completion-fixture.js',
        '_request-exception-state-fixture.js',
        '_structured-console-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'telemetry',
      src: 'src/platform/telemetry/index.ts',
    },
    'src/runtime/cloudflare/database-request.ts': {
      file: 'assets/database-request-fixture.js',
      imports: [
        '_client-fixture.js',
        '_backend-fixture.js',
        '_telemetry-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'database-request',
      src: 'src/runtime/cloudflare/database-request.ts',
    },
    'src/runtime/cloudflare/request-lifecycle.ts': {
      file: 'assets/request-lifecycle-fixture.js',
      imports: ['_telemetry-fixture.js', '_request-completion-fixture.js'],
      isDynamicEntry: true,
      name: 'request-lifecycle',
      src: 'src/runtime/cloudflare/request-lifecycle.ts',
    },
    'src/runtime/cloudflare/request-telemetry.ts': {
      file: 'assets/request-telemetry-fixture.js',
      imports: [
        '_tags-fixture.js',
        '_sanitize-log-fields-fixture.js',
        '_telemetry-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'request-telemetry',
      src: 'src/runtime/cloudflare/request-telemetry.ts',
    },
    'src/runtime/cloudflare/sentry-request.ts': {
      file: 'assets/sentry-request-fixture.js',
      imports: ['_telemetry-fixture.js', '_request-completion-fixture.js'],
      isDynamicEntry: true,
      name: 'sentry-request',
      src: 'src/runtime/cloudflare/sentry-request.ts',
    },
    'src/runtime/cloudflare/telemetry-adapter.ts': {
      file: 'assets/telemetry-adapter-fixture.js',
      imports: ['_telemetry-fixture.js', '_structured-console-fixture.js'],
      isDynamicEntry: true,
      name: 'telemetry-adapter',
      src: 'src/runtime/cloudflare/telemetry-adapter.ts',
    },
  });
  write(
    root,
    'dist/server/index.js',
    `${cloudflareRuntimeOwners}var worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{${cloudflareRequestFlush}}}};export{worker_entry_default as default};`
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
    'import{toTelemetryStringTags}from"./tags-fixture.js";import{sanitizeLogFields}from"./sanitize-log-fields-fixture.js";import{reportTelemetryFailure,setTelemetry}from"./telemetry-fixture.js";const createCloudflareSentryOptions=()=>({});const createSentryTelemetryAdapter=()=>({});const createTelemetryAdapterChain=()=>({});const configureCloudflareRequestTelemetry=({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>{setTelemetry(nativeTelemetry);if(!environment.SENTRY_DSN||!sentryRequestIsolationReady){return{}}try{const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});setTelemetry(createTelemetryAdapterChain([nativeTelemetry,sentryTelemetry]));return{sentryOptions}}catch(failure){reportTelemetryFailure("sentry.cloudflare.configure",failure);return{}}};export{configureCloudflareRequestTelemetry};'
  );
  write(
    root,
    'dist/server/assets/request-lifecycle-fixture.js',
    'import{getTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";const scheduleCloudflareRequestFlush=(request,waitUntil)=>{const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0);try{waitUntil(flush)}catch(failure){reportTelemetryFailure("otel.cloudflare.wait_until",failure)}};export{scheduleCloudflareRequestFlush};'
  );
  write(
    root,
    'dist/server/assets/telemetry-entry-fixture.js',
    'import"./tags-fixture.js";import{createNoOpTelemetry,reportTelemetryFailure,telemetryProxy}from"./telemetry-fixture.js";import"./request-completion-fixture.js";import"./request-exception-state-fixture.js";import"./structured-console-fixture.js";export{createNoOpTelemetry,reportTelemetryFailure,telemetryProxy};'
  );
  write(
    root,
    'dist/server/assets/telemetry-adapter-fixture.js',
    'import"./telemetry-fixture.js";import{writeStructuredConsoleLog}from"./structured-console-fixture.js";const createCloudflareTelemetryAdapter=()=>({});export{createCloudflareTelemetryAdapter};'
  );
  write(
    root,
    'dist/server/assets/create-application-server-entry-fixture.js',
    'import{reportTelemetryFailure}from"./telemetry-fixture.js";import{n as claimRequestException,r as createRequestExceptionCaptureState,t as bindRequestExceptionState}from"./request-exception-state-fixture.js";import{t as isUnexpectedRequestFailure}from"./request-failure-fixture.js";const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>{const{telemetryProxy}=await import("./telemetry-entry-fixture.js");const tanstack=await import("./entry-server-fixture.js");return tanstack.createServerEntry({async fetch(request){const handleRequest=async()=>{const telemetryCaptureState=createRequestExceptionCaptureState();bindRequestExceptionState(request,telemetryCaptureState);const context={requestId:crypto.randomUUID(),runtimeProfile,telemetryCaptureState};try{return await tanstack.default.fetch(request,{context})}catch(error){if(isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error))telemetryProxy.captureException(error,{level:"error",tags:{event:"framework.request.failed",requestId:context.requestId}});throw error}finally{try{lifecycle?.onRequestSettled(request)}catch{}}};if(!requestScope)return handleRequest();let applicationResult;const runApplicationOnce=()=>{applicationResult??=handleRequest();return applicationResult};try{return requestScope(runApplicationOnce)}catch(failure){reportTelemetryFailure("sentry.request_scope",failure);return applicationResult??runApplicationOnce()}}})};export{createApplicationServerEntry};'
  );
  write(
    root,
    'dist/server/assets/entry-server-fixture.js',
    'import{__toESM}from"./rolldown-runtime-fixture.js";import{require_react}from"./react-fixture.js";import{createSsrStreamResponse,createStartHandler,defineHandlerCallback,isbot,StartServer,transformReadableStreamWithRouter}from"./server-fixture.js";import{require_server_edge}from"./server.edge-fixture.js";import"./telemetry-fixture.js";import{n as registerRequestCompletion}from"./request-completion-fixture.js";import{r as createRequestExceptionCaptureState,getRequestExceptionState}from"./request-exception-state-fixture.js";const import_react=__toESM(require_react(),1);const import_server_edge=__toESM(require_server_edge(),1);const noop=()=>{};const isAbortError=()=>false;const waitForReadyOrAbort=async()=>{};const observedStreamHandler=defineHandlerCallback(async({request,responseHeaders,router})=>{const exceptionCaptureState=getRequestExceptionState(request)??createRequestExceptionCaptureState();const stream=await import_server_edge.renderToReadableStream(import_react.createElement(StartServer,{router}));registerRequestCompletion(request,stream);if(isbot(request.headers.get("user-agent")))await waitForReadyOrAbort(stream,request.signal);const responseStream=transformReadableStreamWithRouter(router,stream);const response=new Response(responseStream,{headers:responseHeaders,status:router.stores.statusCode.get()});return createSsrStreamResponse(router,response)});const entry={fetch:createStartHandler(observedStreamHandler)};const createServerEntry=(serverEntry)=>serverEntry;export{createServerEntry,entry as default};'
  );
  write(
    root,
    'dist/server/assets/client-fixture.js',
    'const createHyperdriveDbClient=()=>({});const requireRuntimeDatabaseClient=()=>{};const runWithRuntimeDatabaseClient=(_database,handle)=>handle();export{createHyperdriveDbClient,requireRuntimeDatabaseClient,runWithRuntimeDatabaseClient};'
  );
  write(
    root,
    'dist/server/assets/backend-fixture.js',
    'const validateServerConfig=()=>{};export{validateServerConfig};'
  );
  write(
    root,
    'dist/server/assets/backend-kernel-fixture.js',
    'import"./auth-fixture.js";import"./telemetry-fixture.js";import{requireRuntimeDatabaseClient}from"./client-fixture.js";import"./runtime-fixture.js";import{validateServerBuildConfig}from"./backend-build-config-fixture.js";import"./book-fixture.js";export{requireRuntimeDatabaseClient,validateServerBuildConfig};'
  );
  write(
    root,
    'dist/server/assets/backend-build-config-fixture.js',
    'const validateServerBuildConfig=()=>{};export{validateServerBuildConfig};'
  );
  write(
    root,
    'dist/server/assets/request-exception-state-fixture.js',
    'const claimRequestException=()=>true;const createRequestExceptionCaptureState=()=>({});const bindRequestExceptionState=()=>{};const getRequestExceptionState=()=>{};export{claimRequestException as n,createRequestExceptionCaptureState as r,bindRequestExceptionState as t,getRequestExceptionState};'
  );
  write(
    root,
    'dist/server/assets/request-failure-fixture.js',
    'const isUnexpectedRequestFailure=()=>true;export{isUnexpectedRequestFailure as t};'
  );
  write(
    root,
    'dist/server/assets/request-completion-fixture.js',
    'import{reportTelemetryFailure}from"./telemetry-fixture.js";const forceFlushRequestTelemetry=()=>Promise.resolve();const registerRequestCompletion=()=>{};const snapshotRequestCompletions=()=>[];export{forceFlushRequestTelemetry,registerRequestCompletion as n,snapshotRequestCompletions as r};'
  );
  write(
    root,
    'dist/server/assets/telemetry-fixture.js',
    'const createNoOpTelemetry=()=>({});const getTelemetry=()=>({});const reportTelemetryFailure=()=>{};const setTelemetry=()=>{};const telemetryProxy={};export{createNoOpTelemetry,getTelemetry,reportTelemetryFailure,setTelemetry,telemetryProxy};'
  );
  write(
    root,
    'dist/server/assets/rolldown-runtime-fixture.js',
    'const __toESM=(value)=>value;export{__toESM};'
  );
  write(
    root,
    'dist/server/assets/react-fixture.js',
    'const require_react=()=>({});export{require_react};'
  );
  write(
    root,
    'dist/server/assets/server-fixture.js',
    'import{createCsrfMiddleware}from"./createCsrfMiddleware-AAAAAAAA.js";const loadOwners=()=>Promise.all([import("./tanstack-start-manifest-AAAAAAAA.js"),import("./router-AAAAAAAA.js"),import("./start-AAAAAAAA.js"),import("./empty-plugin-adapters-AAAAAAAA.js")]);const createSsrStreamResponse=(_router,response)=>response;const createStartHandler=(handler)=>handler;const defineHandlerCallback=(handler)=>handler;const isbot=()=>false;const StartServer=()=>{};const transformReadableStreamWithRouter=(stream)=>stream;export{createSsrStreamResponse,createStartHandler,defineHandlerCallback,isbot,StartServer,transformReadableStreamWithRouter};'
  );
  write(
    root,
    'dist/server/assets/server.edge-fixture.js',
    'import{renderToReadableStream}from"./react-dom-AAAAAAAA.js";const require_server_edge=()=>({renderToReadableStream});export{require_server_edge};'
  );
  write(
    root,
    'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js',
    'import"node:stream";import"./server-fixture.js";export{serverCycleMarker}from"../runtime/cycle-marker-AAAAAAAA.js";const createCsrfMiddleware=()=>{};export{createCsrfMiddleware};'
  );
  write(
    root,
    'dist/server/runtime/cycle-marker-AAAAAAAA.js',
    'const serverCycleMarker=true;export{serverCycleMarker};'
  );
  write(
    root,
    'dist/server/assets/empty-plugin-adapters-AAAAAAAA.js',
    'const emptyPluginAdapter=true;export{emptyPluginAdapter};'
  );
  write(
    root,
    'dist/server/assets/router-AAAAAAAA.js',
    'const getRouterCspNonce=()=>undefined;function getRouter(){const cspNonce=getRouterCspNonce();return{cspNonce}}export{getRouter};'
  );
  write(
    root,
    'dist/server/assets/start-AAAAAAAA.js',
    'const startInstance={};export{startInstance};'
  );
  write(
    root,
    'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
    'const tsrStartManifest=()=>({routes:{}});export{tsrStartManifest};'
  );
  write(
    root,
    'dist/server/assets/react-dom-AAAAAAAA.js',
    'const renderToReadableStream=()=>new ReadableStream();export{renderToReadableStream};'
  );
  write(
    root,
    'dist/server/assets/tags-fixture.js',
    'const toTelemetryStringTags=()=>({});export{toTelemetryStringTags};'
  );
  write(
    root,
    'dist/server/assets/sanitize-log-fields-fixture.js',
    'const sanitizeLogFields=()=>({});export{sanitizeLogFields};'
  );
  write(
    root,
    'dist/server/assets/structured-console-fixture.js',
    'const writeStructuredConsoleLog=()=>{};export{writeStructuredConsoleLog};'
  );
  for (const emptyChunk of ['auth', 'book', 'runtime']) {
    write(root, `dist/server/assets/${emptyChunk}-fixture.js`);
  }
  fs.mkdirSync(path.join(root, 'dist/client'));
};

const cloudflareV5EntrySource =
  'var {initializeCloudflareTelemetryRequestScope,runWithCloudflareTelemetry}=await import("./assets/telemetry-request-scope-fixture.js");' +
  'initializeCloudflareTelemetryRequestScope();' +
  'var Sentry=await import("./assets/esm-fixture.js");' +
  'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import("./assets/sentry-request-fixture.js");' +
  'var {application,sentryRequestIsolationReady}=await initializeCloudflareSentryApplication(Sentry,async()=>{const kernel=await import("./assets/backend-kernel-fixture.js");kernel.requireRuntimeDatabaseClient();kernel.validateServerBuildConfig("cloudflare");const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");return createApplicationServerEntry("cloudflare")});' +
  'var {tracing}=await import("cloudflare:workers");' +
  'var {runWithCloudflareDatabase}=await import("./assets/database-request-fixture.js");' +
  'var {configureCloudflareRequestTelemetry}=await import("./assets/request-telemetry-fixture.js");' +
  'var {scheduleCloudflareRequestFlush}=await import("./assets/request-lifecycle-fixture.js");' +
  'const fetchCloudflareApplication=({context,handle,request,requireSentryOwner,sentryOptions})=>sentryOptions?runWithCloudflareSentry({api:Sentry,handle,request,requireSentryOwner,requestOptions:{captureErrors:false,context,options:sentryOptions,request}}):handle();' +
  'var worker_entry_default={async fetch(request,environment,context){const {requireSentryOwner,sentryOptions,telemetry}=configureCloudflareRequestTelemetry({environment,request,sentry:Sentry,sentryRequestIsolationReady,tracing});const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try{return await runWithCloudflareTelemetry(telemetry,()=>fetchCloudflareApplication({context,handle:handleDatabase,request,requireSentryOwner,sentryOptions}))}finally{scheduleCloudflareRequestFlush(request,telemetry,(completion)=>context.waitUntil(completion))}}};' +
  'export{worker_entry_default as default};';

const createCloudflareV5Artifact = (root) => {
  createCloudflareArtifact(root);
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['virtual:cloudflare/worker-entry'].dynamicImports = [
    'src/runtime/cloudflare/telemetry-request-scope.ts',
    'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js',
    'src/runtime/cloudflare/sentry-request.ts',
    'src/modules/kernel/backend.ts',
    'src/runtime/create-application-server-entry.ts',
    'src/runtime/cloudflare/database-request.ts',
    'src/runtime/cloudflare/request-telemetry.ts',
    'src/runtime/cloudflare/request-lifecycle.ts',
  ];
  manifest['src/modules/kernel/backend.ts'].imports = [
    '_auth-fixture.js',
    '_telemetry-fixture.js',
    '_client-database-fixture.js',
    '_client-environment-fixture.js',
    '_runtime-fixture.js',
    '_backend-build-config-fixture.js',
    '_book-fixture.js',
  ];
  manifest['_client-database-fixture.js'] = {
    file: 'assets/client-database-fixture.js',
    imports: [],
    name: 'client-database',
  };
  manifest['_client-environment-fixture.js'] = {
    file: 'assets/client-environment-fixture.js',
    imports: [],
    name: 'client-environment',
  };
  manifest['_backend-request-config-fixture.js'] = {
    file: 'assets/backend-request-config-fixture.js',
    imports: [],
    name: 'backend-request-config',
  };
  manifest['src/runtime/cloudflare/telemetry-request-scope.ts'] = {
    file: 'assets/telemetry-request-scope-fixture.js',
    imports: ['_telemetry-fixture.js'],
    isDynamicEntry: true,
    name: 'telemetry-request-scope',
    src: 'src/runtime/cloudflare/telemetry-request-scope.ts',
  };
  manifest['src/runtime/cloudflare/request-telemetry.ts'].imports = [
    '_telemetry-fixture.js',
    '_sanitize-log-fields-fixture.js',
    '_backend-request-config-fixture.js',
    'src/runtime/cloudflare/telemetry-adapter.ts',
  ];
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);

  write(root, 'dist/server/index.js', cloudflareV5EntrySource);
  write(
    root,
    'dist/server/assets/backend-kernel-fixture.js',
    'import"./auth-fixture.js";import"./telemetry-fixture.js";import{requireRuntimeDatabaseClient}from"./client-database-fixture.js";import"./client-environment-fixture.js";import"./runtime-fixture.js";import{validateServerBuildConfig}from"./backend-build-config-fixture.js";import"./book-fixture.js";export{requireRuntimeDatabaseClient,validateServerBuildConfig};'
  );
  write(
    root,
    'dist/server/assets/client-database-fixture.js',
    'const requireRuntimeDatabaseClient=()=>{};export{requireRuntimeDatabaseClient};'
  );
  write(root, 'dist/server/assets/client-environment-fixture.js');
  write(
    root,
    'dist/server/assets/backend-request-config-fixture.js',
    'const parseRequestTelemetryConfig=()=>({});const assertRequiredTelemetrySignals=()=>{};const createTelemetrySignalReadiness=()=>({});const isTelemetrySignalRequired=()=>false;export{assertRequiredTelemetrySignals,createTelemetrySignalReadiness,isTelemetrySignalRequired,parseRequestTelemetryConfig};'
  );
  write(
    root,
    'dist/server/assets/telemetry-request-scope-fixture.js',
    'import{installTelemetryScopeResolver}from"./telemetry-fixture.js";import{AsyncLocalStorage}from"node:async_hooks";const requestTelemetryStorage=new AsyncLocalStorage();const initializeCloudflareTelemetryRequestScope=()=>{installTelemetryScopeResolver(()=>requestTelemetryStorage.getStore())};const runWithCloudflareTelemetry=(telemetry,handle)=>requestTelemetryStorage.run(telemetry,handle);export{initializeCloudflareTelemetryRequestScope,runWithCloudflareTelemetry};'
  );
  write(
    root,
    'dist/server/assets/telemetry-adapter-fixture.js',
    'import"./telemetry-fixture.js";import{writeStructuredConsoleLog}from"./structured-console-fixture.js";const createCloudflareSentryOptions=()=>({});const createCloudflareTelemetryAdapter=()=>({});const isCloudflareAnalyticsEngine=()=>true;const isCloudflareTracing=()=>true;export{createCloudflareSentryOptions,createCloudflareTelemetryAdapter,isCloudflareAnalyticsEngine,isCloudflareTracing};'
  );
  write(
    root,
    'dist/server/assets/request-telemetry-fixture.js',
    'import{createNoOpTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";import{sanitizeLogFields}from"./sanitize-log-fields-fixture.js";import{assertRequiredTelemetrySignals,createTelemetrySignalReadiness,isTelemetrySignalRequired,parseRequestTelemetryConfig}from"./backend-request-config-fixture.js";import{createCloudflareSentryOptions,createCloudflareTelemetryAdapter,isCloudflareAnalyticsEngine,isCloudflareTracing}from"./telemetry-adapter-fixture.js";const configureCloudflareRequestTelemetry=({environment,request,sentry,sentryRequestIsolationReady,tracing})=>{const config=parseRequestTelemetryConfig(environment);const fallback=createNoOpTelemetry();const analyticsReady=isCloudflareAnalyticsEngine(environment.START_UI_TELEMETRY_METRICS);const tracingReady=isCloudflareTracing(tracing);const telemetry=createCloudflareTelemetryAdapter({});const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const readiness=createTelemetrySignalReadiness({exceptions:sentryRequestIsolationReady,logs:true,metrics:analyticsReady,traces:tracingReady});assertRequiredTelemetrySignals({config,readiness});const requireSentryOwner=isTelemetrySignalRequired(config,"exceptions");void fallback;void sanitizeLogFields;void reportTelemetryFailure;return{requireSentryOwner,sentryOptions,telemetry}};export{configureCloudflareRequestTelemetry};'
  );
  write(
    root,
    'dist/server/assets/request-lifecycle-fixture.js',
    'import{reportTelemetryFailure}from"./telemetry-fixture.js";import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";const scheduleCloudflareRequestFlush=(request,telemetry,waitUntil)=>{const flush=forceFlushRequestTelemetry(request,telemetry).then(()=>void 0);try{waitUntil(flush)}catch(failure){reportTelemetryFailure("otel.cloudflare.wait_until",failure)}};export{scheduleCloudflareRequestFlush};'
  );
  const sentryPath = path.join(
    root,
    'dist/server/assets/sentry-request-fixture.js'
  );
  write(
    root,
    'dist/server/assets/sentry-request-fixture.js',
    fs
      .readFileSync(sentryPath, 'utf8')
      .replace(
        'async({api,handle,request,requestOptions})=>',
        'async({api,handle,request,requestOptions,requireSentryOwner})=>'
      )
      .replace(
        'reportTelemetryFailure("sentry.cloudflare.request",failure)}if(applicationOutcome',
        'reportTelemetryFailure("sentry.cloudflare.request",failure);if(requireSentryOwner&&applicationWork===void 0)throw failure}if(applicationOutcome'
      )
  );
  write(
    root,
    'dist/server/assets/telemetry-fixture.js',
    'const createNoOpTelemetry=()=>({});const installTelemetryScopeResolver=()=>{};const reportTelemetryFailure=()=>{};const telemetryProxy={};export{createNoOpTelemetry,installTelemetryScopeResolver,reportTelemetryFailure,telemetryProxy};'
  );
};

const verifyCloudflareV5Fixture = (root) => {
  writeFixtureCloudflareProvenance(root);
  return verifyRuntimeProfileImplementation('cloudflare', root, {
    cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
    cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
    expectedAppSlug: 'acme-app',
  });
};

const replaceCloudflareV5FixtureSource = (
  root,
  relativePath,
  search,
  replacement
) => {
  const fixturePath = path.join(root, relativePath);
  const source = fs.readFileSync(fixturePath, 'utf8');
  if (!source.includes(search)) {
    throw new Error(`Cloudflare v5 fixture source is missing ${search}`);
  }
  write(root, relativePath, source.replace(search, replacement));
};

const replaceEveryCloudflareV5FixtureSource = (
  root,
  relativePath,
  search,
  replacement
) => {
  const fixturePath = path.join(root, relativePath);
  const source = fs.readFileSync(fixturePath, 'utf8');
  if (!source.includes(search)) {
    throw new Error(`Cloudflare v5 fixture source is missing ${search}`);
  }
  write(root, relativePath, source.replaceAll(search, replacement));
};

const mutateCloudflareV5FixtureManifest = (root, mutate) => {
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mutate(manifest);
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
};

const cloudflareV5VerificationFailure = (root) => {
  let failure;
  try {
    verifyCloudflareV5Fixture(root);
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof Error)) {
    throw new Error('Expected Cloudflare v5 artifact verification to fail');
  }
  return failure;
};

const addCloudflareSinkModule = (root, source) => {
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['src/start.ts'].imports = ['_sink-AAAAAAAA.js'];
  manifest['_sink-AAAAAAAA.js'] = {
    file: 'assets/sink-AAAAAAAA.js',
    imports: [],
    name: 'sink',
  };
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  write(root, 'dist/server/assets/sink-AAAAAAAA.js', source);
};

const addCloudflareLoadEffectCycle = (root, size) => {
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fileName = (index) =>
    `load-effect-cycle-${String(index).padStart(4, '0')}.js`;
  const manifestKey = (index) =>
    `_load-effect-cycle-${String(index).padStart(4, '0')}.js`;
  manifest['src/start.ts'].imports = [manifestKey(0)];
  write(
    root,
    'dist/server/assets/start-AAAAAAAA.js',
    `import"./${fileName(0)}";const startInstance={};export{startInstance};`
  );
  for (let index = 0; index < size; index += 1) {
    const next = (index + 1) % size;
    manifest[manifestKey(index)] = {
      file: `assets/${fileName(index)}`,
      imports: [manifestKey(next)],
      name: `load-effect-cycle-${index}`,
    };
    write(
      root,
      `dist/server/assets/${fileName(index)}`,
      `import{step as next}from"./${fileName(next)}";const step=()=>{};next();export{step};`
    );
    markFixtureAppOwnedChunk(root, `assets/${fileName(index)}`, [
      `src/load-effect-cycle/${index}.ts`,
    ]);
  }
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
};

const addCloudflareRouterEffectModule = (
  root,
  caller,
  owner,
  modules = ['src/router-effect.ts']
) => {
  const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
  const routerPath = path.join(root, routerRelativePath);
  write(
    root,
    routerRelativePath,
    `${caller}${fs.readFileSync(routerPath, 'utf8')}`
  );
  write(root, 'dist/server/assets/router-effect-AAAAAAAA.js', owner);
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['_router-effect-AAAAAAAA.js'] = {
    file: 'assets/router-effect-AAAAAAAA.js',
    imports: [],
    name: 'router-effect',
  };
  manifest['src/router.tsx'].imports = ['_router-effect-AAAAAAAA.js'];
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  if (modules) {
    markFixtureAppOwnedChunk(root, 'assets/router-effect-AAAAAAAA.js', modules);
  }
};

const reviewedAggregateSinkPolicy = Object.freeze({
  exportedLocalName: 'useRenderElement',
  exportedName: 'c',
  exportedParameterIndex: 2,
  propertyName: 'stateAttributesMapping',
  reason:
    'The fixture sink reads the exact aggregate property without retaining or mutating it.',
});

const createReviewedAggregateSinkArtifact = ({
  consumerSource,
  ownerSource,
  sinkSource = 'function useRenderElement(_element,_props,params={}){void params.stateAttributesMapping;return null}export{useRenderElement as c};',
}) => {
  const root = fixture();
  createCloudflareArtifact(root);
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['_aggregate-sink-AAAAAAAA.js'] = {
    file: 'assets/aggregate-sink-AAAAAAAA.js',
    imports: [],
    name: 'aggregate-sink',
  };
  manifest['_aggregate-owner-AAAAAAAA.js'] = {
    file: 'assets/aggregate-owner-AAAAAAAA.js',
    imports: ['_aggregate-sink-AAAAAAAA.js'],
    name: 'aggregate-owner',
  };
  manifest['_aggregate-consumer-AAAAAAAA.js'] = {
    file: 'assets/aggregate-consumer-AAAAAAAA.js',
    imports: ['_aggregate-owner-AAAAAAAA.js', '_aggregate-sink-AAAAAAAA.js'],
    name: 'aggregate-consumer',
  };
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  write(root, 'dist/server/assets/aggregate-sink-AAAAAAAA.js', sinkSource);
  write(root, 'dist/server/assets/aggregate-owner-AAAAAAAA.js', ownerSource);
  write(
    root,
    'dist/server/assets/aggregate-consumer-AAAAAAAA.js',
    consumerSource
  );
  writeFixtureCloudflareProvenance(root);
  return root;
};

const inspectReviewedAggregateSinkArtifact = (root) =>
  inspectCloudflareReviewedAggregateArtifactProofForTesting(
    root,
    'assets/aggregate-consumer-AAAAAAAA.js',
    'assets/aggregate-sink-AAAAAAAA.js',
    fixtureCloudflareProvenanceKey,
    reviewedAggregateSinkPolicy
  );

const createImportedStaticPrimitiveArtifact = ({
  consumerSource,
  extraConsumerSources = [],
  ownerSource,
}) => {
  const root = fixture();
  createCloudflareArtifact(root);
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['_primitive-owner-AAAAAAAA.js'] = {
    file: 'assets/primitive-owner-AAAAAAAA.js',
    imports: [],
    name: 'primitive-owner',
  };
  manifest['_primitive-consumer-AAAAAAAA.js'] = {
    file: 'assets/primitive-consumer-AAAAAAAA.js',
    imports: ['_primitive-owner-AAAAAAAA.js'],
    name: 'primitive-consumer',
  };
  extraConsumerSources.forEach((_source, index) => {
    manifest[`_primitive-extra-${String(index)}-AAAAAAAA.js`] = {
      file: `assets/primitive-extra-${String(index)}-AAAAAAAA.js`,
      imports: ['_primitive-owner-AAAAAAAA.js'],
      name: `primitive-extra-${String(index)}`,
    };
  });
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  write(root, 'dist/server/assets/primitive-owner-AAAAAAAA.js', ownerSource);
  write(
    root,
    'dist/server/assets/primitive-consumer-AAAAAAAA.js',
    consumerSource
  );
  extraConsumerSources.forEach((source, index) =>
    write(
      root,
      `dist/server/assets/primitive-extra-${String(index)}-AAAAAAAA.js`,
      source
    )
  );
  writeFixtureCloudflareProvenance(root);
  return root;
};

const inspectImportedStaticPrimitiveArtifact = (root, expressionSource) =>
  inspectCloudflareImportedStaticPrimitiveMembersForTesting(
    root,
    'assets/primitive-consumer-AAAAAAAA.js',
    expressionSource,
    fixtureCloudflareProvenanceKey
  );

const reviewedStaticMemberNullishPolicy = Object.freeze({
  exportedLocalName: 'zu',
  exportedName: 'M',
  memberPath: ['fieldText', 'nullish'],
  reason: 'The fixture helper returns an inert nullish schema.',
  returnedPath: [],
});

const reviewedStaticMemberRequiredPolicy = Object.freeze({
  exportedLocalName: 'zu',
  exportedName: 'M',
  memberPath: ['fieldText', 'required'],
  reason: 'The fixture helper returns an inert required schema.',
  returnedPath: [],
});

const reviewedStaticMemberPipePolicy = Object.freeze({
  exportedLocalName: 'zu',
  exportedName: 'M',
  memberPath: ['fieldText', 'required'],
  reason: 'The fixture helper returns an inert schema for an exact pipe call.',
  returnedPath: ['pipe', { callResult: true }],
});

const createReviewedStaticMemberArtifact = ({
  consumerSource,
  extraConsumerSources = [],
  ownerSource = 'const zu={fieldText:{evil:()=>({}),nullish:options=>({options}),required:options=>({options})}};export{zu as M};',
}) => {
  const root = fixture();
  createCloudflareArtifact(root);
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['_static-member-owner-AAAAAAAA.js'] = {
    file: 'assets/static-member-owner-AAAAAAAA.js',
    imports: [],
    name: 'static-member-owner',
  };
  manifest['_static-member-consumer-AAAAAAAA.js'] = {
    file: 'assets/static-member-consumer-AAAAAAAA.js',
    imports: ['_static-member-owner-AAAAAAAA.js'],
    name: 'static-member-consumer',
  };
  extraConsumerSources.forEach((_source, index) => {
    manifest[`_static-member-extra-${String(index)}-AAAAAAAA.js`] = {
      file: `assets/static-member-extra-${String(index)}-AAAAAAAA.js`,
      imports: ['_static-member-owner-AAAAAAAA.js'],
      name: `static-member-extra-${String(index)}`,
    };
  });
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  write(
    root,
    'dist/server/assets/static-member-owner-AAAAAAAA.js',
    ownerSource
  );
  write(
    root,
    'dist/server/assets/static-member-consumer-AAAAAAAA.js',
    consumerSource
  );
  extraConsumerSources.forEach((source, index) =>
    write(
      root,
      `dist/server/assets/static-member-extra-${String(index)}-AAAAAAAA.js`,
      source
    )
  );
  writeFixtureCloudflareProvenance(root);
  return root;
};

const inspectReviewedStaticMemberArtifact = (
  root,
  expressionSource,
  policy = reviewedStaticMemberPipePolicy
) =>
  inspectCloudflareReviewedStaticMemberDeferredResultForTesting(
    root,
    'assets/static-member-owner-AAAAAAAA.js',
    'assets/static-member-consumer-AAAAAAAA.js',
    expressionSource,
    fixtureCloudflareProvenanceKey,
    policy
  );

const emittedStartOwnerClosure = (root) =>
  emittedReviewDigest(() =>
    verifyRuntimeProfile('cloudflare', root, {
      expectedAppSlug: 'acme-app',
    })
  );

const expectStartOwnerSubstitutionRejected = (root, startOwnerClosure) => {
  expect(() =>
    verifyRuntimeProfile('cloudflare', root, {
      cloudflareTanStackOwnerDigests: {
        ...fixtureTanStackOwnerDigests,
        startOwnerClosure,
      },
      expectedAppSlug: 'acme-app',
    })
  ).toThrow('must use the reviewed startInstance artifact owner closure');
};

const reviewedExportMutationPolicy = Object.freeze({
  expectedConsumerCount: 4,
  expectedMutationMembers: [
    'activeTriggerElement',
    'activeTriggerId',
    'preventUnmountingOnClose',
    'preventUnmountingOnClose',
  ],
  exportedLocalName: 'setPopupOpenState',
  exportedName: 'zt',
  exportedParameterIndex: 0,
  reason:
    'The exact fixture export mutates only its fresh receiver parameter through direct calls.',
});

const reviewedExportMutationOwnerSource =
  'function setPopupOpenState(store){store.activeTriggerElement=null;store.activeTriggerId=null;store.preventUnmountingOnClose=true;store.preventUnmountingOnClose=false}setPopupOpenState({});export{setPopupOpenState as zt};';

const reviewedExportArtifactOwnerSource =
  'function setPopupOpenState(store){store.activeTriggerElement=null;store.activeTriggerId=()=>fetch("https://invalid.example");store.preventUnmountingOnClose=true;store.preventUnmountingOnClose=false}export{setPopupOpenState as zt};';

const createReviewedExportArtifactFixture = (
  consumers,
  expectedConsumerCount
) => {
  const root = fs.realpathSync(fixture());
  const ownerArtifactFile = 'assets/reviewed-owner.js';
  write(root, 'dist/server/index.js', 'void 0;');
  write(
    root,
    `dist/server/${ownerArtifactFile}`,
    reviewedExportArtifactOwnerSource
  );
  consumers.forEach(({ file, source }) =>
    write(root, `dist/server/${file}`, source)
  );
  writeJson(root, 'dist/server/.vite/manifest.json', {
    entry: {
      file: 'index.js',
      imports: [],
      isEntry: true,
      name: 'entry',
      src: 'src/entry-server.ts',
    },
    owner: {
      file: ownerArtifactFile,
      imports: [],
      name: 'reviewed-owner',
      src: 'src/reviewed-owner.ts',
    },
    ...Object.fromEntries(
      consumers.map(({ file, importsOwner = false }, index) => [
        `consumer-${String(index)}`,
        {
          file,
          imports: importsOwner ? ['owner'] : [],
          name: `consumer-${String(index)}`,
          src: `src/consumer-${String(index)}.ts`,
        },
      ])
    ),
  });
  writeFixtureCloudflareProvenance(root);
  return {
    ownerArtifactFile,
    policy: {
      ...reviewedExportMutationPolicy,
      expectedConsumerCount,
    },
    root,
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fixtureAppOwnedModules.delete(directory);
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('runtime artifact verifier', { timeout: 15_000 }, () => {
  it('preserves parser AST JSON digest semantics without recursion', () => {
    const representative = {
      body: [
        {
          end: 42,
          raw: 'ignored',
          start: 7,
          type: 'Literal',
          value: 9n,
        },
        undefined,
        Number.NaN,
      ],
      enabled: true,
      loc: { ignored: true },
      name: 'fixture',
    };
    const expected = createHash('sha256')
      .update(JSON.stringify(representative, referenceAstDigestReplacer))
      .digest('hex');

    expect(inspectAstDigestForTesting(representative)).toBe(expected);
  });

  it('rejects exotic AST digest objects without invoking hooks', () => {
    const toJSON = vi.fn(() => ({ type: 'Identifier' }));
    const exotic = Object.create(Date.prototype);
    exotic.toJSON = toJSON;

    expect(() => inspectAstDigestForTesting(exotic)).toThrow(
      'AST digest input must contain only parser-owned plain data'
    );
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('preserves OXC regex literal digest semantics', () => {
    const program = parseSync('regex.fixture.js', 'const value=/abc/gu;', {
      sourceType: 'module',
    }).program;
    const expected = createHash('sha256')
      .update(JSON.stringify(program, referenceAstDigestReplacer))
      .digest('hex');

    expect(inspectAstDigestForTesting(program)).toBe(expected);
  });

  it('digests deeply nested AST projections without overflowing the stack', () => {
    let projection = { name: 'target', type: 'Identifier' };
    for (let depth = 0; depth < 20_000; depth += 1) {
      projection = {
        computed: false,
        object: projection,
        property: { name: 'value', type: 'Identifier' },
        type: 'MemberExpression',
      };
    }

    expect(inspectAstDigestForTesting(projection)).toMatch(/^[a-f\d]{64}$/u);
  });
  it('bounds deferred-argument aggregate traversal without recursive stack growth', () => {
    const nested = `const payload=${'['.repeat(1_024)}()=>1${']'.repeat(1_024)};`;
    expect(
      inspectCloudflareDeferredArgumentHazardForTesting(nested, 'payload')
    ).toBe(false);

    const broad = `const payload=[${Array.from(
      { length: 150_000 },
      () => '()=>1'
    ).join(',')}];`;
    expect(() =>
      inspectCloudflareDeferredArgumentHazardForTesting(broad, 'payload')
    ).toThrow('exceeded bounded candidate work');
  });

  it('traverses a wide AST without variadic frontier stack growth', () => {
    const source = `const payload=[${Array.from(
      { length: 150_000 },
      () => '0'
    ).join(',')}];`;

    expect(inspectAstTraversalForTesting(source)).toBe(true);
  });

  it('bounds immutable AST parent-map construction', () => {
    expect(() => inspectAstParentMapBoundForTesting(32, 16)).toThrow(
      'exceeded bounded AST traversal work'
    );
  });

  it('keeps cached parsed Program identities path-specific for identical bytes', () => {
    const root = fixture();
    const source = 'export const value = 1;';
    const firstFile = path.join(root, 'first.js');
    const secondFile = path.join(root, 'second.js');
    write(root, 'first.js', source);
    write(root, 'second.js', source);

    expect(
      inspectParsedModulePathIdentityForTesting(firstFile, secondFile)
    ).toBe(true);
  });

  it('retains one large reviewed static-member owner Program per digest', () => {
    const root = fixture();
    const ownerFile = path.join(root, 'large-static-member-owner.js');
    write(
      root,
      'large-static-member-owner.js',
      `const padding=${JSON.stringify('x'.repeat(70_000))};export{padding};`
    );

    expect(
      inspectCloudflareReviewedStaticMemberProgramCacheForTesting(ownerFile)
    ).toBe(true);
  });

  it('uses the iterative production visitor for a deeply nested Program', () => {
    const source = `const value=${'['.repeat(5_000)}0${']'.repeat(5_000)};`;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('bounds deep free-reference traversal before recursive scope analysis', () => {
    const source = `const value=${'['.repeat(2_048)}external${']'.repeat(2_048)};`;

    expect(() => inspectFreeIdentifierReferencesForTesting(source)).toThrow(
      'exceeded bounded AST depth'
    );
  });

  it('bounds deeply nested binding patterns before recursive projection', () => {
    const source = `const ${'['.repeat(2_048)}value${']'.repeat(2_048)}=[];`;

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'exceeded bounded binding-pattern depth'
    );
  });

  it('bounds a wide caller graph before enqueueing its frontier', () => {
    expect(() =>
      inspectArtifactOwnerCallerComponentsForTesting(150_000)
    ).toThrow('exceeded bounded candidate work');
  });

  it('bounds a wide manifest closure before enqueueing its frontier', () => {
    expect(() => inspectCloudflareModuleGraphBoundForTesting(150_000)).toThrow(
      'exceeded bounded module work'
    );
  });

  it('bounds a wide owner-consumer graph before enqueueing its frontier', () => {
    expect(() => inspectTopLevelOwnerConsumerBoundForTesting(150_000)).toThrow(
      'exceeded bounded candidate work'
    );
  });

  it('indexes reverse owner-consumer sources once', () => {
    expect(inspectArtifactOwnerConsumerSourcesForTesting(16_000)).toBe(16_000);
  });

  it.each([
    [
      'preserves the invoked second rest argument',
      'const sink=(first,second)=>second();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'does not collapse a dormant second rest argument onto the first',
      'const sink=effect=>effect();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      [],
    ],
    [
      'preserves positional rest identity through two wrappers',
      'const sink=(first,second)=>second();const inner=(...effects)=>sink(...effects);const outer=(...effects)=>inner(...effects);outer(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a canonical string index for the first rest argument',
      'const sink=(...values)=>values["0"]();const relay=(...effects)=>sink(...effects);relay(()=>fetch("https://invalid.example"),()=>undefined);',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a canonical string index for the second rest argument',
      'const sink=(...values)=>values["1"]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a static template index for the second rest argument',
      'const sink=(...values)=>values[`1`]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes an interpolated static template index for the second rest argument',
      'const sink=(...values)=>values[`${1}`]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a static arithmetic index for the second rest argument',
      'const sink=(...values)=>values[0+1]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a BigInt index for the first rest argument',
      'const sink=(...values)=>values[0n]();const relay=(...effects)=>sink(...effects);relay(()=>fetch("https://invalid.example"),()=>undefined);',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a BigInt index for the second rest argument',
      'const sink=(...values)=>values[1n]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
  ])('%s', (_label, source, effects) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(effects);
  });

  it('rejects a runtime-computed rest parameter projection', () => {
    const source =
      'const sink=(key,...values)=>values[key]();const relay=(key,...effects)=>sink(key,...effects);relay(1,()=>undefined,()=>fetch("https://invalid.example"));';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects unbounded computed rest-parameter projections'
    );
  });

  it.each([
    ['const transform=(value)=>value;', []],
    ['const transform=(effect)=>effect();', [{ name: 'effect', path: [] }]],
    [
      'const transform=(value)=>value.map(String);',
      [{ name: 'value', path: ['map'] }],
    ],
  ])('classifies reviewed callable parameter use', (source, expected) => {
    expect(
      inspectCloudflareInvokedParameterProjectionsForTesting(
        source,
        'transform'
      )
    ).toEqual(expected);
  });

  it('keeps delegated imports outside the local function dependency closure', () => {
    expect(
      inspectCloudflareInvokedParameterProjectionsForTesting(
        'import{__toESM}from"./runtime.js";import{require_react}from"./react.js";const import_react=__toESM(require_react(),1);const wrapper=value=>import_react.forwardRef(value);',
        'wrapper'
      )
    ).toEqual([{ name: 'value', path: [] }]);
  });

  it.each([
    [
      'rest array',
      'const sink=(key,...values)=>{const {[key]:effect}=values;effect()};const relay=(key,...effects)=>sink(key,...effects);relay(1,()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'object',
      'const sink=(key,value)=>{const {[key]:effect}=value;effect()};sink("danger",{danger:()=>fetch("https://invalid.example")});',
    ],
  ])(
    'rejects a dynamic computed destructuring key on a %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires static destructuring keys'
      );
    }
  );

  it('fails closed before materializing an oversized direct-callsite projection', () => {
    const calls = Array.from({ length: 513 }, () => 'mutate(target)').join(';');
    const source = `function mutate(value){value.run=()=>0}const target={run:()=>0};${calls};target.run();`;

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'exceeded bounded parameter projection count'
    );
  });

  it.each([
    [
      'forwarded rest array',
      'const sink=(...values)=>{const [,effect]=values;effect()};const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'concrete array argument',
      'const sink=values=>{const [,effect]=values;effect()};sink([()=>undefined,()=>fetch("https://invalid.example")]);',
    ],
  ])('preserves local ArrayPattern position for a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'missing array element',
      'const sink=(...values)=>{const [,effect=()=>fetch("https://invalid.example")]=values;effect()};sink(()=>undefined);',
    ],
    [
      'explicitly undefined array element',
      'const sink=(...values)=>{const [,effect=()=>fetch("https://invalid.example")]=values;effect()};sink(()=>undefined,undefined);',
    ],
    [
      'missing object property',
      'const sink=values=>{const {effect=()=>fetch("https://invalid.example")}=values;effect()};sink({});',
    ],
    [
      'explicitly undefined object property',
      'const sink=values=>{const {effect=()=>fetch("https://invalid.example")}=values;effect()};sink({effect:undefined});',
    ],
    [
      'default through two wrappers',
      'const sink=(...values)=>{const [,effect=()=>fetch("https://invalid.example")]=values;effect()};const first=(...values)=>sink(...values);const second=(...values)=>first(...values);second(()=>undefined);',
    ],
  ])('applies a local destructuring default for a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    'const run=({effect}={effect:()=>fetch("https://invalid.example")})=>effect();run();',
    'const run=([effect]=[()=>fetch("https://invalid.example")])=>effect();run();',
  ])('projects a whole-pattern parameter default', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('does not apply a default to a shadowed undefined binding', () => {
    const source =
      'const undefined=()=>0;const [effect=()=>fetch("https://invalid.example")]=[undefined];effect();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'direct rest tail',
      'const sink=(...values)=>{const [first,...tail]=values;tail[0]()};sink(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'rest tail through two wrappers',
      'const sink=(...values)=>{const [first,...tail]=values;tail[0]()};const first=(...values)=>sink(...values);const second=(...values)=>first(...values);second(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
  ])('preserves a local array %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'direct symbolic array spread',
      'const sink=path=>{const next=[...path];next[0]()};sink([()=>fetch("https://invalid.example")]);',
    ],
    [
      'symbolic array spread through a wrapper',
      'const sink=path=>{const next=[...path];next[0]()};const relay=path=>sink(path);relay([()=>fetch("https://invalid.example")]);',
    ],
  ])('fails closed for a callable %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'statically analyzable aggregate spreads'
    );
  });

  it('allows an unresolved member array spread used only as data', () => {
    const source =
      'const normalize=(error,path=[])=>{for(const issue of error.issues){const next=[...path,...issue.path];if(next.length===0)return 0}return 1};';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('rejects an unresolved member array spread that reaches a call', () => {
    const source =
      'const run=source=>{const values=[...source.items];values[0]()};run(getUnknown());';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'statically analyzable aggregate spreads'
    );
  });

  it('rejects an unresolved array-producing call spread at load time', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting('const values=[...getUnknown()];')
    ).toThrow('statically analyzable aggregate spreads');
  });

  it('keeps an unresolved array-producing call spread dormant', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const dormant=()=>[...getUnknown()];'
      )
    ).toEqual([]);
  });

  it('propagates a callable through a parameter-backed for-of loop', () => {
    const source =
      'const run=values=>{for(const value of values)value()};run([()=>fetch("https://invalid.example")]);';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('keeps shallow conditional load-effect inspection conservative without deep target state', () => {
    const source =
      'if(globalThis.flag)fetch("https://conditional-shallow.invalid.example");';

    expect(inspectCloudflareShallowLoadEffectsForTesting(source)).toEqual([
      'fetch("https://conditional-shallow.invalid.example")',
    ]);
  });

  it('recognizes only zero-effect app-owned top-level declarations', () => {
    expect(
      inspectCloudflareAppOnlyTopLevelInertForTesting(
        'import"./owner.js";const data={value:1,list:[1,()=>fetch("https://dormant.invalid.example")]};function dormant(){return fetch("https://dormant.invalid.example")}export{data,dormant};'
      )
    ).toBe(true);
  });

  it.each([
    ['top-level call', 'const value=run();'],
    ['top-level constructor', 'const value=new Map();'],
    ['member read', 'const value=source.field;'],
    ['object spread', 'const value={...source};'],
    ['computed object key', 'const value={[source]:1};'],
    [
      'object getter',
      'const value={get field(){return fetch("https://invalid.example")}};',
    ],
    [
      'computed class key',
      'class Value{[fetch("https://invalid.example")](){}}',
    ],
    [
      'class static block',
      'class Value{static{fetch("https://invalid.example")}}',
    ],
    ['assignment', 'let value;value=source;'],
    ['update', 'let value=0;value++;'],
  ])('requires deep app-owned analysis for a %s', (_label, source) => {
    expect(inspectCloudflareAppOnlyTopLevelInertForTesting(source)).toBe(false);
  });

  it('bounds a self-referential imported factory argument', () => {
    expect(
      inspectCloudflareImportedFactoryCycleForTesting(
        'import{make}from"./owner.js";const value=make(value);export{value};',
        'value'
      )
    ).toBe(true);
  });

  it('shares imported factory cycle state across lexical-context re-entry', () => {
    expect(
      inspectCloudflareImportedFactoryContextReentryForTesting(
        'import{make}from"./owner.js";const value=make();export{value};',
        'value'
      )
    ).toBe(true);
  });

  it.each([
    [
      'reachable then unreachable',
      'mutate(true,target,()=>fetch("https://invalid.example"));mutate(false,target,()=>0);',
    ],
    [
      'unreachable then reachable',
      'mutate(false,target,()=>0);mutate(true,target,()=>fetch("https://invalid.example"));',
    ],
  ])(
    'does not memoize callsite-dependent unreachable mutations: %s',
    (_label, invocations) => {
      const source = `function mutate(enabled,target,run){if(enabled)target.run=run}const target={run:()=>0};${invocations}target.run();`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it.each([
    [
      'object',
      'make({effect:()=>fetch("https://invalid.example")}).consume();',
      'const make=root=>({consume:()=>root.effect()});export{make};',
    ],
    [
      'array',
      'make([()=>fetch("https://invalid.example")]).consume();',
      'const make=root=>({consume:()=>root[0]()});export{make};',
    ],
    [
      'nested object',
      'make({nested:{effect:()=>fetch("https://invalid.example")}}).consume();',
      'const make=root=>({consume:()=>root.nested.effect()});export{make};',
    ],
    [
      'destructured object',
      'make({used:()=>fetch("https://invalid.example"),unused:()=>0}).consume();',
      'const make=({used})=>({consume:()=>used()});export{make};',
    ],
    [
      'object alias',
      'const options={effect:()=>fetch("https://invalid.example")};make(options).consume();',
      'const make=root=>({consume:()=>root.effect()});export{make};',
    ],
  ])(
    'rejects a used callable in a structural imported factory %s argument',
    (_label, invocation, owner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      addCloudflareRouterEffectModule(
        root,
        `import{make}from"./router-effect-AAAAAAAA.js";${invocation}`,
        owner
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it.each([
    [
      'object',
      'make({used:()=>0,unused:()=>fetch("https://invalid.example")}).consume();',
      'const make=root=>({consume:()=>root.used()});export{make};',
    ],
    [
      'destructured object',
      'make({used:()=>0,unused:()=>fetch("https://invalid.example")}).consume();',
      'const make=({used})=>({consume:()=>used()});export{make};',
    ],
  ])(
    'keeps an unused callable dormant in a structural imported factory %s argument',
    (_label, invocation, owner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      addCloudflareRouterEffectModule(
        root,
        `import{make}from"./router-effect-AAAAAAAA.js";${invocation}`,
        owner
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).not.toThrow();
    }
  );

  it.each([
    [
      'tail index one through one wrapper',
      'const sink=(...values)=>{const [first,...tail]=values;tail[1]()};const relay=(...values)=>sink(...values);relay(()=>0,()=>0,()=>fetch("https://invalid.example"));',
    ],
    [
      'tail index three through two wrappers',
      'const sink=(...values)=>{const [first,...tail]=values;tail[3]()};const first=(...values)=>sink(...values);const second=(...values)=>first(...values);second(()=>0,()=>0,()=>0,()=>0,()=>fetch("https://invalid.example"));',
    ],
  ])('preserves a local array %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('resolves a static computed destructuring key', () => {
    const source =
      'const sink=(...values)=>{const {[`${1}`]:effect}=values;effect()};sink(()=>undefined,()=>fetch("https://invalid.example"));';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'direct object member assignment',
      'const target={run:()=>undefined};target.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'Object.assign member replacement',
      'const target={run:()=>undefined};Object.assign(target,{run:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'array index assignment',
      'const target=[];target[0]=()=>fetch("https://invalid.example");target[0]();',
    ],
    [
      'conditional member assignment',
      'const target={run:()=>undefined};if(flag)target.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('detects load effects from a prior %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('allows a prior safe member assignment', () => {
    const source =
      'const target={run:()=>undefined};target.run=()=>undefined;target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('identity-keys deep synthetic mutation targets without digesting them', () => {
    let deepTarget = { name: 'target', type: 'Identifier' };
    for (let depth = 0; depth < 20_000; depth += 1) {
      deepTarget = {
        computed: false,
        object: deepTarget,
        property: { name: 'value', type: 'Identifier' },
        type: 'MemberExpression',
      };
    }
    const otherTarget = { ...deepTarget };

    expect(
      inspectCloudflareSyntheticMutationTargetKeysForTesting([
        deepTarget,
        deepTarget,
        otherTarget,
      ])
    ).toEqual(['synthetic:0', 'synthetic:0', 'synthetic:1']);
  });

  it.each([
    [
      'write through alias',
      'const target={run:()=>0};const alias=target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'read through alias',
      'const target={run:()=>0};const alias=target;target.run=()=>fetch("https://invalid.example");alias.run();',
    ],
    [
      'chained alias',
      'const target={run:()=>0};const first=target;const second=first;second.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'destructured object alias',
      'const target={run:()=>0};const box={target};const {target:alias}=box;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'destructured array alias',
      'const target={run:()=>0};const box=[target];const [alias]=box;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('tracks a prior member mutation across a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'parameter alias',
      'const target={run:()=>0};function mutate(alias){alias.run=()=>fetch("https://invalid.example")}mutate(target);target.run();',
    ],
    [
      'rest parameter alias',
      'const target={run:()=>0};function mutate(...values){values[0].run=()=>fetch("https://invalid.example")}mutate(target);target.run();',
    ],
    [
      'opaque identity-call alias',
      'const target={run:()=>0};const identity=value=>value;const alias=identity(target);alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('conservatively tracks a mutation through a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'assignment',
      'function mutate(...args){args[0].run=args[1]}const target={run:()=>0};mutate(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'Object.assign',
      'function mutate(...args){Object.assign(args[0],{run:args[1]})}const target={run:()=>0};mutate(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'Reflect.set',
      'function mutate(...args){Reflect.set(args[0],"run",args[1])}const target={run:()=>0};mutate(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'returned assignment',
      'function make(...args){return()=>{args[0].run=args[1]}}const target={run:()=>0};make(target,()=>fetch("https://invalid.example"))();target.run()',
    ],
    [
      'returned Object.assign',
      'function make(...args){return()=>Object.assign(args[0],{run:args[1]})}const target={run:()=>0};make(target,()=>fetch("https://invalid.example"))();target.run()',
    ],
    [
      'returned Reflect.set',
      'function make(...args){return()=>Reflect.set(args[0],"run",args[1])}const target={run:()=>0};make(target,()=>fetch("https://invalid.example"))();target.run()',
    ],
    [
      'array-destructured rest assignment',
      'function mutate([target,...runs]){target.run=runs[0]}const target={run:()=>0};mutate([target,()=>fetch("https://invalid.example")]);target.run()',
    ],
    [
      'object-destructured rest assignment',
      'function mutate({target,...rest}){target.run=rest.run}const target={run:()=>0};mutate({target,run:()=>fetch("https://invalid.example")});target.run()',
    ],
    [
      'returned array-destructured rest assignment',
      'function make([target,...runs]){return()=>{target.run=runs[0]}}const target={run:()=>0};make([target,()=>fetch("https://invalid.example")])();target.run()',
    ],
    [
      'returned object-destructured rest assignment',
      'function make({target,...rest}){return()=>{target.run=rest.run}}const target={run:()=>0};make({target,run:()=>fetch("https://invalid.example")})();target.run()',
    ],
  ])('specializes a rest-operand receiver mutation (%s)', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('keeps a safe rest-operand receiver mutation inert', () => {
    const source =
      'function mutate(...args){Object.assign(args[0],{run:args[1]})}const target={run:()=>0};mutate(target,()=>0);target.run()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'array-destructured sibling',
      'function mutate([target,...runs]){target.run=runs[0]}const first={run:()=>0},second={run:()=>0};mutate([first,()=>fetch("https://invalid.example")]);second.run()',
    ],
    [
      'object-destructured sibling',
      'function mutate({target,...rest}){target.run=rest.run}const first={run:()=>0},second={run:()=>0};mutate({target:first,run:()=>fetch("https://invalid.example")});second.run()',
    ],
    [
      'array-destructured call site',
      'function mutate([target,...runs]){target.run=runs[0]}const first={run:()=>0},second={run:()=>0};mutate([first,()=>fetch("https://invalid.example")]);mutate([second,()=>0]);second.run()',
    ],
    [
      'object-destructured call site',
      'function mutate({target,...rest}){target.run=rest.run}const first={run:()=>0},second={run:()=>0};mutate({target:first,run:()=>fetch("https://invalid.example")});mutate({target:second,run:()=>0});second.run()',
    ],
  ])('isolates a safe %s rest mutation', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('scopes a directly called parameter receiver mutation to its argument', () => {
    const source =
      'const first={run:()=>0};const second={run:()=>0};function mutate(target){target.run=()=>fetch("https://invalid.example")}mutate(first);second.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('retains intra-call ordering when two parameters alias one receiver', () => {
    const source =
      'function mutate(first,second){Object.defineProperty(first,"run",{value:()=>fetch("https://invalid.example")});second.run()}const target={};mutate(target,target);';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('keeps distinct direct-call parameter receivers isolated', () => {
    const source =
      'function mutate(first,second){Object.defineProperty(first,"run",{value:()=>fetch("https://invalid.example")});second.run()}mutate({}, {run:()=>0});';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('proves the exact direct-call closure of a reviewed exported receiver mutation', () => {
    expect(
      inspectCloudflareReviewedExportMutationPlanForTesting(
        reviewedExportMutationOwnerSource,
        reviewedExportMutationPolicy
      )
    ).toEqual({
      eligible: true,
      mutationMembers: expect.arrayContaining(
        reviewedExportMutationPolicy.expectedMutationMembers
      ),
      mutationPaths: [[], [], [], []],
      summaryComplete: true,
    });

    expect(
      inspectCloudflareReviewedExportConsumerProofForTesting(
        reviewedExportMutationOwnerSource,
        [
          'import{zt as mutate}from"./owner.js";const first={};mutate(first);mutate({});',
          'import{zt as mutate}from"./owner.js";const second={};mutate(second);',
        ],
        reviewedExportMutationPolicy
      )
    ).toEqual({
      complete: true,
      consumerCount: 4,
      counts: [1, 2, 1],
      reason: undefined,
    });
  });

  it.each([
    [
      'an indirect alias',
      'import{zt as mutate}from"./owner.js";const receiver={};const alias=mutate;alias(receiver);',
      'consumer-0-calls',
    ],
    [
      'Function.prototype.call',
      'import{zt as mutate}from"./owner.js";const receiver={};mutate.call(null,receiver);',
      'consumer-0-calls',
    ],
    [
      'a namespace import',
      'import*as owner from"./owner.js";owner.zt({});',
      'consumer-0-imports',
    ],
    [
      'the wrong imported export',
      'import{other as mutate}from"./owner.js";mutate({});',
      'consumer-0-imports',
    ],
  ])(
    'rejects %s from a reviewed exported receiver mutation closure',
    (_label, consumer, reason) => {
      expect(
        inspectCloudflareReviewedExportConsumerProofForTesting(
          reviewedExportMutationOwnerSource,
          [consumer],
          reviewedExportMutationPolicy
        )
      ).toMatchObject({ complete: false, reason });
    }
  );

  it('rejects unreviewed calls beyond the exact exported mutation consumer count', () => {
    expect(
      inspectCloudflareReviewedExportConsumerProofForTesting(
        reviewedExportMutationOwnerSource,
        [
          'import{zt as mutate}from"./owner.js";mutate({});mutate({});mutate({});mutate({});',
        ],
        reviewedExportMutationPolicy
      )
    ).toEqual({
      complete: false,
      consumerCount: 5,
      counts: [1, 4],
      reason: 'count',
    });
  });

  it('audits an unsafe string-literal import even when recognized calls compensate the reviewed count', () => {
    expect(
      inspectCloudflareReviewedExportConsumerProofForTesting(
        reviewedExportMutationOwnerSource,
        [
          'import{zt as mutate}from"./owner.js";mutate({});mutate({});mutate({});',
          'import{"zt" as hidden}from"./owner.js";const shared=makeReceiver();hidden(shared);',
        ],
        reviewedExportMutationPolicy
      )
    ).toMatchObject({
      complete: false,
      diagnostic: {
        parentType: 'CallExpression',
      },
      reason: 'consumer-1-calls',
    });
  });

  it('accepts a direct shorthand named import of the reviewed export', () => {
    expect(
      inspectCloudflareReviewedExportConsumerProofForTesting(
        reviewedExportMutationOwnerSource,
        ['import{zt}from"./owner.js";zt({});zt({});zt({});'],
        reviewedExportMutationPolicy
      )
    ).toEqual({
      complete: true,
      consumerCount: 4,
      counts: [1, 3],
      reason: undefined,
    });
  });

  it.each([
    [
      'globalThis.Object.prototype',
      'globalThis.Object.defineProperty(globalThis.Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'Object.getPrototypeOf alias',
      'const p=Object.getPrototypeOf({});Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'destructured Object.prototype alias',
      'const {prototype:p}=Object;Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'array-projected Object.prototype alias',
      'const p=[Object.prototype][0];Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'array-destructured Object.prototype alias',
      'const [p]=[Object.prototype];Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'two-step array-projected Object.prototype alias',
      'const prototypes=[Object.prototype];const p=prototypes[0];Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'conditional Object.prototype alias',
      'const p=globalThis.pickPrototype?Object.prototype:{};Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'logical Object.prototype alias',
      'const p=Object.prototype||{};Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'destructuring-assignment Object.prototype alias',
      'let p;({prototype:p}=Object);Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'default-parameter Object.prototype alias',
      'function install(p=Object.prototype){Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}})}install();',
    ],
    [
      'for-of Object.prototype alias',
      'for(const p of [Object.prototype]){Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}})}',
    ],
  ])(
    'rejects a summarized-member setter through %s',
    (_label, prototypeSetup) => {
      const consumer = `import{zt as mutate}from"./owner.js";${prototypeSetup}mutate({});mutate({});mutate({});`;

      expect(
        inspectCloudflareReviewedExportConsumerProofForTesting(
          reviewedExportMutationOwnerSource,
          [consumer],
          reviewedExportMutationPolicy
        )
      ).toMatchObject({
        complete: false,
        reason: 'consumer-0-object-prototype',
      });
    }
  );

  it.each([
    [
      'self.Object.prototype',
      'self.Object.defineProperty(self.Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'plain-object constructor.prototype',
      'Object.defineProperty(({}).constructor.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'nested array prototype alias',
      'const p=[[[Object.prototype]]][0][0][0];Object.defineProperty(p,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'aliased Object.defineProperty',
      'const define=Object.defineProperty;define(Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'destructured Object.defineProperty',
      'const {defineProperty:define}=Object;define(Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'Object.defineProperty stored in a static helper object',
      'const helpers={define:Object.defineProperty};helpers.define(Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'Object.defineProperty.call',
      'Object.defineProperty.call(Object,Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'Object.defineProperty.apply',
      'Object.defineProperty.apply(Object,[Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}}]);',
    ],
    [
      'nested Function.prototype.call dispatch',
      'Function.prototype.call.call(Object.defineProperty,null,Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'nested Function.prototype.apply dispatch',
      'Function.prototype.apply.call(Object.defineProperty,null,[Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}}]);',
    ],
    [
      'Reflect.apply of Function.prototype.call',
      'Reflect.apply(Function.prototype.call,Object.defineProperty,[null,Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}}]);',
    ],
    [
      'nested Function.prototype.bind dispatch',
      'const bind=Function.prototype.bind.bind(Object.defineProperty);const define=bind(Object);define(Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'nested legacy __defineSetter__ dispatch',
      'Function.prototype.call.call(Object.prototype.__defineSetter__,Object.prototype,"activeTriggerId",function(value){fetch("https://invalid.example")});',
    ],
    [
      'computed unknown descriptor key',
      'const key=getKey();Object.defineProperty(Object.prototype,key,{set(value){fetch("https://invalid.example")}});',
    ],
  ])(
    'rejects a summarized or unknown descriptor mutation through %s',
    (_label, descriptorMutation) => {
      const consumer = `import{zt as mutate}from"./owner.js";${descriptorMutation}mutate({});mutate({});mutate({});`;

      expect(
        inspectCloudflareReviewedExportConsumerProofForTesting(
          reviewedExportMutationOwnerSource,
          [consumer],
          reviewedExportMutationPolicy
        )
      ).toMatchObject({
        complete: false,
        reason: 'consumer-0-object-prototype',
      });
    }
  );

  it.each([
    [
      'Object.defineProperty',
      'Object.defineProperty(Object.prototype,"unrelated",{set(value){fetch("https://invalid.example")}});',
    ],
    [
      'Object.defineProperties',
      'Object.defineProperties(Object.prototype,{another:{value:1},unrelated:{set(value){fetch("https://invalid.example")}}});',
    ],
  ])(
    'allows only unrelated static descriptor keys through %s',
    (_label, descriptorMutation) => {
      const consumer = `import{zt as mutate}from"./owner.js";${descriptorMutation}mutate({});mutate({});mutate({});`;

      expect(
        inspectCloudflareReviewedExportConsumerProofForTesting(
          reviewedExportMutationOwnerSource,
          [consumer],
          reviewedExportMutationPolicy
        )
      ).toEqual({
        complete: true,
        consumerCount: 4,
        counts: [1, 3],
        reason: undefined,
      });
    }
  );

  it.each([
    [
      'Reflect.set on self',
      'Reflect.set(self,"Object",{defineProperty(){}});self.Object.defineProperty(Object.prototype,"unrelated",{set(){}});',
    ],
    [
      'Object.defineProperty on global',
      'Object.defineProperty(global,"Object",{value:{defineProperty(){}}});global.Object.defineProperty(Object.prototype,"unrelated",{set(){}});',
    ],
    [
      'Object.assign on globalThis',
      'Object.assign(globalThis,{Object:{defineProperty(){}}});globalThis.Object.defineProperty(Object.prototype,"unrelated",{set(){}});',
    ],
    [
      'globalThis.Object.assign on self',
      'globalThis.Object.assign(self,{Object:{defineProperty(){}}});self.Object.defineProperty(Object.prototype,"unrelated",{set(){}});',
    ],
    [
      'aliased Reflect.set on global',
      'const set=Reflect.set;set(global,"Object",{defineProperty(){}});global.Object.defineProperty(Object.prototype,"unrelated",{set(){}});',
    ],
    [
      'Reflect.set.call on self',
      'Reflect.set.call(Reflect,self,"Object",{defineProperty(){}});self.Object.defineProperty(Object.prototype,"unrelated",{set(){}});',
    ],
    [
      'a top-level replacement observed from a nested function',
      'globalThis.Object={defineProperty(){}};function install(){globalThis.Object.defineProperty(Object.prototype,"unrelated",{set(){}})}install();',
    ],
  ])(
    'rejects an intrinsic Object replacement through %s',
    (_label, replacement) => {
      const consumer = `import{zt as mutate}from"./owner.js";${replacement}mutate({});mutate({});mutate({});`;

      expect(() =>
        inspectCloudflareReviewedExportConsumerProofForTesting(
          reviewedExportMutationOwnerSource,
          [consumer],
          reviewedExportMutationPolicy
        )
      ).toThrow('rejects a replaced intrinsic global Object');
    }
  );

  it('keeps a signed literal-named consumer in the reviewed artifact closure and fails its same-receiver read closed', () => {
    const artifact = createReviewedExportArtifactFixture(
      [
        {
          file: 'assets/literal-consumer.js',
          importsOwner: true,
          source:
            'import{"zt" as hidden}from"./reviewed-owner.js";const receiver={};hidden(receiver);receiver.activeTriggerId();',
        },
      ],
      1
    );

    expect(
      inspectCloudflareReviewedExportArtifactProofForTesting(
        artifact.root,
        artifact.ownerArtifactFile,
        artifact.policy.exportedLocalName,
        fixtureCloudflareProvenanceKey,
        artifact.policy
      )
    ).toEqual({ complete: true, failure: undefined });

    expect(() =>
      inspectCloudflareReviewedExportArtifactLoadEffectsForTesting(
        artifact.root,
        artifact.ownerArtifactFile,
        'assets/literal-consumer.js',
        artifact.policy.exportedLocalName,
        fixtureCloudflareProvenanceKey,
        artifact.policy
      )
    ).toThrow('rejects opaque aggregate member mutations');
  });

  it('keeps an unrelated literal-import receiver isolated in the signed artifact graph', () => {
    const artifact = createReviewedExportArtifactFixture(
      [
        {
          file: 'assets/literal-isolated-consumer.js',
          importsOwner: true,
          source:
            'import{"zt" as hidden}from"./reviewed-owner.js";const receiver={},unrelated={activeTriggerId:()=>0};hidden(receiver);unrelated.activeTriggerId();',
        },
      ],
      1
    );

    expect(
      inspectCloudflareReviewedExportArtifactLoadEffectsForTesting(
        artifact.root,
        artifact.ownerArtifactFile,
        'assets/literal-isolated-consumer.js',
        artifact.policy.exportedLocalName,
        fixtureCloudflareProvenanceKey,
        artifact.policy
      )
    ).toEqual({ complete: true, effects: [], failure: undefined });
  });

  it('rejects a signed chunk that installs a summarized Object.prototype setter', () => {
    const artifact = createReviewedExportArtifactFixture(
      [
        {
          file: 'assets/safe-consumer.js',
          importsOwner: true,
          source: 'import{zt as mutate}from"./reviewed-owner.js";mutate({});',
        },
        {
          file: 'assets/prototype-setter.js',
          source:
            'Object.defineProperty(Object.prototype,"activeTriggerId",{set(value){fetch("https://invalid.example")}});',
        },
      ],
      1
    );

    expect(
      inspectCloudflareReviewedExportArtifactProofForTesting(
        artifact.root,
        artifact.ownerArtifactFile,
        artifact.policy.exportedLocalName,
        fixtureCloudflareProvenanceKey,
        artifact.policy
      )
    ).toEqual({
      complete: false,
      failure:
        'consumer assets/prototype-setter.js may mutate Object.prototype for a summarized member',
    });
  });

  it('audits a signed .mjs consumer even when earlier recognized calls compensate the count', () => {
    const artifact = createReviewedExportArtifactFixture(
      [
        {
          file: 'assets/compensating-consumer.js',
          importsOwner: true,
          source:
            'import{zt as mutate}from"./reviewed-owner.js";mutate({});mutate({});',
        },
        {
          file: 'assets/hidden-consumer.mjs',
          importsOwner: true,
          source:
            'import{"zt" as hidden}from"./reviewed-owner.js";const shared=makeReceiver();hidden(shared);',
        },
      ],
      2
    );

    expect(
      inspectCloudflareReviewedExportArtifactProofForTesting(
        artifact.root,
        artifact.ownerArtifactFile,
        artifact.policy.exportedLocalName,
        fixtureCloudflareProvenanceKey,
        artifact.policy
      )
    ).toEqual({
      complete: false,
      failure: 'consumer binding has an unsupported use',
    });
  });

  it.each([
    [
      'an additional member write',
      reviewedExportMutationOwnerSource.replace(
        '}setPopupOpenState({})',
        ';store.extra=null}setPopupOpenState({})'
      ),
    ],
    [
      'the wrong receiver parameter',
      'function setPopupOpenState(store,other){other.activeTriggerElement=null;other.activeTriggerId=null;other.preventUnmountingOnClose=true;other.preventUnmountingOnClose=false}setPopupOpenState({},{});export{setPopupOpenState as zt};',
    ],
  ])('rejects %s from the reviewed mutation plan', (_label, ownerSource) => {
    expect(
      inspectCloudflareReviewedExportMutationPlanForTesting(
        ownerSource,
        reviewedExportMutationPolicy
      )
    ).toMatchObject({ eligible: false });
  });

  it('rejects the wrong export name before planning a reviewed mutation', () => {
    expect(() =>
      inspectCloudflareReviewedExportMutationPlanForTesting(
        reviewedExportMutationOwnerSource.replace(' as zt', ' as other'),
        reviewedExportMutationPolicy
      )
    ).toThrow('must resolve one exact local export');
  });

  it('accepts only fresh direct receiver arguments for an imported mutation summary', () => {
    const states = inspectCloudflareReviewedFreshExportReceiversForTesting(
      'const direct={};const alias=direct;const factory=make();mutate(direct);mutate({});mutate(alias);mutate(factory);mutate(...values);',
      'mutate',
      0
    );

    expect(states.map(({ eligible }) => eligible)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it.each([
    [
      'a direct setter',
      'mutate({set activeTriggerId(value){fetch("https://invalid.example")}});',
      { argumentType: 'ObjectExpression' },
    ],
    [
      'a __proto__ setter',
      'const proto={set activeTriggerId(value){fetch("https://invalid.example")}};mutate({__proto__:proto});',
      { argumentType: 'ObjectExpression' },
    ],
    [
      'a pre-call Object.freeze',
      'const receiver={};Object.freeze(receiver);mutate(receiver);',
      { receiverUsesAreOrdered: false },
    ],
    [
      'a pre-call Object.defineProperty setter',
      'const receiver={};Object.defineProperty(receiver,"activeTriggerId",{set(value){fetch("https://invalid.example")}});mutate(receiver);',
      { receiverUsesAreOrdered: false },
    ],
    [
      'a pre-call Object.setPrototypeOf',
      'const proto={set activeTriggerId(value){fetch("https://invalid.example")}};const receiver={};Object.setPrototypeOf(receiver,proto);mutate(receiver);',
      { receiverUsesAreOrdered: false },
    ],
  ])(
    'rejects %s before a reviewed mutation call',
    (_label, source, details) => {
      const states = inspectCloudflareReviewedFreshExportReceiversForTesting(
        source,
        'mutate',
        0
      );

      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ eligible: false, ...details });
    }
  );

  it.each([
    [
      'an unrelated receiver read',
      'function mutate(receiver){receiver.run=()=>fetch("https://invalid.example")}const first={},second={run(){}};mutate(first);second.run();',
      [],
    ],
    [
      'a same-receiver read',
      'function mutate(receiver){receiver.run=()=>fetch("https://invalid.example")}const first={};mutate(first);first.run();',
      ['fetch("https://invalid.example")'],
    ],
    [
      'a same-receiver alias read',
      'function mutate(receiver){receiver.run=()=>fetch("https://invalid.example")}const first={};mutate(first);const alias=first;alias.run();',
      ['fetch("https://invalid.example")'],
    ],
  ])(
    'preserves receiver identity for %s',
    (_label, source, expectedEffects) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(
        expectedEffects
      );
    }
  );

  it.each([
    [
      'safe then hazardous',
      'install(target,first);install(target,second)',
      '()=>0',
      '()=>fetch("https://invalid.example")',
    ],
    [
      'hazardous then safe',
      'install(target,second);install(target,first)',
      '()=>0',
      '()=>fetch("https://invalid.example")',
    ],
  ])(
    'keeps ordered delegated parameter writes distinct (%s)',
    (_label, writes, first, second) => {
      const source = `function install(target,run){target.run=run}function relay(target,first,second){${writes}}const target={run:()=>0};relay(target,${first},${second});target.run()`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it.each([
    [
      'declaration',
      'const target={run:()=>0};function write(receiver,value){const alias=receiver;alias.run=value}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'assignment',
      'const target={run:()=>0};function write(receiver,value){let alias;alias=receiver;alias.run=value}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'chain',
      'const target={run:()=>0};function write(receiver,value){const first=receiver,second=first;second.run=value}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'container',
      'const target={run:()=>0};function write(receiver,value){const box={receiver};const {receiver:alias}=box;alias.run=value}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'parameter pattern',
      'const target={run:()=>0};function write({receiver},value){const alias=receiver;alias.run=value}write({receiver:target},()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'conditional',
      'const target={run:()=>0};function write(receiver,value){const alias=true?receiver:receiver;alias.run=value}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'logical',
      'const target={run:()=>0};function write(receiver,value){const alias=receiver||receiver;alias.run=value}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'nested member',
      'const target={run:()=>0};function write(receiver,value){const alias=receiver.inner;alias.run=value}write({inner:target},()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'identity helper',
      'const identity=value=>value,target={run:()=>0};function write(receiver,value){const alias=identity(receiver);alias.run=value}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'this',
      'const api={run:()=>0,write(value){const alias=this;alias.run=value}};api.write(()=>fetch("https://invalid.example"));api.run()',
    ],
    [
      'defineProperty',
      'const target={run:()=>0};function write(receiver,value){const alias=receiver;Object.defineProperty(alias,"run",{value})}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'Reflect.set',
      'const target={run:()=>0};function write(receiver,value){const alias=receiver;Reflect.set(alias,"run",value)}write(target,()=>fetch("https://invalid.example"));target.run()',
    ],
  ])(
    'propagates writes through a parameter receiver alias (%s)',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it.each([
    ['conditional', 'const alias=which?first:second'],
    ['logical', 'const alias=first||second'],
    ['reassignment', 'let alias=first;alias=second'],
  ])(
    'propagates writes through a multi-source receiver alias (%s)',
    (_label, alias) => {
      const source = `function mutate(first,second,which){${alias};alias.run=()=>fetch("https://invalid.example")}const target={run:()=>0};mutate({},target,false);target.run()`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it.each([
    'function mutate(){this.box.run=()=>fetch("https://invalid.example")}const target={box:{run:()=>0}};mutate.call(target);target.box.run()',
    'const target={box:{run:()=>0},mutate(){this.box.run=()=>fetch("https://invalid.example")}};target.mutate();target.box.run()',
  ])('propagates a nested this receiver mutation', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'target.run=()=>run()',
    'Object.defineProperty(target,"run",{value:()=>run()})',
  ])('specializes a delegated structured mutation operand (%s)', (mutation) => {
    const source = `function mutate(target,run){${mutation}}function wrapper(target,run){mutate(target,run)}const target={};wrapper(target,()=>fetch("https://invalid.example"));target.run()`;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    ['safe then hazardous', 'safe(target);bad(target)'],
    ['hazardous then safe', 'bad(target);safe(target)'],
  ])(
    'keeps ordered delegated factory captures distinct (%s)',
    (_label, writes) => {
      const source = `const target={run:()=>0};function make(effect){return target=>{target.run=()=>effect()}}const bad=make(()=>fetch("https://invalid.example")),safe=make(()=>0);function relay(target){${writes}}relay(target);target.run()`;

      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it.each([
    [
      'direct value',
      'function mutate(run){target.run=run}const target={};mutate(()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'direct structured value',
      'function mutate(run){target.run=()=>run()}const target={};mutate(()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'one wrapper',
      'function mutate(run){target.run=()=>run()}function wrapper(run){mutate(run)}const target={};wrapper(()=>fetch("https://invalid.example"));target.run()',
    ],
    [
      'two wrappers',
      'function mutate(run){target.run=()=>run()}function first(run){mutate(run)}function second(run){first(run)}const target={};second(()=>fetch("https://invalid.example"));target.run()',
    ],
  ])(
    'specializes a concrete-receiver mutation operand (%s)',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it('fails closed for an unresolved captured-receiver factory mutation', () => {
    const source =
      'function make(target){return function mutate(run){target.run=()=>run()}}const target={},mutate=make(target);mutate(()=>fetch("https://invalid.example"));target.run()';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    [
      'safe then hazardous',
      'mutate(()=>0);mutate(()=>fetch("https://invalid.example"));target.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'hazardous then safe',
      'mutate(()=>fetch("https://invalid.example"));mutate(()=>0);target.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'hazardous read before safe',
      'mutate(()=>fetch("https://invalid.example"));target.run();mutate(()=>0)',
      ['fetch("https://invalid.example")'],
    ],
    [
      'safe read before hazardous',
      'mutate(()=>0);target.run();mutate(()=>fetch("https://invalid.example"))',
      [],
    ],
  ])(
    'orders concrete-receiver parameterized mutations (%s)',
    (_label, operations, expected) => {
      const source = `function mutate(run){target.run=()=>run()}const target={};${operations}`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(expected);
    }
  );

  it.each([
    [
      'direct repeated read',
      'read();mutate();read()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'wrapped repeated read',
      'wrapper();mutate();wrapper()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'mutation before all reads',
      'mutate();read();read()',
      ['fetch("https://invalid.example")'],
    ],
    ['mutation after all reads', 'read();read();mutate()', []],
  ])(
    'orders a mutation against the latest %s',
    (_label, operations, expected) => {
      const source = `const target={run:()=>0};function read(){target.run()}function wrapper(){read()}function mutate(){target.run=()=>fetch("https://invalid.example")}${operations}`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(expected);
    }
  );

  it.each([
    ['safe', '()=>0', []],
    [
      'hazardous',
      '()=>fetch("https://invalid.example")',
      ['fetch("https://invalid.example")'],
    ],
  ])(
    'bounds a %s delegated receiver-mutation doubling graph',
    (_label, replacement, expected) => {
      const owners = [`function mutate0(target){target.run=${replacement}}`];
      for (let index = 1; index < 16; index += 1) {
        owners.push(
          `function mutate${String(index)}(target){mutate${String(index - 1)}(target);mutate${String(index - 1)}(target)}`
        );
      }
      const source = `${owners.join('')}const target={run:()=>0};mutate15(target);target.run();`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(expected);
    }
  );

  it('memoizes shared delegated receiver-mutation descendants', () => {
    const source =
      'function leaf(target){target.run=()=>fetch("https://invalid.example")}function left(target){leaf(target)}function right(target){leaf(target)}function root(target){left(target);right(target)}const target={run:()=>0};root(target);target.run()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('terminates a recursive delegated receiver-mutation cycle', () => {
    const source =
      'function first(target){target.run=()=>fetch("https://invalid.example");second(target)}function second(target){first(target)}const target={run:()=>0};first(target);target.run()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    'function invoke(fn){return fn()}invoke(()=>fetch)("https://invalid.example")',
    'function invoke(owner){return owner?.fn?.()}invoke({fn:()=>fetch})("https://invalid.example")',
    'function run(params){params.effect("https://invalid.example")}run({effect:fetch})',
    'function run(params){params?.effect?.("https://invalid.example")}run({effect:fetch})',
  ])(
    'detects a load effect propagated through a call result (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it('keeps returned factory bindings scoped to their call site', () => {
    const source =
      'function outer(value){return()=>value}const bad=outer(()=>fetch("https://invalid.example")),safe=outer(()=>undefined);safe();bad()();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('does not leak an unused hazardous factory binding into a safe call', () => {
    const source =
      'function outer(value){return()=>value}const bad=outer(()=>fetch("https://invalid.example")),safe=outer(()=>undefined);bad();safe()();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'rest parameter',
      'function make(...runs){return()=>runs[0]()}make(()=>fetch("https://invalid.example"))()',
    ],
    [
      'implicit arguments',
      'function make(){return()=>arguments[0]()}make(()=>fetch("https://invalid.example"))()',
    ],
    [
      'rest parameter alias',
      'function make(...runs){const values=runs;return()=>values[0]()}make(()=>fetch("https://invalid.example"))()',
    ],
    [
      'implicit arguments alias',
      'function make(){const values=arguments;return()=>values[0]()}make(()=>fetch("https://invalid.example"))()',
    ],
    [
      'assignment-created rest parameter alias',
      'function make(...runs){let values;values=runs;return()=>values[0]()}make(()=>fetch("https://invalid.example"))()',
    ],
    [
      'assignment-created implicit arguments alias',
      'function make(){let values;values=arguments;return()=>values[0]()}make(()=>fetch("https://invalid.example"))()',
    ],
    [
      'destructured rest parameter',
      'function make(...runs){const [run]=runs;return()=>run()}make(()=>fetch("https://invalid.example"))()',
    ],
    [
      'destructured implicit arguments',
      'function make(){const [run]=arguments;return()=>run()}make(()=>fetch("https://invalid.example"))()',
    ],
  ])(
    'detects an immediately invoked returned closure capturing %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it('propagates an assignment-created rest alias into a returned mutation operand', () => {
    const source =
      'function make(...args){let value;value=args[1];return()=>{args[0].run=value}}const target={run:()=>0};make(target,()=>fetch("https://invalid.example"))();target.run()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('uses the latest assignment-created returned-factory alias', () => {
    const source =
      'function make(...runs){let values=runs;values=[];return()=>values[0]?.()}make(()=>fetch("https://invalid.example"))()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('retains a possible returned-factory alias write after a definite write', () => {
    const source =
      'function make(...runs){let values=[];values=[];if(globalThis.flag)values=runs;return()=>values[0]?.()}make(()=>fetch("https://invalid.example"))()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'function make(run){let value=run;if(globalThis.flag)return()=>value();value=()=>0;return()=>value()}make(()=>fetch("https://invalid.example"))()',
    'function make(...runs){let values=runs;if(globalThis.flag)return()=>values[0]?.();values=[];return()=>values[0]?.()}make(()=>fetch("https://invalid.example"))()',
    'function make(run){const value=run;return()=>()=>value()}make(()=>fetch("https://invalid.example"))()()',
    'function make(...runs){let values;values=runs;return()=>()=>values[0]()}make(()=>fetch("https://invalid.example"))()()',
  ])('preserves a capture across returned-factory layers (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('keeps nested returned-factory aliases scoped to the invoked call site', () => {
    const source =
      'function make(run){const value=run;return()=>()=>value()}const bad=make(()=>fetch("https://invalid.example")),safe=make(()=>0);bad();safe()()()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'function outer(run){const value=run;function inner(){value()}inner()}outer(()=>fetch("https://nested-alias.invalid.example"))',
    'function outer(run){let value;value=run;function inner(){value()}inner()}outer(()=>fetch("https://nested-assignment-alias.invalid.example"))',
    'function outer(...runs){const values=runs;function inner(){values[0]()}inner()}outer(()=>fetch("https://nested-rest-alias.invalid.example"))',
    'function outer(){const values=arguments;function inner(){values[0]()}inner()}outer(()=>fetch("https://nested-arguments-alias.invalid.example"))',
  ])(
    'preserves an outer capture in an ordinary nested owner (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    'function make(run){return new Proxy(run,{})}make(()=>fetch("https://returned-proxy.invalid.example"))()',
    'function make(run){return new Proxy(run,{})}const proxy=make(()=>fetch("https://stored-returned-proxy.invalid.example"));proxy()',
    'function make(run){return Proxy.revocable(run,{}).proxy}make(()=>fetch("https://returned-revocable-proxy.invalid.example"))()',
  ])('preserves a returned Proxy target capture (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'function make(handler){return new Proxy(()=>0,handler)}make({apply(){return fetch("https://returned-handler.invalid.example")}})()',
    'function make(handler){return Proxy.revocable(()=>0,handler).proxy}make({apply(){return fetch("https://returned-revocable-handler.invalid.example")}})()',
    'function make(options){return Proxy.revocable(options.target,options.handler).proxy}make({target:()=>0,handler:{apply(){return fetch("https://returned-projected-revocable-apply.invalid.example")}}})()',
    'function make(options){return Proxy.revocable(options.target,options.handler).proxy}new (make({target:function(){},handler:{construct(){fetch("https://returned-projected-revocable-construct.invalid.example");return {}}}}))()',
    'function make(options){const {proxy}=Proxy.revocable(options.target,options.handler);return proxy}make({target:()=>0,handler:{apply(){return fetch("https://returned-destructured-revocable-apply.invalid.example")}}})()',
    'function make(options){const {proxy}=Proxy.revocable(options.target,options.handler);return proxy}new (make({target:function(){},handler:{construct(){fetch("https://returned-destructured-revocable-construct.invalid.example");return {}}}}))()',
    'function make(){const handler={apply(){return fetch("https://returned-local-handler.invalid.example")}};return new Proxy(()=>0,handler)}make()()',
    'function make(run){const value=run;return new Proxy(value,{})}make(()=>fetch("https://returned-proxy-alias.invalid.example"))()',
    'function make(run){const value=run;return()=>new Proxy(()=>0,{apply(){return value()}})}make(()=>fetch("https://returned-trap-alias.invalid.example"))()()',
  ])('preserves a returned Proxy handler or alias capture (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'function make(run){const value=run;return new Proxy({},{get(){value();return 0}})}make(()=>fetch("https://returned-get-trap-alias.invalid.example")).value',
    'function make(run){const value=run;return new Proxy({},{set(){value();return true}})}const proxy=make(()=>fetch("https://returned-set-trap-alias.invalid.example"));proxy.value=1',
  ])(
    'preserves an alias captured by a returned Proxy property trap (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    'function make(...handlers){return new Proxy({},handlers[0])}make({get(){return fetch("https://returned-rest-get-handler.invalid.example")}}).value',
    'function make(){return new Proxy({},arguments[0])}make({get(){return fetch("https://returned-arguments-get-handler.invalid.example")}}).value',
    'function make(...handlers){const values=handlers;return new Proxy({},values[0])}make({set(){return fetch("https://returned-rest-set-handler.invalid.example")}}).value=1',
  ])('projects a returned Proxy property handler capture (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'function make(target){return new Proxy(target,{})}make({get value(){return fetch("https://returned-get-target.invalid.example")}}).value',
    'function make(target){return new Proxy(target,{})}make({set value(next){fetch("https://returned-set-target.invalid.example")}}).value=1',
    'function make(target){const value=target;return new Proxy(value,{})}make({get value(){return fetch("https://returned-alias-target.invalid.example")}}).value',
    'function make(...targets){return new Proxy(targets[0],{})}make({get value(){return fetch("https://returned-rest-target.invalid.example")}}).value',
    'function make(run){const value=run;const target={get value(){value();return 0}};return new Proxy(target,{})}make(()=>fetch("https://returned-local-target.invalid.example")).value',
  ])(
    'forwards a returned Proxy property operation to its target (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    'function make(run){let value=run;value=()=>0;return new Proxy({},{get(){value();return 0}})}make(()=>fetch("https://overwritten-get-trap.invalid.example")).value',
    'function make(run){let value=run;value=()=>0;return new Proxy({},{set(){value();return true}})}make(()=>fetch("https://overwritten-set-trap.invalid.example")).value=1',
    'function make(run){let value=run;value=()=>0;return new Proxy(()=>0,{apply(){value();return 0}})}make(()=>fetch("https://overwritten-apply-trap.invalid.example"))()',
    'function make(run){let value=run;value=()=>0;return new Proxy(function(){},{construct(){value();return {}}})}new (make(()=>fetch("https://overwritten-construct-trap.invalid.example")))()',
    'function make(run){let handler={get(){run();return 0}};handler={get(){return 0}};return new Proxy({},handler)}make(()=>fetch("https://overwritten-get-handler.invalid.example")).value',
  ])(
    'ignores a definitely overwritten returned Proxy capture (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it('retains a possibly overwritten returned Proxy capture', () => {
    const source =
      'function make(run){let value=()=>0;if(globalThis.flag)value=run;return new Proxy({},{get(){value();return 0}})}make(()=>fetch("https://conditional-get-trap.invalid.example")).value';

    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'function make(...runs){return new Proxy(runs[0],{})}make(()=>fetch("https://returned-rest-proxy.invalid.example"))()',
    'function make(){return new Proxy(arguments[0],{})}make(()=>fetch("https://returned-arguments-proxy.invalid.example"))()',
    'function make(...runs){const values=runs;return new Proxy(values[0],{})}make(()=>fetch("https://returned-rest-alias-proxy.invalid.example"))()',
    'function make(...handlers){return new Proxy(()=>0,handlers[0])}make({apply(){return fetch("https://returned-rest-handler.invalid.example")}})()',
    'function make(){return new Proxy(()=>0,arguments[0])}make({apply(){return fetch("https://returned-arguments-handler.invalid.example")}})()',
  ])('projects a returned Proxy target or handler capture (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'function make(run,handler){return new Proxy(run,handler)}make(()=>fetch("https://suppressed-returned-proxy.invalid.example"),{apply(){return 0}})()',
    'function make(run){const handler={apply(){return 0}};return new Proxy(run,handler)}make(()=>fetch("https://suppressed-local-handler.invalid.example"))()',
  ])('honors a suppressing returned Proxy handler (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('honors a suppressing projected Proxy handler', () => {
    const source =
      'function make(run,...handlers){return new Proxy(run,handlers[0])}make(()=>fetch("https://suppressed-projected-handler.invalid.example"),{apply(){return 0}})()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'function make(run){return new Proxy(()=>0,{apply(){run();return 0}})}Array.from([1],make(()=>fetch("https://returned-proxy-mapper.invalid.example")))',
    'function make(run){return Proxy.revocable(()=>0,{apply(){run();return 0}}).proxy}Array.from([1],make(()=>fetch("https://returned-revocable-proxy-mapper.invalid.example")))',
    'function make(run){return new Proxy(function(){},{construct(){run();return[]}})}Array.from.call(make(()=>fetch("https://returned-proxy-constructor.invalid.example")),[])',
    'function make(run){return Proxy.revocable(function(){},{construct(){run();return[]}}).proxy}Array.from.call(make(()=>fetch("https://returned-revocable-proxy-constructor.invalid.example")),[])',
    'function make(run){return new Proxy([],{get(target,key,receiver){if(key===Symbol.iterator)run();return Reflect.get(target,key,receiver)}})}Array.from(make(()=>fetch("https://returned-proxy-iterator.invalid.example")))',
    'function make(run){return Proxy.revocable([],{get(target,key,receiver){if(key===Symbol.iterator)run();return Reflect.get(target,key,receiver)}}).proxy}Array.from(make(()=>fetch("https://returned-revocable-proxy-iterator.invalid.example")))',
    'function make(options){return new Proxy(options.target,options.handler)}Array.from(make({target:[],handler:{get(target,key,receiver){fetch("https://returned-projected-proxy-iterator.invalid.example");return Reflect.get(target,key,receiver)}}}))',
    'function make(options){return Proxy.revocable(options.target,options.handler).proxy}Array.from(make({target:[],handler:{get(target,key,receiver){fetch("https://returned-projected-revocable-iterator.invalid.example");return Reflect.get(target,key,receiver)}}}))',
  ])('preserves a returned Proxy used by Array.from (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const values=new Proxy([],{get(target,key,receiver){return Reflect.get(target,fetch("https://proxy-get-key-effect.invalid.example"),receiver)}});Array.from(values)',
    'const values=new Proxy([],{get(target,key,receiver){return Reflect.get(target,(fetch("https://proxy-get-comma-key-effect.invalid.example"),key),receiver)}});Array.from(values)',
    'function make(run){return new Proxy([],{get(target,key,receiver){return Reflect.get(target,(run(),key),receiver)}})}Array.from(make(()=>fetch("https://returned-proxy-get-key-effect.invalid.example")))',
    'const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,(fetch("https://proxy-apply-this-effect.invalid.example"),thisArg),args)}});call()',
    'const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply((fetch("https://proxy-apply-target-effect.invalid.example"),target),thisArg,args)}});call()',
    'const Construct=new Proxy(function(){},{construct(target,args,newTarget){return Reflect.construct(target,(fetch("https://proxy-construct-args-effect.invalid.example"),args),newTarget)}});new Construct()',
    'const handler={get get(){fetch("https://proxy-iterator-trap-getter.invalid.example");return(target,key,receiver)=>Reflect.get(target,key,receiver)}},values=new Proxy([],handler);Array.from(values)',
    'const handler={get get(){fetch("https://proxy-iterator-missing-trap-getter.invalid.example");return undefined}},values=new Proxy([],handler);Array.from(values)',
    'function make(run){const handler={get get(){run();return(target,key,receiver)=>Reflect.get(target,key,receiver)}};return new Proxy([],handler)}Array.from(make(()=>fetch("https://returned-proxy-iterator-trap-getter.invalid.example")))',
    'const handler={get apply(){fetch("https://proxy-apply-trap-getter.invalid.example");return undefined}},call=new Proxy(()=>0,handler);call()',
    'const handler={get apply(){fetch("https://proxy-apply-noncallable-trap-getter.invalid.example");return {}}},call=new Proxy(()=>0,handler);call()',
    'const handler={get construct(){fetch("https://proxy-construct-trap-getter.invalid.example");return null}},Construct=new Proxy(function(){},handler);new Construct()',
    'Reflect.apply=()=>fetch("https://mutated-reflect-apply.invalid.example");const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});call()',
    'Object.defineProperty(Reflect,"apply",{value:()=>fetch("https://defined-reflect-apply.invalid.example")});const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});call()',
    'Reflect.construct=()=>fetch("https://mutated-reflect-construct.invalid.example");const Construct=new Proxy(function(){},{construct(target,args,newTarget){return Reflect.construct(target,args,newTarget)}});new Construct()',
    'Reflect.get=()=>fetch("https://mutated-reflect-get.invalid.example");const values=new Proxy([],{get(target,key,receiver){return Reflect.get(target,key,receiver)}});Array.from(values)',
    'Reflect.get=()=>fetch("https://mutated-reflect-property-get.invalid.example");const proxy=new Proxy({},{get(target,key,receiver){return Reflect.get(target,key,receiver)}});proxy.value',
    'Reflect.set(Reflect,"apply",()=>fetch("https://reflect-set-apply.invalid.example"));const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});call()',
    'Object.assign(Reflect,{construct:()=>{fetch("https://object-assign-construct.invalid.example");return {}}});const Construct=new Proxy(function(){},{construct(target,args,newTarget){return Reflect.construct(target,args,newTarget)}});new Construct()',
    'Object.defineProperties(Reflect,{get:{value:()=>fetch("https://define-properties-get.invalid.example")}});const values=new Proxy([],{get(target,key,receiver){return Reflect.get(target,key,receiver)}});Array.from(values)',
    'const RuntimeReflect=Reflect;RuntimeReflect.construct=()=>{fetch("https://aliased-reflect-construct.invalid.example");return {}};const Construct=new Proxy(function(){},{construct(target,args,newTarget){return Reflect.construct(target,args,newTarget)}});new Construct()',
    'Reflect.construct=()=>{fetch("https://captured-reflect-construct.invalid.example");return {}};const construct=Reflect.construct,Construct=new Proxy(function(){},{construct(target,args,newTarget){return construct(target,args,newTarget)}});new Construct()',
  ])(
    'preserves effects in a non-transparent Reflect Proxy trap (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    'const original=Reflect.apply;Reflect.apply=()=>fetch("https://restored-reflect-apply.invalid.example");Reflect.apply=original;const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});call()',
    'Reflect.apply=()=>fetch("https://overwritten-reflect-apply.invalid.example");Reflect.apply=()=>0;const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});call()',
    'Reflect.get=()=>fetch("https://overwritten-reflect-get.invalid.example");Reflect.get=()=>0;const values=new Proxy([],{get(target,key,receiver){return Reflect.get(target,key,receiver)}});Array.from(values)',
    'const call=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});call();Reflect.apply=()=>fetch("https://later-reflect-apply.invalid.example")',
  ])(
    'uses the current Reflect Proxy operation implementation (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it.each([
    [
      'Reflect.apply=()=>0;const call=new Proxy(()=>fetch("https://suppressed-reflect-apply-target.invalid.example"),{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});call()',
      'fetch("https://suppressed-reflect-apply-target.invalid.example")',
    ],
    [
      'Reflect.construct=()=>({});const Construct=new Proxy(function(){fetch("https://suppressed-reflect-construct-target.invalid.example")},{construct(target,args,newTarget){return Reflect.construct(target,args,newTarget)}});new Construct()',
      'fetch("https://suppressed-reflect-construct-target.invalid.example")',
    ],
    [
      'Reflect.get=()=>0;const target={get [Symbol.iterator](){fetch("https://suppressed-reflect-get-target.invalid.example")}},values=new Proxy(target,{get(target,key,receiver){return Reflect.get(target,key,receiver)}});Array.from(values)',
      'fetch("https://suppressed-reflect-get-target.invalid.example")',
    ],
    [
      'Reflect.get=()=>0;const target={get value(){fetch("https://suppressed-reflect-property-target.invalid.example")}},proxy=new Proxy(target,{get(target,key,receiver){return Reflect.get(target,key,receiver)}});proxy.value',
      'fetch("https://suppressed-reflect-property-target.invalid.example")',
    ],
  ])(
    'does not fall through a safe Reflect Proxy replacement (%s)',
    (source, targetEffect) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toContain(
        targetEffect
      );
    }
  );

  it.each([
    [
      'const handler={get apply(){fetch("https://proxy-apply-lookup.invalid.example");return {}}},call=new Proxy(()=>fetch("https://suppressed-proxy-apply-target.invalid.example"),handler);call()',
      'fetch("https://proxy-apply-lookup.invalid.example")',
      'fetch("https://suppressed-proxy-apply-target.invalid.example")',
    ],
    [
      'const handler={get construct(){fetch("https://proxy-construct-lookup.invalid.example");return {}}},Construct=new Proxy(function(){fetch("https://suppressed-proxy-construct-target.invalid.example")},handler);new Construct()',
      'fetch("https://proxy-construct-lookup.invalid.example")',
      'fetch("https://suppressed-proxy-construct-target.invalid.example")',
    ],
    [
      'const handler={get get(){fetch("https://proxy-iterator-lookup.invalid.example");return {}}},target={[Symbol.iterator](){fetch("https://suppressed-proxy-iterator-target.invalid.example")}},values=new Proxy(target,handler);Array.from(values)',
      'fetch("https://proxy-iterator-lookup.invalid.example")',
      'fetch("https://suppressed-proxy-iterator-target.invalid.example")',
    ],
  ])(
    'stops after a noncallable Proxy trap lookup (%s)',
    (source, lookupEffect, targetEffect) => {
      const effects = inspectCloudflareLoadEffectsForTesting(source);
      expect(effects).toContain(lookupEffect);
      expect(effects).not.toContain(targetEffect);
    }
  );

  it.each([
    'function make(run){return()=>Array.from([0],()=>run())}make(()=>fetch("https://returned-array-from-capture.invalid.example"))()',
    'function invoke(run){const box={run};Array.from([0],()=>box.run())}invoke(()=>fetch("https://array-from-object-capture.invalid.example"))',
  ])('preserves a nested Array.from callback capture (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it('preserves a structured alias in a returned owner', () => {
    const source =
      'function make(run){const box={run};return()=>box.run()}make(()=>fetch("https://returned-object-capture.invalid.example"))()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'function make(run){return new Proxy(run,{})}const bad=make(()=>fetch("https://dormant-returned-proxy.invalid.example")),safe=make(()=>0);safe()',
    'function make(run){return()=>Array.from([0],()=>run())}const bad=make(()=>fetch("https://dormant-returned-array-from.invalid.example")),safe=make(()=>0);safe()',
  ])('keeps a dormant captured callback isolated (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('preserves an alias captured by a returned named owner', () => {
    const source =
      'function make(run){const value=run;function inner(){value()}return inner}make(()=>fetch("https://returned-named-owner.invalid.example"))()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it('preserves an implicit-arguments alias captured by a returned named owner', () => {
    const source =
      'function make(){const values=arguments;function inner(){values[0]()}return inner}make(()=>fetch("https://returned-named-arguments-owner.invalid.example"))()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it('ignores an unreachable returned Proxy branch', () => {
    const source =
      'function make(bad,safe){if(false)return new Proxy(bad,{});return new Proxy(safe,{})}make(()=>fetch("https://unreachable-returned-proxy.invalid.example"),()=>0)()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'new Proxy(()=>()=>fetch("https://proxy-result-target.invalid.example"),{})()()',
    'new Proxy(()=>()=>fetch("https://proxy-result-undefined-trap.invalid.example"),{apply:undefined})()()',
    'new Proxy(()=>0,{apply(){return()=>fetch("https://proxy-result-trap.invalid.example")}})()()',
    'const safe=()=>()=>0,select=globalThis.flag?safe:new Proxy(()=>()=>fetch("https://conditional-proxy-result.invalid.example"),{});function make(){return select()}make()()',
  ])('preserves a callable result returned through a Proxy (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'new Proxy(()=>()=>fetch("https://suppressed-proxy-result.invalid.example"),{apply(){return()=>0}})()()',
    'new Proxy(()=>()=>fetch("https://noncallable-proxy-result.invalid.example"),{apply:1})()()',
    'const bad=new Proxy(()=>()=>fetch("https://dormant-proxy-result.invalid.example"),{}),safe=()=>()=>0;safe()()',
  ])('does not invent a suppressed or dormant Proxy result (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('orders an assignment-created member after its returned lexical-this mutation', () => {
    const source =
      'const factory={make(run){return()=>{this.run=run}}};factory.run=()=>0;factory.make(()=>fetch("https://invalid.example"))();factory.run()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('keeps an indirect descendant mutation fail-closed across shared call sites', () => {
    const source =
      'function mutate(value,run){value.run=run}const root={child:{run:()=>0}},alias=mutate;mutate(root,()=>undefined);alias(root.child,()=>fetch("https://invalid.example"));root.child.run();';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    'const target={run:()=>0};function mutate(owner,value){owner.run=value}function outer(effect){mutate(target,effect)}outer(()=>fetch("https://invalid.example"));target.run()',
    'function outer(secret){function init(target){Object.defineProperty(target,"run",{value:()=>secret()})}return target=>init(target)}const apply=outer(()=>fetch("https://invalid.example")),target={};apply(target);target.run()',
    'function make(run){return target=>Object.defineProperty(target,"run",{value:run})}const first={},second={};make(()=>undefined)(first);make(()=>fetch("https://invalid.example"))(second);second.run()',
  ])('preserves a captured mutation callback (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('resolves a directly invoked escaped factory result', () => {
    const source =
      'function make(run){return target=>Object.defineProperty(target,"run",{value:run})}const target={},mutate=make(()=>fetch("https://invalid.example"));mutate(target);target.run()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'function make(){return target=>Object.defineProperty(target,"run",{value:this.run})}const target={};make.call({run:()=>undefined})(target);target.run()',
    'function make(){return target=>Object.defineProperty(target,"run",{value:this.run})}const target={};make.apply({run:()=>undefined},[])(target);target.run()',
    'function make(){return target=>Object.defineProperty(target,"run",{value:()=>arguments[0]()})}const target={};make(()=>undefined)(target);target.run()',
    'function make(...runs){return target=>Object.defineProperty(target,"run",{value:()=>runs[0]()})}const target={};make(()=>undefined)(target);target.run()',
    'function make(run){run=()=>undefined;return target=>Object.defineProperty(target,"run",{value:()=>run()})}const target={};make(()=>undefined)(target);target.run()',
    'function make(run,replace){if(replace)run=()=>undefined;return target=>Object.defineProperty(target,"run",{value:()=>run()})}const target={};make(()=>undefined,false)(target);target.run()',
  ])(
    'fails closed for an escaped or lexical-this factory result (%s)',
    (source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it.each([
    'const target={run:()=>0};function mutate(owner,value){owner.run=value}function outer(effect){mutate(target,effect)}outer(()=>undefined);target.run()',
    'function outer(secret){function init(target){Object.defineProperty(target,"run",{value:()=>secret()})}return target=>init(target)}const apply=outer(()=>undefined),target={};apply(target);target.run()',
    'function run(params){params?.effect?.("https://invalid.example")}run({effect:()=>undefined})',
  ])('keeps a safe propagated callback inert (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'const target={run:()=>0};function mutate(owner,value){owner.run=value}function make(fn){return(owner,value)=>fn(owner,value)}const invoke=make(mutate);invoke(target,()=>fetch("https://invalid.example"));target.run()',
    'const target={run:()=>0};function mutate(owner,value){owner.run=value}function make(fn){return(owner,value)=>fn(owner,value)}const invoke=make(mutate);invoke(target,()=>undefined);target.run()',
  ])(
    'fails closed for a captured factory-dispatched mutation (%s)',
    (source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it.each([
    'const owner=null;owner?.run(fetch("https://invalid.example"))',
    'const owner=null;owner?.[fetch("https://invalid.example")]',
    'const owner={run:null};owner.run?.(fetch("https://invalid.example"))',
  ])(
    'does not evaluate a statically skipped optional operand (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it('retains an optional operand when the receiver is unknown', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'owner?.run(fetch("https://invalid.example"))'
      )
    ).toEqual(['fetch("https://invalid.example")']);
  });

  it.each([
    [
      'an earlier hazardous source',
      `
        function assign(target, source) { Object.assign(target, source) }
        const first = { run: () => 0 };
        const second = { run: () => 0 };
        assign(first, { run: () => fetch('https://invalid.example') });
        assign(second, { run: () => 0 });
        second.run();
      `,
      [],
    ],
    [
      'a later hazardous source',
      `
        function assign(target, source) { Object.assign(target, source) }
        const first = { run: () => 0 };
        const second = { run: () => 0 };
        assign(first, { run: () => 0 });
        assign(second, { run: () => fetch('https://invalid.example') });
        second.run();
      `,
      ["fetch('https://invalid.example')"],
    ],
  ])(
    'keeps Object.assign receiver and source operands correlated with %s',
    (_label, source, expected) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(expected);
    }
  );

  it.each([
    [
      'a later hazardous call',
      `
        assign(target, { run: () => 0 });
        target.run();
        assign(target, { run: () => fetch('https://invalid.example') });
      `,
      [],
    ],
    [
      'an earlier hazardous call',
      `
        assign(target, { run: () => fetch('https://invalid.example') });
        target.run();
        assign(target, { run: () => 0 });
      `,
      ["fetch('https://invalid.example')"],
    ],
  ])(
    'preserves a concrete mutation callsite before an intervening read with %s',
    (_label, body, expected) => {
      const source = `
        function assign(target, source) { Object.assign(target, source) }
        const target = { run: () => 0 };
        ${body}
      `;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(expected);
    }
  );

  it('keeps a safe nested descriptor member independent from a peer parameter', () => {
    const source = `
      function install(target, source) {
        Object.defineProperty(target, 'box', {
          value: { safe: () => 0, other: source },
        });
      }
      const target = {};
      install(target, () => fetch('https://invalid.example'));
      target.box.safe();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('resolves a selected nested descriptor parameter at its callsite', () => {
    const source = `
      function install(target, source) {
        Object.defineProperty(target, 'box', {
          value: { safe: () => 0, other: source },
        });
      }
      const target = {};
      install(target, () => fetch('https://invalid.example'));
      target.box.other();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      "fetch('https://invalid.example')",
    ]);
  });

  it.each([
    [
      'an earlier hazardous nested value',
      `
        install(first, () => fetch('https://invalid.example'));
        install(second, () => 0);
      `,
      [],
    ],
    [
      'a later hazardous nested value',
      `
        install(first, () => 0);
        install(second, () => fetch('https://invalid.example'));
      `,
      ["fetch('https://invalid.example')"],
    ],
  ])(
    'keeps nested descriptor operands correlated with %s',
    (_label, invocations, expected) => {
      const source = `
        function install(target, source) {
          Object.defineProperty(target, 'box', {
            value: { safe: () => 0, other: source },
          });
        }
        const first = {};
        const second = {};
        ${invocations}
        second.box.other();
      `;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(expected);
    }
  );

  it('tracks aliased receivers through a static callback parameter', () => {
    const source =
      'function invoke(callback,target){callback(target,target)}invoke((first,second)=>{Object.defineProperty(first,"run",{value:()=>fetch("https://invalid.example")});second.run()},{});';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('retains an analyzable branch when a local mutator may be invoked through an export', () => {
    const source =
      'function mutate(target){Object.defineProperty(target,"run",{value:()=>fetch("https://invalid.example")})}const first={};const second={run:()=>0};mutate(first);second.run();export{mutate};';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'named declaration export',
      'export function mutate(target){Object.defineProperty(target,"run",{value:()=>fetch("https://invalid.example")})}const first={};const second={run:()=>0};mutate(first);second.run();',
    ],
    [
      'default declaration export',
      'export default function mutate(target){Object.defineProperty(target,"run",{value:()=>fetch("https://invalid.example")})}const first={};const second={run:()=>0};mutate(first);second.run();',
    ],
  ])('retains an analyzable branch for a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('retains fail-closed behavior for an opaque exported mutation', () => {
    const source =
      'export function mutate(target,key,value){Object.defineProperty(target,key,{value})}const first={};const second={run:()=>0};mutate(first,"safe",()=>0);second.run();';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    [
      'named specifier',
      'function mutate(target,key,value){Object.defineProperty(target,key,{value})}export{mutate};',
      'mutate(first,"safe",()=>0);',
    ],
    [
      'default specifier',
      'function mutate(target,key,value){Object.defineProperty(target,key,{value})}export{mutate as default};',
      'mutate(first,"safe",()=>0);',
    ],
    [
      'exported arrow binding',
      'export const mutate=(target,key,value)=>Object.defineProperty(target,key,{value});',
      'mutate(first,"safe",()=>0);',
    ],
    [
      'aliased binding',
      'const install=(target,key,value)=>Object.defineProperty(target,key,{value});const mutate=install;export{mutate};',
      'mutate(first,"safe",()=>0);',
    ],
    [
      'anonymous default',
      'export default function(target,key,value){Object.defineProperty(target,key,{value})}',
      '',
    ],
  ])(
    'retains fail-closed behavior for an opaque %s export',
    (_label, exportSource, invocation) => {
      const source = `${exportSource}const first={};const second={run:()=>0};${invocation}second.run();`;

      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it.each([
    [
      'object variable declaration',
      'const first={run:()=>0};const {target}={target:first};function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
    [
      'array variable declaration',
      'const first={run:()=>0};const [target]=[first];function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
    [
      'object assignment',
      'const first={run:()=>0};let target;({target}={target:first});function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
    [
      'array assignment',
      'const first={run:()=>0};let target;[target]=[first];function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
  ])('links receiver identity through an %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'object default',
      'const first={run:()=>0};const {target=first}={};function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
    [
      'array default',
      'const first={run:()=>0};const [target=first]=[];function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
    [
      'object assignment default',
      'const first={run:()=>0};let target;({target=first}={});function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
    [
      'array assignment default',
      'const first={run:()=>0};let target;[target=first]=[];function mutate(value){value.run=()=>fetch("https://invalid.example")}mutate(target);first.run();',
    ],
  ])('fails closed for a destructured %s receiver', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    ['direct member assignment', 'box.target=first'],
    ['array member assignment', 'box[0]=first', 'box[0]'],
    [
      'Object.defineProperty',
      'Object.defineProperty(box,"target",{value:first})',
    ],
    ['Object.assign', 'Object.assign(box,{target:first})'],
    ['Reflect.set', 'Reflect.set(box,"target",first)'],
    [
      'Object.defineProperties',
      'Object.defineProperties(box,{target:{value:first}})',
    ],
  ])(
    'links receiver identity through %s',
    (_label, install, targetExpression = 'box.target') => {
      const source = `
        const first={run:()=>0};
        const box={};
        ${install};
        function mutate(value){value.run=()=>fetch("https://invalid.example")}
        mutate(${targetExpression});
        first.run();
      `;
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
        'fetch("https://invalid.example")',
      ]);
    }
  );

  it('resolves an aggregate member alias when reading a prior mutation', () => {
    const source = `
      const first={run:()=>0};
      const box={};
      box.target=first;
      function mutate(value){value.run=()=>fetch("https://invalid.example")}
      mutate(first);
      box.target.run();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('conservatively tracks a receiver through an unmodeled array mutation', () => {
    const source = `
      const first={run:()=>0};
      const box=[];box.push(first);
      function mutate(value){value.run=()=>fetch("https://invalid.example")}
      mutate(box[0]);
      first.run();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('tracks a receiver through a statically resolved local helper mutation', () => {
    const source = `
      const first={run:()=>0};
      const box={};
      function put(container,value){container.target=value}
      put(box,first);
      function mutate(value){value.run=()=>fetch("https://invalid.example")}
      mutate(box.target);
      first.run();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'Object.assign',
      'function put(box,value){Object.assign(box,{target:value})}',
      'put(box,first)',
    ],
    [
      'Reflect.set',
      'function put(box,value){Reflect.set(box,"target",value)}',
      'put(box,first)',
    ],
    [
      'Object.defineProperty',
      'function put(box,value){Object.defineProperty(box,"target",{value})}',
      'put(box,first)',
    ],
    [
      'delegated helper',
      'function write(box,value){box.target=value}function put(box,value){write(box,value)}',
      'put(box,first)',
    ],
    [
      'destructured parameter',
      'function put({box},value){box.target=value}',
      'put({box},first)',
    ],
    [
      'object-member alias',
      'function store(box,value){box.target=value}const service={store}',
      'service.store(box,first)',
    ],
  ])(
    'tracks a receiver through a local %s mutation',
    (_label, helper, invocation) => {
      const source = `
        const first={run:()=>0};
        const box={};
        ${helper};
        ${invocation};
        function mutate(value){value.run=()=>fetch("https://invalid.example")}
        mutate(box.target);
        first.run();
      `;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
        'fetch("https://invalid.example")',
      ]);
    }
  );

  it('keeps a well-known Symbol member mutation isolated from string members', () => {
    const source = `
      const target={run:()=>0};
      Object.defineProperty(target,Symbol.hasInstance,{
        value:()=>fetch("https://invalid.example")
      });
      target.run();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('resolves a well-known Symbol member mutation at a computed read', () => {
    const source = `
      const target={};
      Object.defineProperty(target,Symbol.hasInstance,{
        value:()=>fetch("https://invalid.example")
      });
      target[Symbol.hasInstance]();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('executes an installed defineProperty getter when its member is read', () => {
    const source = `
      const target={};
      Object.defineProperty(target,"run",{
        get:()=>fetch("https://invalid.example")
      });
      target.run;
    `;

    const effects = inspectCloudflareLoadEffectsForTesting(source);
    expect(effects).toHaveLength(2);
    expect(effects[0]).toContain('Object.defineProperty');
    expect(effects[1]).toBe('fetch("https://invalid.example")');
  });

  it('does not invoke a setter-only defineProperty member when read', () => {
    const source = `
      const target={};
      Object.defineProperty(target,"run",{set:()=>undefined});
      target.run;
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('keeps a defineProperty getter isolated from another static member', () => {
    const source = `
      const target={safe:()=>0};
      Object.defineProperty(target,"run",{
        get:()=>fetch("https://invalid.example")
      });
      target.safe();
    `;

    const effects = inspectCloudflareLoadEffectsForTesting(source);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toContain('Object.defineProperty');
  });

  it('fails closed before spreading an accessor-bearing defineProperties source', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const source={};Object.defineProperties(source,{effect:{enumerable:true,get(){fetch("https://invalid.example");return 1}}});const target={...source};'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('rejects accessor-bearing defineProperties during destructuring', () => {
    const effects = inspectCloudflareLoadEffectsForTesting(
      'const source={},descriptor={enumerable:true,get(){fetch("https://invalid.example");return 1}};Object.defineProperties(source,{effect:descriptor});const {effect}=source;'
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]).toContain('Object.defineProperties');
  });

  it.each([
    'const source={get effect(){fetch("https://invalid.example");return 1}};Object.values(source);',
    'const source={get effect(){fetch("https://invalid.example");return 1}};Object.entries(source);',
    'const source={get effect(){fetch("https://invalid.example");return 1}};JSON.stringify(source);',
    'const source={get effect(){fetch("https://invalid.example");return 1}};structuredClone(source);',
    'const source={get effect(){fetch("https://invalid.example");return 1}},values=Object.values;values.call(null,source);',
  ])('rejects a reflective getter read (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it('allows reflective reads of a static data object', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const source={effect:1};Object.values(source);JSON.stringify(source);'
      )
    ).toEqual([]);
  });

  it.each([
    'const source={};source.effect={get nested(){fetch("https://invalid.example");return 1}};JSON.stringify(source);',
    'const source={};Reflect.set(source,"effect",{get nested(){fetch("https://invalid.example");return 1}});structuredClone(source);',
    'const source={};Object.defineProperty(source,"effect",{enumerable:true,value:{get nested(){fetch("https://invalid.example");return 1}}});JSON.stringify(source);',
    'const source=[];source[0]={get nested(){fetch("https://invalid.example");return 1}};structuredClone(source);',
    'const source=[];source.push({get nested(){fetch("https://invalid.example");return 1}});structuredClone(source);',
    'const source=[];source.toJSON=()=>fetch("https://invalid.example");JSON.stringify(source);',
    'const key=new String("effect");key.toString=()=>{fetch("https://invalid.example");return "effect"};const replacer=[];replacer.push(key);JSON.stringify({effect:1},replacer);',
    'const transfer=[];transfer[Symbol.iterator]=()=>{fetch("https://invalid.example");return [][Symbol.iterator]()};const options={transfer};structuredClone({},options);',
    'structuredClone({},{get transfer(){fetch("https://invalid.example");return []}});',
    'const prototype={get transfer(){fetch("https://invalid.example");return []}};const options={__proto__:prototype};structuredClone({},options);',
    'Array.prototype[Symbol.iterator]=function*(){fetch("https://invalid.example")};structuredClone({},{transfer:[]});',
  ])('rejects a post-construction reflective hook (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'Object.defineProperty(String.prototype,Symbol.iterator,{value:function*(){fetch("https://invalid.example")}});new Set("value")',
    'const prototype=String.prototype;prototype[Symbol.iterator]=function*(){fetch("https://invalid.example")};new Set("value")',
    'const StringAlias=String;StringAlias.prototype[Symbol.iterator]=function*(){fetch("https://invalid.example")};new Set("value")',
    'delete String.prototype[Symbol.iterator];new Set("value")',
    'Reflect.deleteProperty(String.prototype,Symbol.iterator);new Set("value")',
    'function remove(){delete String.prototype[Symbol.iterator]}remove();new Set("value")',
    'delete Array.prototype[Symbol.iterator];new Set([1])',
    'Reflect.deleteProperty(Array.prototype,Symbol.iterator);Object.fromEntries([["effect",1]])',
    'const prototype=Object.getPrototypeOf([][Symbol.iterator]());delete prototype.next;new Set([1])',
    'const prototype=Object.getPrototypeOf([][Symbol.iterator]());Reflect.deleteProperty(prototype,"next");new Set([1])',
    'function mutate(prototype){delete prototype.next}mutate(Object.getPrototypeOf([][Symbol.iterator]()));new Set([1])',
    'function mutate(prototype){prototype.next=undefined}function wrapper(){mutate(Object.getPrototypeOf([][Symbol.iterator]()))}wrapper();new Set([1])',
    'Array.prototype[Symbol.iterator]++;new Set([1])',
    'const prototype=Object.getPrototypeOf([][Symbol.iterator]());prototype.next++;new Set([1])',
    'const prototype=Object.getPrototypeOf([][Symbol.iterator]());prototype.__defineGetter__("next",()=>undefined);new Set([1])',
    'function install(prototype,value){Object.assign(prototype,{next:value})}install(Object.getPrototypeOf([][Symbol.iterator]()),function(){fetch("https://invalid.example");return{done:true}});new Set([])',
  ])('rejects a mutated String iterator prototype (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it('ignores an unreachable String iterator prototype mutation', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'if(false)String.prototype[Symbol.iterator]=function*(){fetch("https://invalid.example")};new Set("value")'
      )
    ).toEqual([]);
  });

  it.each([
    'const values={[Symbol.iterator](){fetch("https://invalid.example");return {next(){return {done:true}}}}};for(const value of values){}',
    'const values={[Symbol.iterator](){return {next(){fetch("https://invalid.example");return {done:true}}}}};for(const value of values){}',
    'const values={[Symbol.iterator](){fetch("https://invalid.example");return {next(){return {done:true}}}}};const [value]=values',
  ])('models general iterator protocol execution (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const [value]=unknown();value()',
    'class Values{};const [value]=new Values();value()',
  ])(
    'fails closed when an opaque iterator element is invoked (%s)',
    (source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'reaches a callable position'
      );
    }
  );

  it.each([
    'const value=unknown();const[first]=value;const fn=flag?value:first;fn()',
    'const value=unknown();const[first]=value;const fn=flag?first:value;fn()',
  ])(
    'retains an opaque iterator marker beside its unmarked source (%s)',
    (source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires a statically analyzable iterator element'
      );
    }
  );

  it.each([
    'const value=new Map();const first=[...value][0];const fn=(flag?value:first).run;fn()',
    'const value=new Map();const first=[...value][0];const fn=(flag?first:value).run;fn()',
  ])(
    'retains an opaque spread marker beside its unmarked receiver (%s)',
    (source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires statically analyzable aggregate spreads reaches a callable position'
      );
    }
  );

  it.each([
    [
      'const safe={};const receiver=globalThis.flag?safe:globalThis;receiver.fetch("https://invalid.example")',
      'receiver.fetch("https://invalid.example")',
    ],
    [
      'const safe={};const receiver=globalThis.flag?globalThis:safe;receiver.fetch("https://invalid.example")',
      'receiver.fetch("https://invalid.example")',
    ],
    [
      'const safe={};const receiver=globalThis.flag?safe:globalThis;receiver["fetch"]("https://invalid.example")',
      'receiver["fetch"]("https://invalid.example")',
    ],
    [
      'const safe={};const receiver=globalThis.flag?globalThis:safe;receiver["fetch"]("https://invalid.example")',
      'receiver["fetch"]("https://invalid.example")',
    ],
    [
      'const safe={api:{}};const hazardous={api:globalThis};const receiver=globalThis.flag?safe:hazardous;receiver.api.fetch("https://invalid.example")',
      'receiver.api.fetch("https://invalid.example")',
    ],
    [
      'const safe={api:{}};const hazardous={api:globalThis};const receiver=globalThis.flag?hazardous:safe;receiver.api.fetch("https://invalid.example")',
      'receiver.api.fetch("https://invalid.example")',
    ],
  ])('retains substituted member receiver identity (%s)', (source, effect) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(effect);
  });

  it.each([
    'const key=globalThis.flag?"noop":"fetch";globalThis[key]("https://invalid.example")',
    'const key=globalThis.flag?"fetch":"noop";globalThis[key]("https://invalid.example")',
  ])('retains normalized computed member identity (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'globalThis[key]("https://invalid.example")'
    );
  });

  it.each([
    'const safe={};const receiver=globalThis.flag?safe:{};receiver.fetch("https://invalid.example")',
    'const key=globalThis.flag?"noop":"toString";globalThis[key]("https://invalid.example")',
  ])('keeps a non-effectful member alternative clean (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'const [value]=unknown();new value()',
    'const [value]=unknown();value`template`',
    'const [value]=unknown();value.run()',
  ])('propagates an opaque iterator element to a %s sink', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires a statically analyzable iterator element'
    );
  });

  it.each([
    'function* values(){yield()=>fetch("https://invalid.example")}const [value]=values();value()',
    'const values=()=>[()=>fetch("https://invalid.example")];const [value]=values();value()',
  ])('retains a precise callable iterator element (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const values={[Symbol.iterator](){return {next(){return {get done(){fetch("https://done.invalid.example");return true}}}}}};for(const value of values){}',
    'const values={[Symbol.iterator](){return {next(){return {done:false,get value(){fetch("https://value.invalid.example");return 1}}}}}};const [value]=values',
    'const values={[Symbol.iterator](){fetch("https://array-from.invalid.example");return [][Symbol.iterator]()}};Array.from(values)',
    'function* values(){fetch("https://array-from-generator.invalid.example")}const current=values();Array.from(current)',
  ])('models observable iterator result access (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const values={[Symbol.iterator](){return {next(){return {done:false,value:1}},get return(){fetch("https://close-get.invalid.example");return function(){fetch("https://close-call.invalid.example")}}}}};for(const value of values){break}',
    'const values={[Symbol.iterator](){return {next(){return {done:false,value:1}},return(){fetch("https://close.invalid.example")}}}};const [value]=values',
    'const values={[Symbol.iterator](){return {next(){fetch("https://unread-next.invalid.example");return {done:false,value:1}},return(){fetch("https://empty-close.invalid.example")}}}};const []=values',
    'const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://continue-close.invalid.example")}}}};outer:for(let index=0;index<1;index++){for(const value of values){continue outer}}',
    'const target={set value(next){throw new Error(String(next))}};const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://assignment-close.invalid.example")}}}};for(target.value of values){}',
    'const target={set value(next){throw new Error(String(next))}};const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://pattern-close.invalid.example")}}}};for([target.value] of values){}',
  ])('models IteratorClose execution (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const values={[Symbol.iterator](){return {next(){return {run(){fetch("https://done-this.invalid.example")},get done(){this.run();return true}}}}}};for(const value of values){}',
    'const values={[Symbol.iterator](){return {next(){return {done:false,value:1}},run(){fetch("https://close-this.invalid.example")},return(){this.run()}}}};for(const value of values){break}',
  ])('preserves iterator protocol receivers (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const values={[Symbol.iterator](){return{next(){fetch("https://parameter.invalid.example");return{done:true}}}}};function take([value]){};take(values)',
    'const inner={[Symbol.iterator](){return{next(){fetch("https://nested.invalid.example");return{done:true}}}}};const [[value]]=[inner]',
    'const inner={[Symbol.iterator](){return{next(){fetch("https://for-declaration.invalid.example");return{done:true}}}}};for(const [value] of [inner]){}',
    'const inner={[Symbol.iterator](){return{next(){fetch("https://for-assignment.invalid.example");return{done:true}}}}};let value;for([value] of [inner]){}',
    'const values={[Symbol.iterator](){return{next(){fetch("https://default-parameter.invalid.example");return{done:true}}}}};function take([value]=values){};take()',
    'const values={[Symbol.iterator](){fetch("https://nested-default.invalid.example");return[][Symbol.iterator]()}};const {value:[nested]=values}={}',
    'const values={[Symbol.iterator](){fetch("https://nested-parameter-default.invalid.example");return[][Symbol.iterator]()}};function take({value:[nested]=values}){};take({})',
    'const values={[Symbol.iterator](){fetch("https://rest-parameter.invalid.example");return[][Symbol.iterator]()}};function take(...[[nested]]){};take(values)',
  ])('models nested and parameter iterator consumption (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const values={[Symbol.iterator](){fetch("https://call.invalid.example");return [][Symbol.iterator]()}};Array.from.call(null,values)',
    'const values={[Symbol.iterator](){fetch("https://apply.invalid.example");return [][Symbol.iterator]()}};Array.from.apply(null,[values])',
    'const values={[Symbol.iterator](){fetch("https://reflect-apply.invalid.example");return [][Symbol.iterator]()}};Reflect.apply(Array.from,null,[values])',
    'const receiver={run(){fetch("https://mapper-this.invalid.example")}};Array.from([1],function(){this.run()},receiver)',
    'const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://mapper-close.invalid.example")}}}};Array.from(values,()=>{throw new Error()})',
    'Array.from({get length(){fetch("https://array-like-length.invalid.example");return 0}})',
    'Array.from({length:1,get 0(){fetch("https://array-like-index.invalid.example");return 1}})',
    'const values={length:1,0:1};Object.defineProperty(values,"0",{get(){fetch("https://array-like-mutated-index.invalid.example")}});Array.from(values)',
    'const flag=globalThis.flag;if(flag)Array.from=()=>[];const values={[Symbol.iterator](){fetch("https://conditional-replacement.invalid.example");return[][Symbol.iterator]()}};Array.from(values)',
    'function fail(){throw new Error()}const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://wrapped-mapper-close.invalid.example")}}}};Array.from(values,()=>fail())',
    'const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://conditional-mapper-close.invalid.example")}}}};Array.from(values,()=>{if(globalThis.flag)throw new Error()})',
    'const hazardous={run(){fetch("https://bound-mapper-this.invalid.example")}},safe={run(){}};Array.from([1],function(){this.run()}.bind(hazardous),safe)',
    'Array.from([()=>fetch("https://mapper-value.invalid.example")],value=>value())',
    'function Collection(){fetch("https://array-from-constructor.invalid.example")}Array.from.call(Collection,[])',
    'const values=new Proxy([],{get(target,key,receiver){if(key===Symbol.iterator)fetch("https://proxy-iterator.invalid.example");return Reflect.get(target,key,receiver)}});Array.from(values)',
    'const mapper=new Proxy(()=>0,{apply(){fetch("https://proxy-mapper.invalid.example");return 1}});Array.from([1],mapper)',
    'const mapper=Proxy.revocable(()=>0,{apply(){fetch("https://revocable-proxy-mapper.invalid.example");return 1}}).proxy;Array.from([1],mapper)',
    'const Result=new Proxy(function(){},{construct(){fetch("https://proxy-constructor.invalid.example");return[]}});Array.from.call(Result,[])',
    'const Result=Proxy.revocable(function(){},{construct(){fetch("https://revocable-proxy-constructor.invalid.example");return[]}}).proxy;Array.from.call(Result,[])',
    'const values={[Symbol.iterator](){fetch("https://bound-array-from.invalid.example");return[][Symbol.iterator]()}};Array.from.bind(null,values)()',
    'const values={[Symbol.iterator](){fetch("https://proxied-array-from.invalid.example");return[][Symbol.iterator]()}},from=new Proxy(Array.from,{});from(values)',
  ])('models Array.from protocol execution (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const values={[Symbol.iterator](){fetch("https://bound-call-array-from.invalid.example");return[][Symbol.iterator]()}};Function.prototype.bind.call(Array.from,null,values)()',
    'const values={[Symbol.iterator](){fetch("https://bound-apply-array-from.invalid.example");return[][Symbol.iterator]()}};Array.from.apply.bind(Array.from,null,[values])()',
    'const values={[Symbol.iterator](){fetch("https://reflect-bound-array-from.invalid.example");return[][Symbol.iterator]()}};Reflect.apply(Function.prototype.bind,Array.from,[null,values])()',
  ])('fails closed for a complex bound Array.from dispatch (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const flag=globalThis.flag;if(flag)Array.from=()=>[];const values={[Symbol.iterator](){fetch("https://conditional-replacement.invalid.example");return [][Symbol.iterator]()}};Array.from(values)',
    'globalThis.flag?Array.from=()=>[]:0;const values={[Symbol.iterator](){fetch("https://conditional-expression-replacement.invalid.example");return [][Symbol.iterator]()}};Array.from(values)',
  ])(
    'retains the intrinsic Array.from path after an uncertain replacement (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    'function fail(){throw new Error()}const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://indirect-mapper-close.invalid.example")}}}};Array.from(values,()=>fail())',
    'const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://conditional-mapper-close.invalid.example")}}}};Array.from(values,()=>{if(globalThis.flag)throw new Error()})',
  ])(
    'closes an Array.from iterator when a mapper may complete abruptly (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    'const unsafe={run(){fetch("https://bound-mapper-this.invalid.example")}},safe={run(){}};const mapper=function(){this.run()}.bind(unsafe);Array.from([1],mapper,safe)',
    'const mapper=(value)=>value();const bound=mapper.bind(null,()=>fetch("https://bound-mapper-value.invalid.example"));Array.from([()=>{}],bound)',
    'Array.from([()=>fetch("https://array-mapper-value.invalid.example")],value=>value())',
    'Array.from({0:()=>fetch("https://array-like-mapper-value.invalid.example"),length:1},value=>value())',
    'const values={length:0};values[0]=()=>fetch("https://assigned-array-like-mapper.invalid.example");values.length=1;Array.from(values,value=>value())',
    'const values={length:0};Object.assign(values,{0:()=>fetch("https://assigned-object-array-like-mapper.invalid.example"),length:1});Array.from(values,value=>value())',
    'const values={length:0};Object.defineProperties(values,{0:{value:()=>fetch("https://defined-array-like-mapper.invalid.example")},length:{value:1}});Array.from(values,value=>value())',
  ])(
    'binds the concrete Array.from mapper receiver and values (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    'function Result(){fetch("https://array-from-constructor.invalid.example")}Array.from.call(Result,[])',
    'function Result(){fetch("https://array-from-reflect-constructor.invalid.example")}Reflect.apply(Array.from,Result,[{length:0}])',
  ])('models a custom Array.from result constructor (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const unsafe={run(){fetch("https://ignored-array-from-this.invalid.example")}},safe={run(){}};const mapper=function(){this.run()}.bind(safe);Array.from([1],mapper,unsafe)',
    'Array.from([],()=>fetch("https://empty-array-mapper.invalid.example"))',
    'Array.from({length:0},()=>fetch("https://empty-array-like-mapper.invalid.example"))',
    'Array.from({length:-1,get 0(){fetch("https://negative-array-like-index.invalid.example")}})',
    'const values=[1];values.length=0;Array.from(values,()=>fetch("https://shrunk-array-mapper.invalid.example"))',
    'const values=new Proxy([],{});Array.from(values)',
    'const values=Proxy.revocable([],{}).proxy;Array.from(values)',
    'const values=new Proxy([],{get(target,key,receiver){return Reflect.get(target,key,receiver)}});Array.from(values)',
    'const values=new Proxy([],{get(target,key,receiver){void key;return Reflect.get(target,key,receiver)}});Array.from(values)',
    'function make(){return new Proxy([],{get(target,key,receiver){void key;return Reflect.get(target,key,receiver)}})}Array.from(make())',
    'function make(){return new Proxy([],{get(target,key,receiver){if(false)fetch("https://unreachable-proxy-iterator.invalid.example");return Reflect.get(target,key,receiver)}})}Array.from(make())',
    'function make(target){return new Proxy(target,{})}Array.from(make([]))',
    'function make(){const target=[];return new Proxy(target,{})}Array.from(make())',
    'function make(options){return new Proxy(options.target,options.handler)}Array.from(make({target:[],handler:{get(target,key,receiver){void key;return Reflect.get(target,key,receiver)}}}))',
    'function make(options){return Proxy.revocable(options.target,options.handler).proxy}Array.from(make({target:[],handler:{}}))',
    'function make(options){return Proxy.revocable(options.target,options.handler).proxy}Array.from(make({target:[],handler:{get(target,key,receiver){void key;return Reflect.get(target,key,receiver)}}}))',
    'function make(options){return Proxy.revocable(options.target,options.handler).proxy}const bad=make({target:{[Symbol.iterator](){fetch("https://dormant-revocable-iterator.invalid.example")}},handler:{}}),safe=make({target:[],handler:{}});Array.from(safe)',
    'function make(options){return new Proxy(options.target,options.handler)}Array.from(make({target:{get [Symbol.iterator](){fetch("https://suppressed-projected-iterator.invalid.example");return Array.prototype[Symbol.iterator]}},handler:{get(){return function(){return [][Symbol.iterator]()}}}}))',
    'function make(target,...handlers){return new Proxy(target,handlers[0])}Array.from(make({get [Symbol.iterator](){fetch("https://suppressed-rest-iterator.invalid.example");return Array.prototype[Symbol.iterator]}},{get(){return function(){return [][Symbol.iterator]()}}}))',
    'function make(run){let value=run;value=()=>0;return new Proxy([],{get(target,key,receiver){value();return Reflect.get(target,key,receiver)}})}Array.from(make(()=>fetch("https://overwritten-proxy-iterator.invalid.example")))',
    'const target={[Symbol.iterator](){fetch("https://suppressed-proxy-iterator.invalid.example")}},values=new Proxy(target,{get(){return function(){return [][Symbol.iterator]()}}});Array.from(values)',
    'const mapper=new Proxy(()=>0,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});Array.from([1],mapper)',
    'const from=new Proxy(Array.from,{apply(target,thisArg,args){return Reflect.apply(target,thisArg,args)}});from([1])',
    'const values={0:()=>fetch("https://overwritten-direct-array-like.invalid.example"),length:1};values[0]=()=>0;Array.from(values,value=>value())',
    'const values={0:()=>fetch("https://overwritten-assign-array-like.invalid.example"),length:1};Object.assign(values,{0:()=>0});Array.from(values,value=>value())',
    'const values={0:()=>fetch("https://overwritten-descriptor-array-like.invalid.example"),length:1};Object.defineProperties(values,{0:{value:()=>0}});Array.from(values,value=>value())',
  ])('does not invent Array.from mapper or index execution (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'const values={[Symbol.iterator](){return {next(){return {done:true,get value(){fetch("https://unread.invalid.example")}}}}}};for(const value of values){}',
    'const values={[Symbol.iterator](){return {next(){return {done:true}},return(){fetch("https://unclosed.invalid.example")}}}};const [value]=values',
    'const values={[Symbol.iterator](){return {next(){return {done:true}},return(){fetch("https://rest-unclosed.invalid.example")}}}};const [...all]=values',
    'const Array={from(){}};const values={[Symbol.iterator](){fetch("https://shadowed.invalid.example");return [][Symbol.iterator]()}};Array.from(values)',
    'Array.from=()=>[];const values={[Symbol.iterator](){fetch("https://replaced.invalid.example");return [][Symbol.iterator]()}};Array.from(values)',
    'Array.from({length:0})',
    'Array.from({0:1,length:1})',
    'const values={length:1,get 0(){fetch("https://array-like-replaced-index.invalid.example");return 1}};Object.defineProperty(values,"0",{value:1});Array.from(values)',
    'const hazardous={run(){fetch("https://ignored-mapper-this.invalid.example")}},safe={run(){}};Array.from([1],function(){this.run()}.bind(safe),hazardous)',
    'Array.from({length:-1,get 0(){fetch("https://negative-length.invalid.example")}})',
    'Array.from([],()=>fetch("https://empty-mapper.invalid.example"))',
    'Array.from({length:0},()=>fetch("https://empty-array-like-mapper.invalid.example"))',
    'const values={run(){},[Symbol.iterator](){this.run();return{next(){return{done:true}}}}};for(const value of values){}',
    'const values={get [Symbol.iterator](){return function(){return{next(){return{done:true}}}}}};for(const value of values){}',
    'const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://unreachable-close.invalid.example")}}}};for(const value of values){if(false)break}',
    'const values={[Symbol.iterator](){return{next(){return{done:false,value:1}},return(){fetch("https://unreachable-after-continue.invalid.example")}}}};for(const value of values){continue;break}',
    'const values={[Symbol.iterator](){return{next(){return{get done(){throw new Error()},get value(){fetch("https://unread-value.invalid.example")}}},return(){fetch("https://iterator-error-close.invalid.example")}}}};for(const value of values){break}',
    'const values={[Symbol.iterator](){return{next(){return{done:false,get value(){throw new Error()}}},return(){fetch("https://value-error-close.invalid.example")}}}};const [value]=values',
  ])('does not invent iterator protocol execution (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('models a Proxy get trap during for-of iterator discovery', () => {
    const source =
      'const values=new Proxy([],{get(target,key,receiver){if(key===Symbol.iterator)fetch("https://proxy-for-of-iterator.invalid.example");return Reflect.get(target,key,receiver)}});for(const value of values){}';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://proxy-for-of-iterator.invalid.example")'
    );
  });

  it('redispatches a transparent Proxy to Reflect.get semantics', () => {
    const source =
      'const value={get member(){fetch("https://proxied-reflect-get.invalid.example");return 1}},get=new Proxy(Reflect.get,{});get(value,"member")';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://proxied-reflect-get.invalid.example")'
    );
  });

  it('rejects a for-of loop after an Array iterator mutation', () => {
    const source =
      'Array.prototype[Symbol.iterator]=function*(){fetch("https://invalid.example")};for(const value of [1]){}';

    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const key={toString(){fetch("https://invalid.example");return "effect"}};const source={[key]:1};',
    'const key={[Symbol.toPrimitive](){fetch("https://invalid.example");return "effect"}};const source={[key]:1};',
    'const key={valueOf(){fetch("https://invalid.example");return "effect"}};const source={};source[key]=1;',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};class Source{[key](){}}',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};Object.defineProperty({},key,{value:1});',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};key in {};',
    'const key={[Symbol.toPrimitive](){fetch("https://invalid.example");return "effect"}};key in {};',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};Object.fromEntries([[key,1]]);',
    'Object.fromEntries({[Symbol.iterator](){fetch("https://invalid.example");return [][Symbol.iterator]()}});',
    'const key=Object.create({toString(){fetch("https://invalid.example");return "effect"}});const source={[key]:1};',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};({}).hasOwnProperty(key);',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};({}).propertyIsEnumerable(key);',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};Object.prototype.hasOwnProperty.call({},key);',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};Object.prototype.hasOwnProperty.apply({},[key]);',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};Object.groupBy([1],()=>key);',
    'const key=getKey();const source={[key]:1};',
  ])('rejects an effectful computed property key (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it('allows a statically primitive computed property key', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const key="effect";const source={[key]:1};source[key];'
      )
    ).toEqual([]);
  });

  it.each([
    '"effect" in {};',
    'Object.fromEntries([["effect",1]]);',
    'Object.fromEntries([[]]);',
    'Object.fromEntries([[,1]]);',
    'class Source{#effect;static has(value){return #effect in value}}Source.has(new Source());',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};({hasOwnProperty(){return true}}).hasOwnProperty(key);',
    'const key={toString(){fetch("https://invalid.example");return "effect"}};Map.groupBy([1],()=>key);',
  ])('allows a safe property-key operation (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('rejects a primitive right operand for the in operator', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting('"effect" in 1;')
    ).not.toEqual([]);
  });

  it('allows computed keys created by the unshadowed Symbol intrinsic', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const local=Symbol("local");const shared=Symbol.for("shared");const source={[local]:1,[shared]:2,[Symbol.iterator]:3};'
      )
    ).toEqual([]);
  });

  it('distinguishes a symbol-keyed class field from a string callable member', () => {
    const source =
      'var kind=Symbol.for("kind");class Value{static [kind]="Value";run(){return 0}}Value.prototype.run=()=>fetch("https://invalid.example");new Value().run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('does not trust a reassigned symbol-key alias on a class', () => {
    const source =
      'var kind=Symbol.for("kind");kind="run";class Value{static [kind]=()=>fetch("https://invalid.example")}Value.run();';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable computed callable definitions'
    );
  });

  it('keeps meta normalization bounded across a self-referential reassigned binding', () => {
    const source =
      'function convertBase(str){return str}function parse(str){if(str===str.toUpperCase())str=str.toLowerCase();str=convertBase(str);return str}parse("value");';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'a direct proxy factory result',
      'const make=()=>new Proxy({},{});const value=make();',
      true,
    ],
    [
      'an aliased proxy factory result',
      'const make=()=>new Proxy({},{});const proxy=make();const value=proxy;',
      true,
    ],
    [
      'a nested proxy factory result',
      'const inner=()=>new Proxy({},{});const make=()=>inner();const value=make();',
      true,
    ],
    [
      'an ordinary factory result',
      'const make=()=>({});const value=make();',
      false,
    ],
  ])(
    'recognizes %s without widening the candidate graph',
    (_label, source, expected) => {
      expect(
        inspectCloudflareDirectLocalProxyFactoryResultForTesting(
          source,
          'value'
        )
      ).toBe(expected);
    }
  );

  it.each([
    'new Set({[Symbol.iterator](){fetch("https://invalid.example");return [][Symbol.iterator]()}});',
    'const Collection=Map;const values={*[Symbol.iterator](){fetch("https://invalid.example")}};new Collection(values);',
    'const values={get [Symbol.iterator](){fetch("https://invalid.example");return function(){return [][Symbol.iterator]()}}};new WeakSet(values);',
    'const values={[Symbol.iterator](){return {next(){fetch("https://invalid.example");return {done:true}}}}};new WeakMap(values);',
    'const values={[Symbol.iterator](){fetch("https://invalid.example");return [][Symbol.iterator]()}};Reflect.construct(Set,[values]);',
    'function build(Collection,values){return new Collection(values)}const values={[Symbol.iterator](){fetch("https://invalid.example");return [][Symbol.iterator]()}};build(Set,values);',
    'const values=[];values[Symbol.iterator]=()=>{fetch("https://invalid.example");return [][Symbol.iterator]()};new Set(values);',
    'String.prototype[Symbol.iterator]=function*(){fetch("https://invalid.example")};new Set("x");',
    'new Map("x");',
    'new WeakMap("x");',
    'new WeakSet("x");',
    'new WeakSet([1]);',
    'new WeakSet([,]);',
    'new WeakMap([[1,{}]]);',
  ])('rejects an effectful collection iterable (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it('allows pristine static collection iterables', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'new Set([1,2]);new Set("safe");new Map([[1,2]]);new WeakSet([]);new WeakSet([{}]);new WeakSet([Symbol("key")]);new WeakMap([]);new WeakMap([[{},1]]);'
      )
    ).toEqual([]);
  });

  it.each([
    '[0].forEach(function(){this.run()},{run:()=>fetch("https://invalid.example")});',
    'const visit=function(){this.run()};const receiver={run:()=>fetch("https://invalid.example")};[0].findLast(visit,receiver);',
  ])('binds an array callback thisArg (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('keeps wide static array callback resolution bounded', () => {
    const values = Array.from(
      { length: 192 },
      () => '{run:()=>undefined}'
    ).join(',');

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `const values=[${values}];values.forEach(value=>value.run());`
      )
    ).toEqual([]);
  });

  it('retains a hazardous member in a wide static array callback', () => {
    const values = [
      ...Array.from({ length: 191 }, () => '{run:()=>undefined}'),
      '{run:()=>fetch("https://invalid.example")}',
    ].join(',');

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `const values=[${values}];values.forEach(value=>value.run());`
      )
    ).toContain('fetch("https://invalid.example")');
  });

  it('tracks a shadowed well-known Symbol member conservatively', () => {
    const source = `
      const Symbol={hasInstance:"run"};
      const target={run:()=>0};
      Object.defineProperty(target,Symbol.hasInstance,{
        value:()=>fetch("https://invalid.example")
      });
      target.run();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('does not let an unresolved parameter mutation poison an unshadowed ambient owner', () => {
    const source = `
      export function mutate(value,key){
        value[key]=()=>fetch("https://invalid.example")
      }
      Object.defineProperty(class {},"name",{value:"Safe"});
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('tracks an explicit parameter mutation of an unshadowed ambient owner', () => {
    const source = `
      function mutate(value,key){
        value[key]=()=>fetch("https://invalid.example")
      }
      mutate(Object,"defineProperty");
      Object.defineProperty(class {},"name",{value:"Unsafe"});
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'direct Object assignment',
      'Object={defineProperty:()=>fetch("https://invalid.example")};Object.defineProperty({},"run",{});',
    ],
    [
      'globalThis.Object assignment',
      'globalThis.Object={defineProperty:()=>fetch("https://invalid.example")};globalThis.Object.defineProperty({},"run",{});',
    ],
    [
      'direct Reflect assignment',
      'Reflect={set:()=>fetch("https://invalid.example")};Reflect.set({},"run",0);',
    ],
    [
      'direct Promise assignment',
      'Promise={all:()=>({then:()=>fetch("https://invalid.example")})};Promise.all([]).then();',
    ],
    [
      'globalThis.Promise assignment',
      'globalThis.Promise={all:()=>({then:()=>fetch("https://invalid.example")})};globalThis.Promise.all([]).then();',
    ],
    [
      'Object.defineProperty Promise replacement',
      'Object.defineProperty(globalThis,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
  ])('fails closed after a %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects a replaced intrinsic global'
    );
  });

  it.each([
    [
      'Object.defineProperty on self',
      'Object.defineProperty(self,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on global',
      'Object.defineProperty(global,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on an aliased global',
      'const root=self;Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on a conditional global alias',
      'const root=flag?self:globalThis;Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on a logical global alias',
      'const root=self||globalThis;Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on an array-projected global alias',
      'const root=[self][0];Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on an object-projected global alias',
      'const root={value:self}.value;Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on a destructured global alias',
      'const {value:root}={value:self};Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on an array-destructured global alias',
      'const [root]=[self];Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on a nested-destructured global alias',
      'const {outer:{root}}={outer:{root:self}};Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'Object.defineProperty on a returned global alias',
      'function getRoot(){return self}const root=getRoot();Object.defineProperty(root,"Promise",{value:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'an invoked helper replacement',
      'function replace(){globalThis.Promise={all:()=>({then:()=>fetch("https://invalid.example")})}}replace();Promise.all([]).then();',
    ],
    [
      'Object.defineProperties on the global object',
      'Object.defineProperties(globalThis,{Promise:{value:{all:()=>({then:()=>fetch("https://invalid.example")})}}});Promise.all([]).then();',
    ],
    [
      'a legacy global getter replacement',
      'globalThis.__defineGetter__("Promise",()=>({all:()=>({then:()=>fetch("https://invalid.example")})}));Promise.all([]).then();',
    ],
    [
      'an object assignment-pattern global replacement',
      '({Promise:globalThis.Promise}={Promise:{all:()=>({then:()=>fetch("https://invalid.example")})}});Promise.all([]).then();',
    ],
    [
      'an array assignment-pattern global replacement',
      '[globalThis.Promise]=[{all:()=>({then:()=>fetch("https://invalid.example")})}];Promise.all([]).then();',
    ],
    [
      'a for-of global replacement',
      'for(globalThis.Promise of [{all:()=>({then:()=>fetch("https://invalid.example")})}]){}Promise.all([]).then();',
    ],
  ])('fails closed after %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects a replaced intrinsic global'
    );
  });

  it('does not let an unresolved parameter mutation poison an isolated Promise aggregate', () => {
    const source = `
      export function mutate(value,key){
        value[key]=()=>fetch("https://invalid.example")
      }
      Promise.all([]).then(()=>0);
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('tracks an explicit parameter mutation of an isolated Promise aggregate', () => {
    const source = `
      const promise=Promise.all([]);
      function mutate(value){
        value.then=()=>fetch("https://invalid.example")
      }
      mutate(promise);
      promise.then();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'factory return',
      'const shared={run:()=>0};shared.run=()=>fetch("https://invalid.example");function get(){return shared}get().run();',
    ],
    [
      'constructor object return',
      'const shared={run:()=>0};shared.run=()=>fetch("https://invalid.example");function Owner(){return shared}new Owner().run();',
    ],
    [
      'patched Promise aggregate',
      'const shared={then:()=>0};shared.then=()=>fetch("https://invalid.example");Promise.all=()=>shared;Promise.all([]).then();',
    ],
    [
      'object-literal prototype',
      'const proto={run:()=>0};proto.run=()=>fetch("https://invalid.example");({__proto__:proto}).run();',
    ],
    [
      'Function prototype',
      'Function.prototype.run=()=>fetch("https://invalid.example");(()=>0).run();',
    ],
    [
      'Object.create prototype',
      'const proto={run:()=>0};proto.run=()=>fetch("https://invalid.example");Object.create(proto).run();',
    ],
  ])('tracks a mutation through a resolved %s receiver', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('suppresses unresolved export aliases only for the exact reviewed Zod closure', () => {
    const record = {
      modules: [
        {
          id: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/util.js',
          owner: 'non-app',
        },
      ],
      ownership: 'non-app',
      sha256:
        'b58b76143de945661f801945b38db191e2fbe55ecd29e98f6d30fd9d54cec758',
    };

    const policy = inspectCloudflareReviewedClosurePolicyForTesting(record);
    expect(policy.opaqueMemberMutationExemptions).toHaveLength(30);
    expect(policy.safeCallExemptions).toEqual([]);
    expect(
      policy.opaqueMemberMutationExemptions.map(({ reason }) => typeof reason)
    ).toEqual(Array.from({ length: 30 }, () => 'string'));
    const mutationSources = policy.opaqueMemberMutationExemptions.flatMap(
      ({ expectedMutationContainerSource, expectedMutationSource }) =>
        [expectedMutationContainerSource, expectedMutationSource].filter(
          (value) => value !== undefined
        )
    );
    expect(mutationSources).toHaveLength(30);
    expect(mutationSources.map((source) => typeof source)).toEqual(
      Array.from({ length: 30 }, () => 'string')
    );
    expect(
      inspectCloudflareReviewedClosurePolicyForTesting({
        ...record,
        sha256: '0'.repeat(64),
      })
    ).toEqual({
      exportedAggregateReadOnlySinks: [],
      exportedStaticMemberDeferredResults: [],
      opaqueMemberMutationExemptions: [],
      safeCallExemptions: [],
    });
    expect(
      inspectCloudflareReviewedClosurePolicyForTesting({
        ...record,
        modules: [{ id: 'src/adversarial.ts', owner: 'non-app' }],
      })
    ).toEqual({
      exportedAggregateReadOnlySinks: [],
      exportedStaticMemberDeferredResults: [],
      opaqueMemberMutationExemptions: [],
      safeCallExemptions: [],
    });

    const prefix = 'function mutate(inst,k,proto){';
    const reviewedSource = `${prefix.padEnd(571, ' ')}inst[k] = proto[k].bind(inst)}const target={_zod:()=>0};mutate(target,getKey(),{_zod(){},other(){}});target._zod();`;
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(reviewedSource)
    ).toThrow('rejects opaque aggregate member mutations');
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(reviewedSource, record)
    ).toThrow('test source hash must match');
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(reviewedSource, {
        ...record,
        sha256: '0'.repeat(64),
      })
    ).toThrow('test source hash must match');
  });

  it.each([
    [
      'the emitted schemas chunk',
      'b2e3828594675b9262c546998aa09ba14d1c0a98d9cb1c38f7eb6ebd04c8ea06',
      5370,
      5391,
    ],
    [
      'the alternate reviewed Zod chunk',
      'b58b76143de945661f801945b38db191e2fbe55ecd29e98f6d30fd9d54cec758',
      5262,
      5283,
    ],
  ])(
    'pins constructed-local clone suppression to %s',
    (_label, sha256, mutationStart, mutationEnd) => {
      const policy = inspectCloudflareReviewedClosurePolicyForTesting({
        modules: [
          {
            id: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/util.js',
            owner: 'non-app',
          },
        ],
        ownership: 'non-app',
        sha256,
      });
      expect(
        policy.opaqueMemberMutationExemptions.filter(
          ({ suppressOpaqueConstructedLocalMutation }) =>
            suppressOpaqueConstructedLocalMutation === true
        )
      ).toEqual([
        expect.objectContaining({
          expectedMutationSource: 'cl._zod.parent = inst',
          mutationEnd,
          mutationStart,
          mutationType: 'AssignmentExpression',
        }),
      ]);
    }
  );

  it('does not share a reviewed closure between Programs with the same analysis label', () => {
    expect(
      inspectCloudflareReviewedClosureProgramIsolationForTesting()
    ).toEqual({ reviewed: true, unrelated: true });
  });

  it('pins the Base UI aggregate sink to the exact mixed closure', () => {
    const record = {
      modules: [
        { id: 'src/platform/components/button.tsx', owner: 'app' },
        {
          id: 'node_modules/.pnpm/@base-ui+react@1.6.0/node_modules/@base-ui/react/internals/useRenderElement.mjs',
          owner: 'non-app',
        },
      ],
      ownership: 'mixed',
      sha256:
        'd52c1344eb1aea2210a9b605a5102d257cb18139dadbd23e85b46c20a3522d6a',
    };

    expect(
      inspectCloudflareReviewedClosurePolicyForTesting(record)
        .exportedAggregateReadOnlySinks
    ).toEqual([
      expect.objectContaining({
        exportedLocalName: 'useRenderElement',
        exportedName: 'c',
        exportedParameterIndex: 2,
        propertyName: 'stateAttributesMapping',
        reason: expect.any(String),
      }),
    ]);
    expect(
      inspectCloudflareReviewedClosurePolicyForTesting({
        ...record,
        sha256: '0'.repeat(64),
      }).exportedAggregateReadOnlySinks
    ).toEqual([]);
  });

  it('requires exact mixed ownership before structural authentication', () => {
    const record = {
      modules: [
        {
          id: 'src/platform/lib/zod/zod-utils.ts',
          owner: 'app',
        },
        {
          id: 'node_modules/.pnpm/@base-ui+react@1.6.0/node_modules/@base-ui/react/floating-ui-react/hooks/useListNavigation.mjs',
          owner: 'non-app',
        },
        {
          id: 'node_modules/.pnpm/@base-ui+react@1.6.0/node_modules/@base-ui/react/utils/popups/popupStoreUtils.mjs',
          owner: 'non-app',
        },
      ],
      ownership: 'mixed',
      sha256: '0'.repeat(64),
    };
    const policies =
      inspectCloudflareReviewedMixedClosureOwnershipForTesting(
        record
      ).exportedStaticMemberDeferredResults;

    expect(policies).toEqual([
      expect.objectContaining({
        exportedLocalName: 'zu',
        exportedName: 'M',
        memberPath: ['fieldText', 'nullish'],
        returnedPath: [],
      }),
      expect.objectContaining({
        exportedLocalName: 'zu',
        exportedName: 'M',
        memberPath: ['fieldText', 'required'],
        returnedPath: [],
      }),
      expect.objectContaining({
        exportedLocalName: 'zu',
        exportedName: 'M',
        memberPath: ['fieldText', 'required'],
        returnedPath: ['pipe', { callResult: true }],
      }),
    ]);
    const [appModule, listNavigationModule, popupStoreModule] = record.modules;
    for (const rejected of [
      {
        ...record,
        modules: [
          { ...appModule, owner: 'non-app' },
          listNavigationModule,
          popupStoreModule,
        ],
      },
      {
        ...record,
        modules: [
          appModule,
          { ...listNavigationModule, owner: 'app' },
          popupStoreModule,
        ],
      },
    ]) {
      expect(
        inspectCloudflareReviewedMixedClosureOwnershipForTesting(rejected)
          .exportedStaticMemberDeferredResults
      ).toEqual([]);
    }
  });

  it('normalizes only exact runtime-config imports in structural program digests', () => {
    const normalizedStaticImports = [
      {
        bindings: [
          ['n', 'getEnvClient'],
          ['t', 'envClient'],
        ],
        normalizedSource: './client-[runtime-config].js',
        sourceStem: 'client',
      },
      {
        bindings: [['t', 'createSsrRpc']],
        normalizedSource: './createSsrRpc-[runtime-config].js',
        sourceStem: 'createSsrRpc',
      },
    ];
    const source = (clientHash, rpcHash, body = 'const value=1;') =>
      `import{n as getEnvClient,t as envClient}from"./client-${clientHash}.js";import{t as createSsrRpc}from"./createSsrRpc-${rpcHash}.js";${body}`;
    const first = inspectCloudflareReviewedStructuralProgramDigestForTesting(
      source('AAAAAAAA', 'BBBBBBBB'),
      normalizedStaticImports
    );

    expect(
      inspectCloudflareReviewedStructuralProgramDigestForTesting(
        source('CCCCCCCC', 'DDDDDDDD'),
        normalizedStaticImports
      )
    ).toBe(first);
    expect(
      inspectCloudflareReviewedStructuralProgramDigestForTesting(
        source('CCCCCCCC', 'DDDDDDDD', 'const value=2;'),
        normalizedStaticImports
      )
    ).not.toBe(first);
    expect(() =>
      inspectCloudflareReviewedStructuralProgramDigestForTesting(
        source('short', 'DDDDDDDD'),
        normalizedStaticImports
      )
    ).toThrow('must resolve exactly once');
  });

  it('authenticates one reviewed module region across unrelated chunk changes', () => {
    const regionBody =
      'var inputString=options=>string({error:options?.error});\nvar validatedString=options=>inputString(options);\nvar zu={fieldText:{required:options=>validatedString(options)}};\n';
    const ownerSource =
      'const string=options=>({options});export{string as w};';
    const policy = {
      astSha256:
        inspectCloudflareReviewedStructuralProgramDigestForTesting(regionBody),
      exportedLocalName: 'zu',
      exportedName: 'M',
      importedBinding: {
        importedName: 'w',
        localName: 'string',
        ownerExportedName: 'w',
        ownerSha256: [createHash('sha256').update(ownerSource).digest('hex')],
        sourceStem: 'schemas',
      },
      moduleSuffix: 'src/platform/lib/zod/zod-utils.ts',
    };
    const source = (unrelated) =>
      `import{w as string}from"./schemas-AAAAAAAA.js";\n${unrelated}\n//#region src/platform/lib/zod/zod-utils.ts\n${regionBody}//#endregion\nexport{zu as M};`;

    expect(
      inspectCloudflareReviewedModuleRegionForTesting(
        source('const unrelated=1;'),
        ownerSource,
        policy
      )
    ).toBe(true);
    expect(
      inspectCloudflareReviewedModuleRegionForTesting(
        source('const unrelated={nested:[1,2,3]};'),
        ownerSource,
        policy
      )
    ).toBe(true);
  });

  it.each([
    [
      'a changed transitive helper',
      (source) =>
        source.replace(
          'var validatedString=options=>inputString(options);',
          'var validatedString=options=>string(options);'
        ),
      (ownerSource) => ownerSource,
      (policy) => policy,
    ],
    [
      'a changed reviewed helper',
      (source) =>
        source.replace(
          'required:options=>validatedString(options)',
          'required:options=>fetch(options)'
        ),
      (ownerSource) => ownerSource,
      (policy) => policy,
    ],
    [
      'a changed Zod import binding',
      (source) => source.replace('w as string', 'x as string'),
      (ownerSource) => ownerSource,
      (policy) => policy,
    ],
    [
      'a changed application export',
      (source) => source.replace('zu as M', 'zu as N'),
      (ownerSource) => ownerSource,
      (policy) => policy,
    ],
    [
      'a changed imported owner',
      (source) => source,
      (ownerSource) => `${ownerSource}const changed=true;`,
      (policy) => policy,
    ],
    [
      'a changed imported owner export',
      (source) => source,
      (ownerSource) => ownerSource.replace('string as w', 'string as x'),
      (policy, ownerSource) => ({
        ...policy,
        importedBinding: {
          ...policy.importedBinding,
          ownerSha256: [createHash('sha256').update(ownerSource).digest('hex')],
        },
      }),
    ],
  ])(
    'rejects module-region authentication with %s',
    (_label, mutateSource, mutateOwner, mutatePolicy) => {
      const regionBody =
        'var inputString=options=>string({error:options?.error});\nvar validatedString=options=>inputString(options);\nvar zu={fieldText:{required:options=>validatedString(options)}};\n';
      const baseOwnerSource =
        'const string=options=>({options});export{string as w};';
      const basePolicy = {
        astSha256:
          inspectCloudflareReviewedStructuralProgramDigestForTesting(
            regionBody
          ),
        exportedLocalName: 'zu',
        exportedName: 'M',
        importedBinding: {
          importedName: 'w',
          localName: 'string',
          ownerExportedName: 'w',
          ownerSha256: [
            createHash('sha256').update(baseOwnerSource).digest('hex'),
          ],
          sourceStem: 'schemas',
        },
        moduleSuffix: 'src/platform/lib/zod/zod-utils.ts',
      };
      const source = `import{w as string}from"./schemas-AAAAAAAA.js";\n//#region src/platform/lib/zod/zod-utils.ts\n${regionBody}//#endregion\nexport{zu as M};`;
      const ownerSource = mutateOwner(baseOwnerSource);
      const policy = mutatePolicy(basePolicy, ownerSource);

      expect(
        inspectCloudflareReviewedModuleRegionForTesting(
          mutateSource(source),
          ownerSource,
          policy
        )
      ).toBe(false);
    }
  );

  it.each([
    [
      'a nullish helper call',
      'zu.fieldText.nullish({max:200})',
      reviewedStaticMemberNullishPolicy,
    ],
    [
      'a required schema piped to an inert schema',
      'zu.fieldText.required({error:"required"}).pipe(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'a direct required helper call',
      'zu.fieldText.required({error:"required"})',
      reviewedStaticMemberRequiredPolicy,
    ],
  ])(
    'accepts %s through its exact static member policy',
    (_label, call, policy) => {
      const root = createReviewedStaticMemberArtifact({
        consumerSource: `import{M as zu}from"./static-member-owner-AAAAAAAA.js";const schema=${call};`,
      });

      expect(inspectReviewedStaticMemberArtifact(root, call, policy)).toBe(
        false
      );
    }
  );

  it.each([
    [
      'an unreviewed member',
      'zu.fieldText.evil()',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'an extra returned method',
      'zu.fieldText.required({}).pipe(()=>0).optional()',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'a missing reviewed pipe suffix',
      'zu.fieldText.required({})',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'an eager effect in the reviewed root call',
      'zu.fieldText.required(fetch("https://invalid.example"))',
      {
        ...reviewedStaticMemberPipePolicy,
        returnedPath: [],
      },
    ],
    [
      'an eager effect in the reviewed pipe call',
      'zu.fieldText.required({}).pipe(fetch("https://invalid.example"))',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'an effect hidden in a nested unreviewed helper',
      'zu.fieldText.required({value:zu.fieldText.evil()}).pipe(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'an accessor argument',
      'zu.fieldText.required({get value(){return 1}}).pipe(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'a proxy argument',
      'zu.fieldText.required(new Proxy({},{})).pipe(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'an optional reviewed call',
      'zu.fieldText.required?.({}).pipe(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'a spread reviewed call',
      'zu.fieldText.required(...[]).pipe(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'an optional reviewed pipe call',
      'zu.fieldText.required({}).pipe?.(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'a spread reviewed pipe call',
      'zu.fieldText.required({}).pipe(...[])',
      reviewedStaticMemberPipePolicy,
    ],
    [
      'a sequence effect before the reviewed receiver',
      '(fetch("https://invalid.example"),zu.fieldText.required({})).pipe(()=>0)',
      reviewedStaticMemberPipePolicy,
    ],
  ])(
    'rejects static member policy laundering through %s',
    (_label, call, policy) => {
      const root = createReviewedStaticMemberArtifact({
        consumerSource: `import{M as zu}from"./static-member-owner-AAAAAAAA.js";const schema=${call};`,
      });

      expect(inspectReviewedStaticMemberArtifact(root, call, policy)).toBe(
        true
      );
    }
  );

  it.each([
    [
      'a signed consumer receiver mutation',
      [
        'import{M as zu}from"./static-member-owner-AAAAAAAA.js";zu.fieldText.__defineGetter__("required",()=>()=>({}));',
      ],
      undefined,
    ],
    [
      'a signed consumer shallow-copy escape',
      [
        'import{M as zu}from"./static-member-owner-AAAAAAAA.js";const copy={...zu};copy.fieldText.required=()=>({});',
      ],
      undefined,
    ],
    [
      'a signed consumer Object.assign mutation',
      [
        'import{M as zu}from"./static-member-owner-AAAAAAAA.js";Object.assign(zu.fieldText,{required:()=>({})});',
      ],
      undefined,
    ],
    [
      'a signed consumer defineProperty mutation',
      [
        'import{M as zu}from"./static-member-owner-AAAAAAAA.js";Object.defineProperty(zu.fieldText,"required",{value:()=>({})});',
      ],
      undefined,
    ],
    [
      'an owner receiver mutation',
      [],
      'const zu={fieldText:{nullish:options=>({options}),required:options=>({options})}};zu.fieldText.required=()=>({});export{zu as M};',
    ],
    [
      'an owner intermediate replacement',
      [],
      'const zu={fieldText:{nullish:options=>({options}),required:options=>({options})}};zu.fieldText={required:()=>({})};export{zu as M};',
    ],
    [
      'an owner shallow-copy escape',
      [],
      'const zu={fieldText:{nullish:options=>({options}),required:options=>({options})}};const copy={...zu};copy.fieldText.required=()=>({});export{zu as M};',
    ],
  ])(
    'rejects a reviewed static member with %s',
    (_label, extraConsumerSources, ownerSource) => {
      const call = 'zu.fieldText.required({}).pipe(()=>0)';
      const root = createReviewedStaticMemberArtifact({
        consumerSource: `import{M as zu}from"./static-member-owner-AAAAAAAA.js";const schema=${call};`,
        extraConsumerSources,
        ownerSource,
      });

      expect(inspectReviewedStaticMemberArtifact(root, call)).toBe(true);
    }
  );

  it.each([
    [
      'an owner accessor',
      'const zu={fieldText:{get required(){return options=>({options})}}};export{zu as M};',
    ],
    [
      'an owner spread',
      'const required=options=>({options});const zu={fieldText:{...{required}}};export{zu as M};',
    ],
  ])('rejects a static member policy with %s', (_label, ownerSource) => {
    const call = 'zu.fieldText.required({}).pipe(()=>0)';
    const root = createReviewedStaticMemberArtifact({
      consumerSource: `import{M as zu}from"./static-member-owner-AAAAAAAA.js";const schema=${call};`,
      ownerSource,
    });

    expect(() => inspectReviewedStaticMemberArtifact(root, call)).toThrow(
      'must resolve every static member'
    );
  });

  it.each([
    [
      'an inert expression body',
      'const make=()=>({ok:true});const value=make()',
      false,
    ],
    [
      'an effectful expression body',
      'const make=()=>fetch("https://invalid.example");const value=make()',
      true,
    ],
    [
      'a block body',
      'const make=()=>{return {ok:true}};const value=make()',
      true,
    ],
    [
      'an async expression body',
      'const make=async()=>({ok:true});const value=make()',
      true,
    ],
    [
      'a reassigned factory',
      'let make=()=>({ok:true});make=()=>({ok:false});const value=make()',
      true,
    ],
    [
      'an accessor result',
      'const make=()=>({get value(){return 1}});const value=make()',
      true,
    ],
    [
      'a sequence prefix effect',
      'const make=()=>(fetch("https://invalid.example"),{});const value=make()',
      true,
    ],
    [
      'an assignment expression',
      'const target={};const make=()=>(target.value=1);const value=make()',
      true,
    ],
    [
      'an update expression',
      'let count=0;const make=()=>count++;const value=make()',
      true,
    ],
    [
      'a conditional test effect',
      'const make=()=>(fetch("https://invalid.example")?{}:{});const value=make()',
      true,
    ],
  ])(
    'classifies a local expression factory with %s',
    (_label, source, hazard) => {
      expect(
        inspectCloudflareDeferredArgumentHazardForTesting(source, 'value')
      ).toBe(hazard);
    }
  );

  it('preserves a reviewed member path through descriptor projections', () => {
    const source =
      'const getKey=()=>"_zod";function mutate(inst,k,proto){inst[k]=proto[k].bind(inst)}const target={_zod:()=>0};mutate(target,getKey(),{_zod(){},other(){}});target._zod();';
    const mutationStart = source.indexOf('inst[k]=');
    const mutationEnd = source.indexOf('}', mutationStart);
    const mutationSource = source.slice(mutationStart, mutationEnd);
    const reviewedClosure = {
      opaqueMemberMutationExemptions: [
        {
          expectedMutationSource: mutationSource,
          memberPathPart: '_zod',
          mutationEnd,
          mutationStart,
          mutationType: 'AssignmentExpression',
          reason:
            'The exact prototype copy cannot replace the reviewed metadata path.',
          suppressOpaqueMutation: true,
        },
      ],
      safeCallExemptions: [],
    };

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
    expect(
      inspectCloudflareReviewedLoadEffectsForTesting(source, reviewedClosure)
    ).toEqual([]);
  });

  it('preserves a concrete alias created by a reviewed constructed-local mutation', () => {
    const source =
      'function C(){}function clone(inst){const cl=new C();cl._zod={};cl._zod.parent=inst;return cl}const shared={run:()=>undefined},copy=clone(shared);shared.run=()=>fetch("https://constructed-reverse.invalid.example");copy._zod.parent.run();';
    const expectedMutationSource = 'cl._zod.parent=inst';
    const mutationStart = source.indexOf(expectedMutationSource);
    const mutationEnd = mutationStart + expectedMutationSource.length;
    const reviewedClosure = {
      opaqueMemberMutationExemptions: [
        {
          expectedMutationSource,
          mutationEnd,
          mutationStart,
          mutationType: 'AssignmentExpression',
          reason:
            'The exact local clone link suppresses only unrelated opaque propagation.',
          suppressOpaqueConstructedLocalMutation: true,
        },
      ],
    };

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContainEqual(
      expect.stringContaining('fetch(')
    );
    expect(
      inspectCloudflareReviewedLoadEffectsForTesting(source, reviewedClosure)
    ).toContainEqual(expect.stringContaining('fetch('));
  });

  it.each([
    [
      'array',
      'const callbacks=[()=>fetch("https://reviewed-array-spread.invalid.example")];const copied=[...callbacks];copied[0]();',
      'ArrayExpression',
    ],
    [
      'object',
      'const callbacks={run:()=>fetch("https://reviewed-object-spread.invalid.example")};const copied={...callbacks};copied.run();',
      'ObjectExpression',
    ],
  ])(
    'does not erase executable values covered by an exact %s aggregate spread exemption',
    (_label, source, expectedType) => {
      const expectedArgumentSource = 'callbacks';
      const argumentStart = source.indexOf(
        expectedArgumentSource,
        source.indexOf('...')
      );
      const argumentEnd = argumentStart + expectedArgumentSource.length;
      const reviewedClosure = {
        aggregateSpreadExemptions: [
          {
            argumentEnd,
            argumentStart,
            argumentType: 'Identifier',
            expectedArgumentSource,
            expectedType,
            reason:
              'The exact fixture exemption may waive opacity but not executable contents.',
          },
        ],
      };

      expect(
        inspectCloudflareReviewedLoadEffectsForTesting(source, reviewedClosure)
      ).toContainEqual(expect.stringContaining('fetch('));
    }
  );

  it('keeps an unresolved exact aggregate spread exemption fail-closed', () => {
    const source =
      'const callbacks=getCallbacks();const copied=[...callbacks];copied[0]();';
    const expectedArgumentSource = 'callbacks';
    const argumentStart = source.indexOf(
      expectedArgumentSource,
      source.indexOf('...')
    );
    const argumentEnd = argumentStart + expectedArgumentSource.length;

    expect(() =>
      inspectCloudflareReviewedLoadEffectsForTesting(source, {
        aggregateSpreadExemptions: [
          {
            argumentEnd,
            argumentStart,
            argumentType: 'Identifier',
            expectedArgumentSource,
            expectedType: 'ArrayExpression',
            reason:
              'The exact fixture exemption cannot manufacture analyzable contents.',
          },
        ],
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    [
      'a callable member',
      'function copy(ctx){const copied={...ctx};copied.run()}copy(getCallbacks());',
    ],
    [
      'a later symbolic override',
      'function copy(ctx){const copied={run:()=>undefined,...ctx};copied.run()}copy(getCallbacks());',
    ],
  ])(
    'fails closed when symbolic object spread parameters reach %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires statically analyzable aggregate spreads'
      );
    }
  );

  it('respects a later concrete override of a symbolic object spread parameter', () => {
    const source =
      'function copy(ctx){const copied={...ctx,run:()=>undefined};copied.run()}copy(getCallbacks());';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('fails closed for an opaque object call spread', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting('const copied={...getData()};')
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed for accessors hidden behind an opaque object call spread', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'function getData(){return new Proxy({x:1},{get(target,key){fetch("https://opaque-spread-getter.invalid.example");return target[key]}})}const copied={...getData()};'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed when an opaque object call spread reaches a callable member', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const copied={...getData()};copied.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed before a concrete override after an opaque object call spread', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const copied={...getData(),run:()=>undefined};copied.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    [
      'an opaque call',
      'const source=flag?{x:1}:getData();const copied={...source};',
    ],
    [
      'an observable Proxy',
      'const proxy=new Proxy({x:1},{ownKeys(target){fetch("https://mixed-proxy-spread.invalid.example");return Reflect.ownKeys(target)}});const source=flag?{x:1}:proxy;const copied={...source};',
    ],
    [
      'an opaque factory branch',
      'function get(value){if(value)return{x:1};return getData()}const copied={...get(flag)};',
    ],
  ])(
    'fails closed when a supported object spread branch is mixed with %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires statically analyzable aggregate spreads'
      );
    }
  );

  it('accepts fully expanded safe conditional object spread branches', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const source=flag?{x:1}:{y:2};const copied={...source};void copied;'
      )
    ).toEqual([]);
  });

  it('fails closed for recursive data-only object spreads', () => {
    const source =
      'class Registry{get(value){if(value)return{...this.get(0)};return{}}}new Registry().get(1);';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable aggregate spreads'
    );
  });

  it('fails closed when a recursive opaque object result is projected directly', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const registry=new Map();function get(value){if(value)return{...get(0)};return registry.get("x")}const result=get(1);result.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    [
      'a Proxy base',
      'const base=new Proxy({x:1},{ownKeys(target){fetch("https://recursive-proxy-spread.invalid.example");return Reflect.ownKeys(target)}});function get(value){if(value)return{...get(0)};return base}get(1);',
    ],
    [
      'an opaque call base',
      'function get(value){if(value)return{...get(0)};return getData()}get(1);',
    ],
  ])('fails closed for a recursive object spread with %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable aggregate spreads'
    );
  });

  it.each([
    [
      'an opaque nested base',
      'function get(value){if(value)return{nested:{...get(0)}};return getData()}get(1);',
    ],
    [
      'an observable nested Proxy base',
      'const base=new Proxy({run:()=>undefined},{getOwnPropertyDescriptor(target,key){fetch("https://nested-proxy-spread.invalid.example");return Reflect.getOwnPropertyDescriptor(target,key)}});function get(value){if(value)return{nested:{...get(0)}};return base}get(1).nested.run();',
    ],
  ])('fails closed for recursive nesting with %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable aggregate spreads'
    );
  });

  it('validates reviewed exemption sources, ranges, and uniqueness', () => {
    const source = 'const target={};target.run=()=>0;target.run();';
    const mutationStart = source.indexOf('target.run=');
    const mutationEnd = source.indexOf(';', mutationStart);
    const readStart = source.lastIndexOf('target.run');
    const readEnd = readStart + 'target.run'.length;
    const exemption = {
      expectedMutationSource: source.slice(mutationStart, mutationEnd),
      expectedReadSource: source.slice(readStart, readEnd),
      mutationEnd,
      mutationStart,
      mutationType: 'AssignmentExpression',
      readEnd,
      readStart,
      readType: 'MemberExpression',
      reason: 'The exact fixture mutation and read are intentionally paired.',
      suppressOpaqueMutation: true,
    };
    expect(
      inspectCloudflareReviewedPolicyValidationForTesting(source, {
        opaqueMemberMutationExemptions: [exemption],
      })
    ).toBe(true);
    expect(() =>
      inspectCloudflareReviewedPolicyValidationForTesting(source, {
        opaqueMemberMutationExemptions: [
          { ...exemption, expectedMutationSource: 'target.safe=()=>0' },
        ],
      })
    ).toThrow('source must match its reviewed bytes');
    expect(() =>
      inspectCloudflareReviewedPolicyValidationForTesting(source, {
        opaqueMemberMutationExemptions: [exemption, exemption],
      })
    ).toThrow('must not duplicate another exemption');
    expect(() =>
      inspectCloudflareReviewedPolicyValidationForTesting(source, {
        opaqueMemberMutationExemptions: [
          exemption,
          { ...exemption, reason: 'Different prose for the same behavior.' },
        ],
      })
    ).toThrow('must not duplicate another exemption');
    expect(() =>
      inspectCloudflareReviewedPolicyValidationForTesting(source, {
        opaqueMemberMutationExemptions: [
          { ...exemption, undocumentedSelector: true },
        ],
      })
    ).toThrow('must not define unknown policy fields');
  });

  it('relocates an authenticated mutation exemption only by unique source', () => {
    const reviewedSource = 'const target={};target.run=()=>0;';
    const mutationStart = reviewedSource.indexOf('target.run=');
    const mutationEnd = reviewedSource.indexOf(';', mutationStart);
    const reviewedClosure = {
      opaqueMemberMutationExemptions: [
        {
          expectedMutationSource: reviewedSource.slice(
            mutationStart,
            mutationEnd
          ),
          mutationEnd,
          mutationStart,
          mutationType: 'AssignmentExpression',
          reason:
            'The authenticated mutation may relocate once in a bundled closure.',
          suppressOpaqueMutation: true,
        },
      ],
    };

    expect(
      inspectCloudflareReviewedMutationRelocationForTesting(
        reviewedSource,
        `const prefix=0;${reviewedSource}`,
        reviewedClosure
      )
    ).toEqual([true]);
    expect(
      inspectCloudflareReviewedMutationRelocationForTesting(
        reviewedSource,
        `const prefix=0;${reviewedSource}${reviewedSource}`,
        reviewedClosure
      )
    ).toEqual([false, false]);
  });

  it('resolves a projected parameter receiver in each call-site scope', () => {
    const source = `
      function handle(result, final, key, present) {
        if (result.value === undefined) {
          if (present) final.value[key] = undefined;
        } else final.value[key] = result.value;
      }
      function parse(payload, key, result) {
        handle(result, payload, key, true);
        return payload;
      }
      parse({ value: {} }, 'field', { value: undefined });
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('terminates a projected parameter mutation whose value reads a peer parameter', () => {
    const source = `
      function handle(result, final, key, present) {
        if (result.value === undefined) {
          if (present) final.value[key] = undefined;
        } else final.value[key] = result.value;
      }
      function parse(payload, key, result, pending) {
        if (pending) {
          Promise.resolve(result).then((resolved) =>
            handle(resolved, payload, key, true)
          );
        } else {
          handle(result, payload, key, true);
        }
        return payload;
      }
      parse({ value: {} }, 'field', { value: undefined }, false);
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'propagates the projected receiver to the called argument',
      'class First{};function mutate(type){Object.defineProperty(type.prototype,"run",{value:()=>fetch("https://invalid.example")})}mutate(First);new First().run();',
      ['fetch("https://invalid.example")'],
    ],
    [
      'does not contaminate another projected receiver',
      'class First{};class Second{run(){}};function mutate(type){Object.defineProperty(type.prototype,"run",{value:()=>fetch("https://invalid.example")})}mutate(First);new Second().run();',
      [],
    ],
  ])('%s for a directly called parameter', (_label, source, effects) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(effects);
  });

  it.each([
    [
      'Object.assign call-result alias',
      'const target={run:()=>0};const alias=Object.assign(target,{});alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'conditional alias',
      'const target={run:()=>0};const other={run:()=>0};const alias=flag?target:other;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'logical alias',
      'const target={run:()=>0};const other={run:()=>0};const alias=flag&&target||other;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('tracks a prior mutation through a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('conservatively retains receiver aliases across rebinding', () => {
    const source =
      'const target={run:()=>0};let alias=target;alias={run:()=>0};alias.run=()=>fetch("https://invalid.example");target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'direct invoked closure',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}mutate();target.run();',
    ],
    [
      'Object.assign in an invoked closure',
      'const target={run:()=>0};function mutate(){Object.assign(target,{run:()=>fetch("https://invalid.example")})}mutate();target.run();',
    ],
    [
      'transitively invoked closure',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}function wrapper(){mutate()}wrapper();target.run();',
    ],
  ])('tracks a mutation from a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'hoisted function declared after its call',
      'const target={run:()=>0};mutate();target.run();function mutate(){target.run=()=>fetch("https://invalid.example")}',
    ],
    [
      'aliased function',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const alias=mutate;alias();target.run();',
    ],
    [
      'object-held function',
      'const target={run:()=>0};const funcs={mutate(){target.run=()=>fetch("https://invalid.example")}};funcs.mutate();target.run();',
    ],
    [
      'bound function',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const alias=mutate.bind(null);alias();target.run();',
    ],
    [
      'sibling function',
      'const target={run:()=>0};mutate();read();function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
    [
      'transitive sibling function',
      'const target={run:()=>0};wrapper();function wrapper(){mutate();read()}function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
    [
      'program write before a nested read',
      'const target={run:()=>0};target.run=()=>fetch("https://invalid.example");read();function read(){target.run()}',
    ],
  ])('tracks a mutation from a prior %s call', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'aliased function invoked after the read',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const alias=mutate;target.run();alias();',
    ],
    [
      'object-held function invoked after the read',
      'const target={run:()=>0};const funcs={mutate(){target.run=()=>fetch("https://invalid.example")}};target.run();funcs.mutate();',
    ],
    [
      'sibling function invoked after the read',
      'const target={run:()=>0};read();mutate();function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
    [
      'program write after a nested read',
      'const target={run:()=>0};read();target.run=()=>fetch("https://invalid.example");function read(){target.run()}',
    ],
  ])('ignores a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'dormant closure',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}target.run();',
    ],
    [
      'closure invoked after the read',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}target.run();mutate();',
    ],
  ])('does not apply a mutation from a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'dormant wrapper containing both write and read',
      'const target={run:()=>0};function wrapper(){mutate();read()}read();function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
    [
      'dormant recursive wrapper cycle',
      'const target={run:()=>0};function a(){b()}function b(){a();mutate();read()}read();function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
  ])('ignores a mutation path in a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'array forEach callback',
      'const target={run:()=>0};[0].forEach(()=>{target.run=()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'generic callback parameter',
      'const target={run:()=>0};function apply(callback){callback()}apply(()=>{target.run=()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'named generic callback parameter',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}function apply(callback){callback()}apply(mutate);target.run();',
    ],
    [
      'callback invoking a helper',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}function apply(callback){callback()}apply(()=>mutate());target.run();',
    ],
  ])('orders a mutation through a synchronous %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'two helper edges',
      'const target={run:()=>0},dispatch={run:()=>0};function apply(callback){callback()}function install(){dispatch.run=helper}function helper(){mutate()}function mutate(){target.run=()=>fetch("https://invalid.example")}function invoke(){dispatch.run()}function read(){target.run()}apply(install);invoke();read()',
    ],
    [
      'three helper edges',
      'const target={run:()=>0},dispatch={run:()=>0};function apply(callback){callback()}function install(){dispatch.run=helper}function helper(){middle()}function middle(){mutate()}function mutate(){target.run=()=>fetch("https://invalid.example")}function invoke(){dispatch.run()}function read(){target.run()}apply(install);invoke();read()',
    ],
  ])('replays readers after discovering %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0},dispatch={run:()=>0};function apply(callback){callback()}function install(){dispatch.run=helper}function helper(){mutate()}function mutate(){target.run=()=>0}function invoke(){dispatch.run()}function read(){target.run()}apply(install);invoke();read()',
    'const target={run:()=>0},dispatch={run:()=>0};function apply(callback){callback()}function install(){dispatch.run=helper}function helper(){cycle()}function cycle(){helper()}function invoke(){dispatch.run()}function read(){target.run()}apply(install);invoke();read()',
  ])('terminates a safe multi-hop mutation graph', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('builds the same bounded mutation graph across declaration orders', () => {
    const readers = Array.from(
      { length: 128 },
      (_unused, index) => `function r${String(index)}(){target.run()}`
    ).join('');
    const calls = Array.from(
      { length: 128 },
      (_unused, index) => `r${String(index)}()`
    ).join(';');
    const prefix = 'const target={run:()=>0};';
    const mutation = 'function mutate(){target.run=()=>0}';
    const execution = `mutate();${calls}`;

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `${prefix}${mutation}${readers}${execution}`
      )
    ).toEqual([]);
    expect(
      inspectCloudflareLoadEffectsForTesting(
        `${prefix}${readers}${mutation}${execution}`
      )
    ).toEqual([]);
  });

  it.each([
    [
      'nested member receiver',
      'const box={target:{run:()=>0}};box.target.run=()=>fetch("https://invalid.example");box.target.run();',
    ],
    [
      'aliased nested member receiver',
      'const box={target:{run:()=>0}};const target=box.target;target.run=()=>fetch("https://invalid.example");box.target.run();',
    ],
    [
      'nested array receiver',
      'const box=[{run:()=>0}];box[0].run=()=>fetch("https://invalid.example");box[0].run();',
    ],
  ])('tracks a mutation on a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('rejects an unresolved computed structural mutation receiver', () => {
    const source =
      'const box={x:{run:()=>0}};box[key].run=()=>undefined;box.x.run();';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    [
      'source getter return',
      'const target={};Object.assign(target,{get run(){return()=>fetch("https://invalid.example")}});target.run();',
    ],
    [
      'target setter',
      'const target={set run(value){fetch("https://invalid.example")}};Object.assign(target,{run:1});',
    ],
    [
      'Function.prototype.call',
      'const target={};Object.assign.call(null,target,{run:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Function.prototype.apply',
      'const target={};Object.assign.apply(null,[target,{run:()=>fetch("https://invalid.example")}]);target.run();',
    ],
    [
      'Reflect.apply',
      'const target={};Reflect.apply(Object.assign,null,[target,{run:()=>fetch("https://invalid.example")}]);target.run();',
    ],
    [
      'nested Function.prototype.call',
      'const target={};Object.assign.call.call(Object.assign,null,target,{run:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'bound Function.prototype.apply arguments',
      'const target={};const args=[target,{run:()=>fetch("https://invalid.example")}];Object.assign.apply(null,args);target.run();',
    ],
    [
      'nested Reflect.apply',
      'const target={};Reflect.apply(Reflect.apply,null,[Object.assign,null,[target,{run:()=>fetch("https://invalid.example")}]]);target.run();',
    ],
  ])('models Object.assign %s semantics', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('resolves a locally shadowed globalThis object that retains native Object.assign', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const globalThis={Object};const target={};globalThis.Object.assign(target,{run:()=>fetch("https://shadowed-global-this.invalid.example")});target.run()'
      )
    ).toEqual(['fetch("https://shadowed-global-this.invalid.example")']);
  });

  it.each([
    [
      'target setter',
      'const target={set run(value){value()}},args=[target,{run:()=>fetch("https://spread.invalid.example")}];Object.assign(...args)',
    ],
    [
      'returned target',
      'const args=[{run:()=>0},{run:()=>fetch("https://spread.invalid.example")}];Object.assign(...args).run()',
    ],
    [
      'later target read',
      'const target={run:()=>0},args=[target,{run:()=>fetch("https://spread.invalid.example")}];Object.assign(...args);target.run()',
    ],
  ])(
    'expands direct Object.assign spread arguments for a %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
        'fetch("https://spread.invalid.example")',
      ]);
    }
  );

  it('rejects opaque direct Object.assign spread arguments', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting('Object.assign(...getArgs())')
    ).toThrow('statically analyzable spread arguments');
  });

  it.each([
    [
      'Object.defineProperty',
      'const target={};Object.defineProperty(target,"run",{set(value){fetch("https://setter.invalid.example")}});Object.assign(target,{run:1})',
    ],
    [
      'Object.defineProperties',
      'const target={};Object.defineProperties(target,{run:{set(value){fetch("https://setter.invalid.example")}}});Object.assign(target,{run:1})',
    ],
    [
      'an inherited descriptor',
      'const prototype={};Object.defineProperty(prototype,"run",{set(value){fetch("https://setter.invalid.example")}});const target=Object.create(prototype);Object.assign(target,{run:1})',
    ],
  ])(
    'executes an Object.assign target setter installed by %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
        'fetch("https://setter.invalid.example")',
      ]);
    }
  );

  it('executes an ambient Object.prototype setter during Object.assign', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const prototype=Object.prototype;Object.defineProperty(prototype,"run",{set(value){fetch("https://ambient-setter.invalid.example")}});const target={};Object.assign(target,{run:1})'
      )
    ).toEqual(['fetch("https://ambient-setter.invalid.example")']);
  });

  it.each([
    [
      'getter-only target',
      'const target={get run(){return fetch("https://getter.invalid.example")}};Object.assign(target,{run:1})',
    ],
    [
      'omitted source member',
      'const target={};Object.defineProperty(target,"run",{set(value){fetch("https://setter.invalid.example")}});Object.assign(target,{metadata:true})',
    ],
    [
      'descriptor installed after the copy',
      'const target={};Object.assign(target,{run:1});Object.defineProperty(target,"run",{set(value){fetch("https://setter.invalid.example")}})',
    ],
  ])(
    'does not execute an Object.assign target accessor for a %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it.each([
    [
      'data property',
      'const target={set run(value){value()}};Object.assign(target,{run:()=>fetch("https://setter-value.invalid.example")})',
    ],
    [
      'source getter',
      'const target={set run(value){value()}};Object.assign(target,{get run(){return()=>fetch("https://setter-value.invalid.example")}})',
    ],
  ])(
    'passes an Object.assign %s value to the target setter',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
        'fetch("https://setter-value.invalid.example")',
      ]);
    }
  );

  it.each([
    [
      'own getter/setter with a hazardous retained getter',
      'const target={get run(){return()=>fetch("https://retained-getter.invalid.example")},set run(value){}};Object.assign(target,{run:()=>0});target.run()',
    ],
    [
      'inherited getter/setter with a hazardous retained getter',
      'const prototype={get run(){return()=>fetch("https://retained-getter.invalid.example")},set run(value){}};const target=Object.create(prototype);Object.assign(target,{run:()=>0});target.run()',
    ],
    [
      'own setter consuming a hazardous source value',
      'const target={set run(value){}};Object.assign(target,{run:()=>fetch("https://consumed-value.invalid.example")});target.run()',
    ],
    [
      'inherited setter consuming a hazardous source value',
      'const prototype={set run(value){}};const target=Object.create(prototype);Object.assign(target,{run:()=>fetch("https://consumed-value.invalid.example")});target.run()',
    ],
    [
      'local factory target with an inherited getter/setter',
      'const make=()=>{const prototype={get run(){return()=>fetch("https://retained-getter.invalid.example")},set run(value){}};return Object.create(prototype)};const target=make();Object.assign(target,{run:()=>0});target.run()',
    ],
    [
      'unresolved target',
      'const target=getTarget();Object.assign(target,{run:()=>0});target.run()',
    ],
    [
      'ambient Object.prototype setter',
      'const prototype=Object.prototype;Object.defineProperty(prototype,"run",{set(value){fetch("https://ambient-setter.invalid.example")}});const target={};Object.assign(target,{run:1});target.run()',
    ],
  ])(
    'fails closed when Object.assign post-state is intercepted by an %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it('enumerates a source member installed by an earlier Object.assign', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const source={};Object.assign(source,{run:()=>fetch("https://prior-source.invalid.example")});const target={set run(value){value()}};Object.assign(target,source)'
      )
    ).toEqual(['fetch("https://prior-source.invalid.example")']);
  });

  it('uses the latest value of a source member installed by earlier Object.assign calls', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const source={};Object.assign(source,{run:()=>fetch("https://overwritten.invalid.example")});Object.assign(source,{run:()=>0});const target={set run(value){value()}};Object.assign(target,source)'
      )
    ).toEqual([]);
  });

  it('enumerates a member installed on an Object.create result source', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const source=Object.create({});Object.assign(source,{run:1});const target={set run(value){fetch("https://created-source.invalid.example")}};Object.assign(target,source)'
      )
    ).toEqual(['fetch("https://created-source.invalid.example")']);
  });

  it('enumerates static string indices copied by Object.assign', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={set 0(value){fetch("https://string-source.invalid.example")}};Object.assign(target,"a")'
      )
    ).toEqual(['fetch("https://string-source.invalid.example")']);
  });

  it.each([
    'const target={};Object.assign(target,getSource())',
    'const target=Object.create(null);Object.assign(target,getSource())',
    'const target=Object.create(null,{});Object.assign(target,getSource())',
  ])(
    'allows an unresolved Object.assign source for a proven setter-free target (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it('does not enumerate colon-form __proto__ syntax as an own source property', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={set __proto__(value){fetch("https://not-copied.invalid.example")}};Object.assign(target,{__proto__:{}})'
      )
    ).toEqual([]);
  });

  it.each([
    [
      'unresolved call',
      'const target={set run(value){fetch("https://opaque.invalid.example")}};Object.assign(target,getSource())',
    ],
    [
      'unresolved member',
      'const target={set run(value){fetch("https://opaque.invalid.example")}};Object.assign(target,globalThis.source)',
    ],
    [
      'class instance fields',
      'class Source{run=1}const target={set run(value){fetch("https://opaque.invalid.example")}};Object.assign(target,new Source())',
    ],
    [
      'Object.create descriptors',
      'const source=Object.create(null,{run:{value:1,enumerable:true}});const target={set run(value){fetch("https://opaque.invalid.example")}};Object.assign(target,source)',
    ],
    [
      'Object.create undefined prototype',
      'const target=Object.create(undefined);Object.assign(target,getSource())',
    ],
    [
      'Object.create void prototype',
      'const target=Object.create(void 0);Object.assign(target,getSource())',
    ],
    [
      'conditionally deleted source member',
      'const source={run:1};if(globalThis.flag)delete source.run;const target={set run(value){fetch("https://conditional-delete.invalid.example")}};Object.assign(target,source)',
    ],
    [
      'source member conditionally deleted by an invoked helper',
      'function maybeDelete(value){if(globalThis.flag)delete value.run}const source={run:1};maybeDelete(source);const target={set run(value){fetch("https://conditional-delete.invalid.example")}};Object.assign(target,source)',
    ],
    [
      'mutated target prototype',
      'const prototype={set run(value){fetch("https://prototype.invalid.example")}};const target={};Object.setPrototypeOf(target,prototype);Object.assign(target,getSource())',
    ],
    [
      'aliased Object.prototype descriptor',
      'const prototype=Object.prototype;Object.defineProperty(prototype,"run",{set(value){fetch("https://prototype.invalid.example")}});const target={};Object.assign(target,getSource())',
    ],
    [
      'ambient Object.prototype descriptor with a shadowed Object binding',
      'const Object={prototype:{}};const prototype=globalThis.Object.prototype;globalThis.Object.defineProperty(prototype,"run",{set(value){fetch("https://prototype.invalid.example")}});const target={};globalThis.Object.assign(target,getSource())',
    ],
  ])(
    'rejects Object.assign key enumeration for an unsupported %s source',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it.each(['undefined', 'null'])(
    'treats a %s Object.assign source as a no-op',
    (source) => {
      expect(
        inspectCloudflareLoadEffectsForTesting(
          `const target={run:()=>fetch("https://invalid.example")};Object.assign(target,${source});target.run()`
        )
      ).toEqual(['fetch("https://invalid.example")']);
    }
  );

  it.each(['1', 'true', '1n'])(
    'preserves an Object.assign member through a static %s source',
    (source) => {
      expect(
        inspectCloudflareLoadEffectsForTesting(
          `const target={run:()=>fetch("https://preserved.invalid.example")};Object.assign(target,${source});target.run()`
        )
      ).toEqual(['fetch("https://preserved.invalid.example")']);
    }
  );

  it('copies only canonical string indices through Object.assign', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'Object.assign({run:()=>fetch("https://preserved.invalid.example")},"a").run()'
      )
    ).toEqual(['fetch("https://preserved.invalid.example")']);
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'Object.assign({"01":()=>fetch("https://preserved.invalid.example")},"a")["01"]()'
      )
    ).toEqual(['fetch("https://preserved.invalid.example")']);
  });

  it('preserves an existing member when static Object.assign sources omit it', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>fetch("https://preserved.invalid.example")};Object.assign(target,null,{metadata:true},undefined);target.run()'
      )
    ).toEqual(['fetch("https://preserved.invalid.example")']);
  });

  it.each([
    [
      'later read',
      'const target={run:()=>fetch("https://preserved.invalid.example")};Object.assign(target,null,{metadata:true});target.run()',
    ],
    [
      'returned target',
      'Object.assign({run:()=>fetch("https://preserved.invalid.example")},null,{metadata:true}).run()',
    ],
    [
      'no sources',
      'Object.assign({run:()=>fetch("https://preserved.invalid.example")}).run()',
    ],
  ])(
    'preserves an Object.assign target member through a %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
        'fetch("https://preserved.invalid.example")',
      ]);
    }
  );

  it.each([
    [
      'later read',
      'const target={};Object.assign(target,{get run(){return()=>fetch("https://accessor.invalid.example")},set run(value){}});target.run()',
    ],
    [
      'returned target',
      'Object.assign({},{set run(value){},get run(){return()=>fetch("https://accessor.invalid.example")}}).run()',
    ],
    [
      'numeric key',
      'Object.assign({},{1:()=>fetch("https://accessor.invalid.example")})["1"]()',
    ],
  ])(
    'resolves an effective Object.assign source property for a %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
        'fetch("https://accessor.invalid.example")',
      ]);
    }
  );

  it.each([
    'const target={};Object.assign(target,{get run(){return()=>fetch("https://overwritten.invalid.example")},run:()=>0});target.run()',
    'Object.assign({},{get run(){return()=>fetch("https://overwritten.invalid.example")},run:()=>0}).run()',
    'Object.assign({},{run:()=>fetch("https://data.invalid.example"),get run(){return()=>fetch("https://earlier.invalid.example")},get run(){return()=>0}}).run()',
  ])(
    'lets a later Object.assign data property replace an accessor',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it('uses the latest same-kind Object.assign source accessor', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'Object.assign({},{run:()=>0,get run(){return()=>0},get run(){return()=>fetch("https://latest.invalid.example")}}).run()'
      )
    ).toEqual(['fetch("https://latest.invalid.example")']);
  });

  it('rejects Object.assign aliasing when the assignment target is unresolved', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'Object.assign(globalThis.target,{run:()=>fetch("https://unresolved.invalid.example")},globalThis.target).run()'
      )
    ).toThrow('rejects opaque aggregate member mutations');
  });

  it('preserves an Array.from member through an omitting Object.assign mutation', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const values={0:()=>fetch("https://preserved-array.invalid.example"),length:1};Object.assign(values,{metadata:true});Array.from(values,value=>value())'
      )
    ).toEqual(['fetch("https://preserved-array.invalid.example")']);
  });

  it.each([
    [
      'retains an earlier source write when a later source omits the member',
      'const target={run:()=>0};Object.assign(target,{run:()=>fetch("https://earlier.invalid.example")},{metadata:true});target.run()',
      ['fetch("https://earlier.invalid.example")'],
    ],
    [
      'uses a later safe source write',
      'const target={run:()=>0};Object.assign(target,{run:()=>fetch("https://earlier.invalid.example")},{run:()=>0});target.run()',
      [],
    ],
    [
      'uses a later hazardous source write',
      'const target={run:()=>0};Object.assign(target,{run:()=>0},{run:()=>fetch("https://later.invalid.example")});target.run()',
      ['fetch("https://later.invalid.example")'],
    ],
    [
      'uses the last duplicate property in one source',
      'const target={run:()=>0};Object.assign(target,{run:()=>fetch("https://earlier.invalid.example"),run:()=>0});target.run()',
      [],
    ],
  ])('%s', (_label, source, expected) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(expected);
  });

  it.each([
    [
      'computed member',
      'const target={run:()=>fetch("https://preserved.invalid.example")};Object.assign(target,{[globalThis.key]:()=>0});target.run()',
    ],
    [
      'spread member',
      'const target={run:()=>fetch("https://preserved.invalid.example")};Object.assign(target,{...globalThis.source});target.run()',
    ],
    [
      'alternative source membership',
      'const target={run:()=>fetch("https://preserved.invalid.example")};const source=globalThis.flag?{run:()=>0}:{metadata:true};Object.assign(target,source);target.run()',
    ],
  ])('rejects ambiguous Object.assign %s semantics', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    [
      'member assignment',
      'const source={};source.run=()=>fetch("https://installed.invalid.example");const target={run:()=>0};Object.assign(target,source);target.run()',
    ],
    [
      'member deletion',
      'const source={run:()=>0};delete source.run;const target={run:()=>fetch("https://preserved.invalid.example")};Object.assign(target,source);target.run()',
    ],
    [
      'property definition on a returned target',
      'const source={};Object.defineProperty(source,"run",{enumerable:true,value:()=>fetch("https://defined.invalid.example")});Object.assign({},source).run()',
    ],
    [
      'conditional member deletion',
      'const source={run:()=>0};if(globalThis.flag)delete source.run;const target={run:()=>fetch("https://preserved.invalid.example")};Object.assign(target,source);target.run()',
    ],
    [
      'nested Object.assign mutation',
      'const source={};Object.assign(source,{run:()=>fetch("https://nested.invalid.example")});Object.assign({},source).run()',
    ],
    [
      'unresolved computed assignment',
      'const source={run:()=>0};source[globalThis.key]=()=>fetch("https://computed.invalid.example");Object.assign({},source).run()',
    ],
  ])(
    'rejects Object.assign source state changed by a prior %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it('does not apply Object.assign source mutations that occur after the copy', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const source={run:()=>0};const target={};Object.assign(target,source);source.run=()=>fetch("https://later.invalid.example");target.run()'
      )
    ).toEqual([]);
  });

  it('allows a prior mutation of an unrelated Object.assign source member', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const source={run:()=>fetch("https://retained.invalid.example")};source.meta=1;const target={};Object.assign(target,source);target.run()'
      )
    ).toEqual(['fetch("https://retained.invalid.example")']);
  });

  it.each([
    [
      'ordinary target',
      'const target={run:()=>0};Object.assign(target,{run:()=>fetch("https://first.invalid.example")},target);target.run()',
    ],
    [
      'returned target',
      'const target={run:()=>0};Object.assign(target,{run:()=>fetch("https://first.invalid.example")},target).run()',
    ],
    [
      'preexisting target alias',
      'const target={run:()=>0},alias=target;Object.assign(target,{run:()=>fetch("https://first.invalid.example")},alias);target.run()',
    ],
  ])(
    'rejects Object.assign source-target aliasing through a %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it.each([
    [
      'later argument assignment',
      'const source={run:()=>0};const target={};Object.assign(target,source,(source.run=()=>fetch("https://later.invalid.example"),{}));target.run()',
    ],
    [
      'later argument assignment with a returned target',
      'const source={run:()=>0};Object.assign({},source,(source.run=()=>fetch("https://later.invalid.example"),{})).run()',
    ],
  ])('rejects Object.assign source state changed by a %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    [
      'ordinary target',
      'const target={};Object.assign(target,{run:()=>fetch("https://overwritten.invalid.example")},{set run(value){}});target.run()',
    ],
    [
      'returned target',
      'Object.assign({},{run:()=>fetch("https://overwritten.invalid.example")},{set run(value){}}).run()',
    ],
  ])(
    'treats a setter-only Object.assign source as an undefined overwrite for a %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it.each([
    [
      'direct target',
      'const target={run:()=>0};Object.assign(target,source());target.run()',
    ],
    [
      'preexisting alias',
      'const target={run:()=>0},alias=target;Object.assign(target,source());alias.run()',
    ],
    [
      'returned alias',
      'const target={run:()=>0};const alias=Object.assign(target,source());alias.run()',
    ],
    [
      'container alias',
      'const target={run:()=>0},box={target};Object.assign(target,source());box.target.run()',
    ],
  ])(
    'keeps an opaque Object.assign source fail-closed through a %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects opaque aggregate member mutations'
      );
    }
  );

  it('validates every returned-target Object.assign source before selecting the last writer', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'Object.assign({},source(),{run:()=>0}).run()'
      )
    ).toThrow('rejects opaque aggregate member mutations');
  });

  it.each([
    'const source={run:()=>0};const target={};Object.assign(target,Object.assign(source,{run:()=>fetch("https://nested.invalid.example")}));target.run()',
    'const source={run:()=>fetch("https://nested.invalid.example")};const target={};Object.assign(target,Object.assign(source,{run:()=>0}));target.run()',
  ])('fails closed on nested Object.assign result state (%s)', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it('does not propagate an exact Object.assign mutation to an unrelated receiver', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const first={};const second={run:()=>0};Object.assign(first,source());second.run()'
      )
    ).toEqual([]);
  });

  it.each([
    [
      'named prototype getter',
      'const proto={get run(){return()=>fetch("https://invalid.example")}};const target=Object.create(proto);target.run();',
    ],
    [
      'transitive named prototype getter',
      'const root={get run(){return()=>fetch("https://invalid.example")}};const proto=Object.create(root);const target=Object.create(proto);target.run();',
    ],
    [
      'named prototype setter on assignment',
      'const proto={set run(value){fetch("https://invalid.example")}};const target=Object.create(proto);target.run=1;',
    ],
    [
      'named prototype setter through Object.assign',
      'const proto={set run(value){fetch("https://invalid.example")}};const target=Object.create(proto);Object.assign(target,{run:1});',
    ],
  ])('models an Object.create %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'Object.create(null,{run:{value:()=>fetch("https://invalid.example")}}).run()',
    'Object.fromEntries([["run",()=>fetch("https://invalid.example")]]).run()',
  ])('models a static object-producing intrinsic (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'Reflect.defineProperty data descriptor',
      'const target={};Reflect.defineProperty(target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Reflect.set',
      'const target={};Reflect.set(target,"run",()=>fetch("https://invalid.example"));target.run();',
    ],
  ])('models a supported %s mutation', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    'Reflect.set({},"run",()=>fetch("https://stored.invalid.example"))',
    'const set=Reflect.set;set({},"run",()=>fetch("https://stored-alias.invalid.example"))',
    'Reflect.set.call(null,{},"run",()=>fetch("https://stored-call.invalid.example"))',
    'Reflect.set.apply(null,[{},"run",()=>fetch("https://stored-apply.invalid.example")])',
    'Reflect.apply(Reflect.set,null,[{},"run",()=>fetch("https://stored-reflect-apply.invalid.example")])',
  ])(
    'keeps a function merely stored by intrinsic Reflect.set dormant (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it('preserves callback execution by a shadowed Reflect.set', () => {
    const source =
      'const Reflect={set(_target,_key,value){value()}};Reflect.set({},"run",()=>fetch("https://shadowed-reflect-set.invalid.example"))';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://shadowed-reflect-set.invalid.example")'
    );
  });

  it.each([
    'const target={set run(value){value()}};Reflect.set(target,"run",()=>fetch("https://reflect-set-setter.invalid.example"))',
    'const set=Reflect.set,target={set run(value){value()}};set(target,"run",()=>fetch("https://aliased-reflect-set-setter.invalid.example"))',
  ])(
    'passes the stored Reflect.set value to an invoked setter (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
    }
  );

  it.each([
    [
      'aliased Object.defineProperty',
      'const target={};const define=Object.defineProperty;define(target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'aliased Reflect.defineProperty',
      'const target={};const define=Reflect.defineProperty;define(target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Object.defineProperty.call',
      'const target={};Object.defineProperty.call(null,target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Object.defineProperty.apply',
      'const target={};Object.defineProperty.apply(null,[target,"run",{value:()=>fetch("https://invalid.example")}]);target.run();',
    ],
    [
      'Reflect.apply Object.defineProperty',
      'const target={};Reflect.apply(Object.defineProperty,null,[target,"run",{value:()=>fetch("https://invalid.example")}]);target.run();',
    ],
  ])('models a normalized %s mutation', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('rejects opaque intrinsic mutation apply arguments', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperty.apply(null,getArguments());target.run();'
      )
    ).toThrow('statically analyzable Function.prototype.apply arguments');
  });

  it('keeps a same-parameter defineProperty mutation precise', () => {
    const source =
      'const apply=inst=>{Object.defineProperty(inst,"run",{value:()=>fetch("https://invalid.example")});inst.run()};apply({});';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'Object.defineProperties value descriptor',
      'const target={};Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    ],
    [
      'Object.defineProperties.call value descriptor',
      'const target={};Object.defineProperties.call(null,target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    ],
    [
      'Object.defineProperties getter descriptor',
      'const target={};Object.defineProperties(target,{run:{get:()=>()=>fetch("https://invalid.example")}});target.run();',
    ],
  ])('models a supported %s mutation', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={};Object.defineProperties(target,{run:{value:()=>undefined}});target.run();',
    'const target={};Object.defineProperties.call(null,target,{run:{value:()=>undefined}});target.run();',
    'const target={};const descriptors={run:{value:()=>undefined}};Object.defineProperties(target,descriptors);target.run();',
    'const target={};Object.defineProperties(target,{run:{get:undefined,set:()=>undefined}});void target.run;',
    'const target={};Object.defineProperties(target,{run:{get:void 0,set:()=>undefined}});void target.run;',
  ])('allows a safe %s mutation', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'factory-produced descriptor map',
      'const map=run=>({run:{value:run}});const target={};Object.defineProperties(target,map(()=>fetch("https://invalid.example")));target.run();',
    ],
    [
      'nested factory-produced descriptor',
      'const descriptor=value=>({value});const map=run=>({run:descriptor(run)});const target={};Object.defineProperties(target,map(()=>fetch("https://invalid.example")));target.run();',
    ],
    [
      'prior descriptor-map mutation',
      'const descriptors={};descriptors.run={value:()=>fetch("https://invalid.example")};const target={};Object.defineProperties(target,descriptors);target.run();',
    ],
    [
      'prior descriptor mutation',
      'const descriptor={};descriptor.value=()=>fetch("https://invalid.example");const target={};Object.defineProperties(target,{run:descriptor});target.run();',
    ],
    [
      'immediate returned receiver',
      'Object.defineProperties({},{run:{value:()=>fetch("https://invalid.example")}}).run();',
    ],
    [
      'aliased returned receiver',
      'const target={};const result=Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")}});result.run();',
    ],
    [
      'conditional receiver',
      'const first={};const second={};Object.defineProperties(flag?first:second,{run:{value:()=>fetch("https://invalid.example")}});first.run();',
    ],
  ])('preserves %s ownership', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={};Object.defineProperties(target,{run:{__proto__:{value:()=>fetch("https://invalid.example")}}});target.run();',
    'const key=getKey();const target={};Object.defineProperties(target,{[key]:{value:()=>fetch("https://invalid.example")}});target[key]();',
    'const key=Symbol.for("run");const target={};Object.defineProperties(target,{[key]:{value:()=>fetch("https://invalid.example")}});target[key]();',
  ])('fails closed for ambiguous descriptor semantics', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it('tracks inherited descriptor fields on Object.prototype', () => {
    const source =
      'Object.prototype.value=()=>fetch("https://invalid.example");const target={};Object.defineProperties(target,{run:{}});target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('uses last-property semantics for descriptor maps and descriptors', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")},run:{value:()=>undefined}});target.run();'
      )
    ).toEqual([]);
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example"),value:()=>undefined}});target.run();'
      )
    ).toEqual([]);
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{value:()=>undefined,value:()=>fetch("https://invalid.example")}});target.run();'
      )
    ).toContain('fetch("https://invalid.example")');
  });

  it.each([
    'const target={};const define=Object.defineProperties;define(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    'const target={};Object.defineProperties.apply(null,[target,{run:{value:()=>fetch("https://invalid.example")}}]);target.run();',
    'const target={};Reflect.apply(Object.defineProperties,null,[target,{run:{value:()=>fetch("https://invalid.example")}}]);target.run();',
    'const target={};const define=Object.defineProperties.bind(null);define(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    'const target={};globalThis.Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    'const target={};Object["defineProperties"](target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
  ])('normalizes a defineProperties invocation form', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('executes a defineProperties getter when its member is read', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{get:()=>{fetch("https://invalid.example");return 1}}});void target.run;'
      )
    ).toContain('fetch("https://invalid.example")');
  });

  it('indexes statically named defineProperties mutations by member', () => {
    const writes = Array.from(
      { length: 256 },
      (_unused, index) =>
        `Object.defineProperties(target,{member${String(index)}:{value:()=>undefined}})`
    ).join(';');
    const reads = Array.from(
      { length: 256 },
      (_unused, index) => `target.member${String(index)}()`
    ).join(';');

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `const target={};${writes};${reads};`
      )
    ).toEqual([]);
  });

  it.each([
    [
      'local object method',
      'const target={run:()=>0};function wrapper(){const api={mutate(){target.run=()=>fetch("https://invalid.example")}};api.mutate()}wrapper();target.run();',
    ],
    [
      'local class method',
      'const target={run:()=>0};function wrapper(){class API{mutate(){target.run=()=>fetch("https://invalid.example")}};new API().mutate()}wrapper();target.run();',
    ],
  ])('orders a mutation performed by an active %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'prototype method',
      'function outer(){class C{run(){fetch("https://invalid.example")}}return new C()}outer().run();',
    ],
    [
      'constructor-assigned member',
      'function outer(){class C{constructor(){this.run=()=>fetch("https://invalid.example")}}return new C()}outer().run();',
    ],
    [
      'post-construction member alias',
      'function clone(inst){class C{}const cl=new C();cl.parent=inst;return cl}const source={run:()=>fetch("https://invalid.example")};clone(source).parent.run();',
    ],
    [
      'factory-forwarded constructor',
      'function make(C){return new C()}function outer(){class C{run(){fetch("https://invalid.example")}}return make(C)}outer().run();',
    ],
  ])('recovers a factory-returned local class %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('specializes a constructor-returned nested factory alias', () => {
    const source =
      'function C(value){value._zod={};return value}function clone(inst){const target={run:()=>undefined};const cl=new C(target);cl._zod.parent=inst;return cl}const shared={run:()=>undefined},copy=clone(shared);shared.run=()=>fetch("https://constructor-parameter.invalid.example");copy._zod.parent.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://constructor-parameter.invalid.example")'
    );
  });

  it.each([
    [
      'call result',
      'const target={run:()=>0};const get=()=>target;get().run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'conditional',
      'const target={run:()=>0};const other={run:()=>0};(flag?target:other).run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'array projection',
      'const target={run:()=>0};[target][0].run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'object projection',
      'const target={run:()=>0};({target}).target.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('tracks a %s mutation receiver', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'object spread',
      'const target={run:()=>0};const box={...{target}};const alias=box.target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'array spread',
      'const target={run:()=>0};const box=[...[target]];const alias=box[0];alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'named object spread',
      'const target={run:()=>0};const source={target};const box={...source};const alias=box.target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'named array spread',
      'const target={run:()=>0};const source=[target];const box=[...source];const alias=box[0];alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'Object.assign container',
      'const target={run:()=>0};const box=Object.assign({},{target});const alias=box.target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'object rest',
      'const target={run:()=>0};const source={target};const {...rest}=source;const alias=rest.target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'array rest',
      'const target={run:()=>0};const source=[target];const [...rest]=source;const alias=rest[0];alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('does not lose a nested alias through %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each(['Map', 'Set'])(
    'allows an opaque ambient %s spread when no element reaches a callable position',
    (collection) => {
      expect(
        inspectCloudflareLoadEffectsForTesting(
          `const values=new ${collection}();const copied=[...values];copied.filter(Boolean);`
        )
      ).toEqual([]);
    }
  );

  it('rejects an opaque ambient collection element that reaches a callable position', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const values=new Map();const copied=[...values];copied[0][0]();'
      )
    ).toThrow('statically analyzable aggregate spreads');
  });

  it('rejects an opaque custom iterable spread', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'class Values{*[Symbol.iterator](){yield 1}}const values=new Values();const copied=[...values];'
      )
    ).toThrow('statically analyzable aggregate spreads');
  });

  it.each([
    [
      'Object.defineProperty',
      'const target={run:()=>0};function mutate(){const define=Object.defineProperty;define(target,"run",{value:()=>fetch("https://invalid.example")})}mutate();target.run();',
    ],
    [
      'Object.defineProperties',
      'const target={run:()=>0};function mutate(){const define=Object.defineProperties;define(target,{run:{value:()=>fetch("https://invalid.example")}})}mutate();target.run();',
    ],
    [
      'Object.assign',
      'const target={run:()=>0};function mutate(){const assign=Object.assign;assign(target,{run:()=>fetch("https://invalid.example")})}mutate();target.run();',
    ],
  ])('normalizes a function-local %s alias', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('fails closed for a function-local legacy getter alias', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>0};function mutate(){const getter=target.__defineGetter__;getter("run",()=>()=>fetch("https://invalid.example"))}mutate();target.run();'
      )
    ).toThrow('rejects opaque aggregate member mutations');
  });

  it.each([
    'Reflect.get(globalThis,"fetch")("https://invalid.example")',
    'Object.getOwnPropertyDescriptor(globalThis,"fetch").value("https://invalid.example")',
    'const get=Reflect.get;get(globalThis,"fetch")("https://invalid.example")',
    'const descriptor=Object.getOwnPropertyDescriptor(globalThis,"fetch");descriptor.value("https://invalid.example")',
    'const evil=()=>fetch("https://invalid.example"),target={run:evil};function get(target,key){return Reflect.get(target,key)}get(target,"run")()',
    'const evil=()=>fetch("https://invalid.example"),target={run:evil};function get(target,key){return Object.getOwnPropertyDescriptor(target,key)}get(target,"run").value()',
    'Reflect.get({get effect(){fetch("https://invalid.example");return 1}},"effect")',
    'const base={get effect(){this.run()}},receiver={run:()=>fetch("https://invalid.example")};Reflect.get(base,"effect",receiver)',
    'Object.getOwnPropertyDescriptor({get effect(){fetch("https://invalid.example")}},"effect").get()',
    'Object.getOwnPropertyDescriptor({set effect(value){fetch("https://invalid.example")}},"effect").set(1)',
    'Reflect.getOwnPropertyDescriptor({effect:()=>fetch("https://invalid.example")},"effect").value()',
    'function descriptor(target,key){return Reflect.getOwnPropertyDescriptor(target,key)}descriptor({effect:()=>fetch("https://invalid.example")},"effect").value()',
  ])('detects a reflective load-effect read', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const target={};const descriptors=getDescriptors();Object.defineProperties(target,descriptors);target.run();',
    'const target={};const extra=getDescriptors();Object.defineProperties(target,{...extra});target.run();',
    'const target={};const descriptor=getDescriptor();Object.defineProperties(target,{run:descriptor});target.run();',
  ])('rejects an opaque Object.defineProperties mutation', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    'const target={};Object.setPrototypeOf(target,{run:()=>undefined});target.run();',
    'const target={};Reflect.setPrototypeOf(target,{run:()=>undefined});target.run();',
    'const target={};Object.setPrototypeOf.call(null,target,{run:()=>undefined});target.run();',
    'const target={};Reflect.apply(Object.setPrototypeOf,null,[target,{run:()=>undefined}]);target.run();',
    'const target={};target.__proto__={run:()=>undefined};target.run();',
    'const target={};target.__defineGetter__("run",()=>()=>undefined);target.run();',
    'const target={};const define=target.__defineGetter__;define("run",()=>()=>undefined);target.run();',
  ])('rejects an unsupported aggregate mutation family', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  const sharedLocalFactoryDag = (leaf, layerCount) => {
    const layers = [
      `const layer0=make(${leaf});`,
      ...Array.from(
        { length: layerCount },
        (_unused, index) =>
          `const layer${index + 1}=fan(layer${index},layer${index});`
      ),
    ].join('');
    return `const make=effect=>()=>effect(),fan=(left,right)=>()=>{left();right()},consume=action=>()=>action();${layers}consume(layer${layerCount})();`;
  };

  it('bounds a safe shared local factory DAG by unique specialization', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(sharedLocalFactoryDag('()=>0', 10))
    ).toEqual([]);
  });

  it('preserves a hazardous leaf in a shared local factory DAG', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        sharedLocalFactoryDag('()=>fetch("https://invalid.example")', 10)
      )
    ).toContain('fetch("https://invalid.example")');
  });

  it('fails deep local factory resolution with the bounded diagnostic', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(sharedLocalFactoryDag('()=>0', 14))
    ).toThrow('exceeded bounded target candidate resolution depth');
  });

  it('indexes a wide set of irrelevant member mutations without quadratic scans', () => {
    const writes = Array.from(
      { length: 4_096 },
      (_unused, index) => `target["member${String(index)}"]=()=>undefined`
    ).join(';');

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `const target={run:()=>undefined};${writes};target.run();`
      )
    ).toEqual([]);
  });

  it('keeps React-like irrelevant receiver writes out of intrinsic replacement analysis', () => {
    const source = `
      const useStore=(store)=>store.useState("floatingElement");
      const store={useState:()=>({}),getSnapshot:()=>({})};
      const floating=useStore(store);
      const useCallback=(callback)=>callback;
      const select=useCallback(()=>floating ?? store.getSnapshot());
      const instance={syncIndex:0};
      const hook={};
      instance.syncIndex+=1;
      hook.store=store;
      select();
    `;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('keeps an uncertain irrelevant receiver member bounded', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'export function update(candidate){candidate.syncIndex+=1}Object.defineProperty(class {},"name",{value:"Safe"});'
      )
    ).toEqual([]);
  });

  it('still rejects a relevant receiver member resolved to the ambient global', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'function update(candidate){candidate.Object={defineProperty(){}}}update(globalThis);Object.defineProperty(class {},"name",{value:"Unsafe"});'
      )
    ).toThrow('rejects a replaced intrinsic global Object');
  });

  it.each([
    [
      'an arrow IIFE',
      '(()=>{globalThis.Object={defineProperty(){}}})();Object.defineProperty(class {},"name",{value:"Unsafe"});',
    ],
    [
      'a function IIFE',
      '(function(){globalThis.Object={defineProperty(){}}})();Object.defineProperty(class {},"name",{value:"Unsafe"});',
    ],
    [
      'a transitively invoked nested owner',
      'function outer(){function replace(){globalThis.Object={defineProperty(){}}}replace()}outer();Object.defineProperty(class {},"name",{value:"Unsafe"});',
    ],
  ])(
    'rejects an intrinsic replacement invoked through %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'rejects a replaced intrinsic global Object'
      );
    }
  );

  it('does not apply a nested intrinsic replacement invoked after the use', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'function outer(){function replace(){globalThis.Object={defineProperty(){}}}replace()}Object.defineProperty(class {},"name",{value:"Safe"});outer();'
      )
    ).toEqual([]);
  });

  it('resolves a constant-computed intrinsic replacement name', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const key="Object";globalThis[key]={defineProperty(){}};Object.defineProperty(class {},"name",{value:"Unsafe"});'
      )
    ).toThrow('rejects a replaced intrinsic global Object');
  });

  it('fails closed for an unresolved computed ambient-global replacement', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'function replace(key){globalThis[key]={defineProperty(){}}}replace(unknownKey);Object.defineProperty(class {},"name",{value:"Unsafe"});'
      )
    ).toThrow('rejects a replaced intrinsic global Object');
  });

  it('fails closed for an unresolved computed replacement through an ambient proxy parameter', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'function replace(target,key){target[key]={defineProperty(){}}}replace(globalThis,unknownKey);Object.defineProperty(class {},"name",{value:"Unsafe"});'
      )
    ).toThrow('rejects a replaced intrinsic global Object');
  });

  it('indexes uncertain receiver calls once for pristine collections', () => {
    const constructions = Array.from(
      { length: 512 },
      () => 'new Set([1])'
    ).join(';');

    expect(
      inspectCloudflareUncertainReceiverIndexForTesting(constructions)
    ).toEqual({ builds: 1, candidatesVisited: 0 });
  });

  it('treats receiver details as uncertain during index construction', () => {
    expect(
      inspectCloudflareProvisionalReceiverDetailsForTesting('const target={}')
    ).toEqual({
      component: expect.any(String),
      isolated: false,
      opaqueUncertain: true,
      uncertain: true,
    });
  });

  it('separates dynamic Object.assign members from target identity', () => {
    const source =
      'const configure=(plugin)=>{const atoms={};const methods={};if(plugin.getAtoms)Object.assign(atoms,plugin.getAtoms?.());if(plugin.pathMethods)Object.assign(methods,plugin.pathMethods);return{atoms,methods}}';

    expect(
      inspectCloudflareReceiverDetailsForTesting(source, [
        'atoms',
        'methods',
        'plugin',
      ])
    ).toEqual({
      atoms: {
        component: expect.any(String),
        isolated: true,
        opaqueUncertain: false,
        uncertain: false,
      },
      methods: {
        component: expect.any(String),
        isolated: true,
        opaqueUncertain: false,
        uncertain: false,
      },
      plugin: {
        component: expect.any(String),
        isolated: false,
        opaqueUncertain: false,
        uncertain: true,
      },
    });
  });

  it('keeps direct fresh spread containers isolated without trusting projected values', () => {
    const source =
      'const object={...unknown,open:true};const array=[...unknown];const {projected}={...unknown};const assigned=Object.assign({},unknown);';

    expect(
      inspectCloudflareReceiverDetailsForTesting(source, [
        'array',
        'assigned',
        'object',
        'projected',
      ])
    ).toEqual({
      array: {
        component: expect.any(String),
        isolated: true,
        opaqueUncertain: false,
        uncertain: false,
      },
      assigned: {
        component: expect.any(String),
        isolated: false,
        opaqueUncertain: true,
        uncertain: true,
      },
      object: {
        component: expect.any(String),
        isolated: true,
        opaqueUncertain: false,
        uncertain: false,
      },
      projected: {
        component: expect.any(String),
        isolated: false,
        opaqueUncertain: true,
        uncertain: true,
      },
    });
  });

  it('still observes a mutation and computed read on the same fresh spread container', () => {
    const source =
      'const base={};const fresh={...base};const key=globalThis.flag?"run":"stop";fresh[key]=()=>fetch("https://invalid.example");fresh[key]();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('does not classify values projected from fresh opaque spreads as isolated', () => {
    const source =
      'const object={...unknown};const objectValue=object.value;const array=[...unknown];const arrayValue=array[0];';

    expect(
      inspectCloudflareReceiverDetailsForTesting(source, [
        'array',
        'arrayValue',
        'object',
        'objectValue',
      ])
    ).toEqual({
      array: {
        component: expect.any(String),
        isolated: true,
        opaqueUncertain: false,
        uncertain: false,
      },
      arrayValue: {
        component: expect.any(String),
        isolated: false,
        opaqueUncertain: false,
        uncertain: false,
      },
      object: {
        component: expect.any(String),
        isolated: true,
        opaqueUncertain: false,
        uncertain: false,
      },
      objectValue: {
        component: expect.any(String),
        isolated: false,
        opaqueUncertain: false,
        uncertain: false,
      },
    });
  });

  it('keeps an isolated local receiver out of delegated parameter summaries', () => {
    const source =
      'const UNINITIALIZED={};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}function createLocal(){return{callback:null,refs:[]}}function read(value){return value.refs.length}function update(value,refs){value.refs=refs;value.callback=()=>value.refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;if(read(local))update(local,refs);return local.callback}';

    expect(
      inspectCloudflareLoadInternalIsolatedReceiverForTesting(
        source,
        'wrapper',
        'local'
      )
    ).toBe(true);
  });

  it.each([
    [
      'a member store',
      'const UNINITIALIZED={};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;globalThis.saved=local;update(local,refs);return local.refs}',
    ],
    [
      'an unresolved call',
      'const UNINITIALIZED={};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;consume(local);update(local,refs);return local.refs}',
    ],
    [
      'a receiver method call',
      'const UNINITIALIZED={};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}function createLocal(){return{refs:[],run(){}}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;local.run();update(local,refs);return local.refs}',
    ],
    [
      'a reassignment',
      'const UNINITIALIZED={};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){let local=useRefWithInit(createLocal).current;local={refs:refs};update(local,refs);return local.refs}',
    ],
    [
      'a mixed object wrapper return',
      'const UNINITIALIZED={},shared={refs:[]};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();if(flag)return ref;return{current:shared}}function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
    [
      'an aliased wrapper return',
      'const UNINITIALIZED={};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();const alias=ref;return alias}function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
    [
      'a conditional wrapper return',
      'const UNINITIALIZED={},shared={refs:[]};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return flag?ref:{current:shared}}function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
    [
      'a reassigned wrapper declaration',
      'const UNINITIALIZED={},shared={refs:[]};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}useRefWithInit=()=>({current:shared});function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
    [
      'a reassigned wrapper binding',
      'const UNINITIALIZED={},shared={refs:[]};let useRefWithInit=function(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref};useRefWithInit=()=>({current:shared});function createLocal(){return{refs:[]}}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
    [
      'a reassigned initializer declaration',
      'const UNINITIALIZED={},shared={refs:[]};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}function createLocal(){return{refs:[]}}createLocal=()=>shared;function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
    [
      'a reassigned initializer binding',
      'const UNINITIALIZED={},shared={refs:[]};function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}let createLocal=()=>({refs:[]});createLocal=()=>shared;function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
    [
      'a constructor that returns a shared receiver',
      'const UNINITIALIZED={},shared={refs:[]};class SharedReceiver{constructor(){return shared}}function useRefWithInit(init){const ref={current:UNINITIALIZED};if(ref.current===UNINITIALIZED)ref.current=init();return ref}function createLocal(){return new SharedReceiver()}function update(value,refs){value.refs=refs}function wrapper(refs){const local=useRefWithInit(createLocal).current;update(local,refs);return local.refs}',
    ],
  ])('does not isolate a local receiver with %s escape', (_label, source) => {
    expect(
      inspectCloudflareLoadInternalIsolatedReceiverForTesting(
        source,
        'wrapper',
        'local'
      )
    ).toBe(false);
  });

  it('checks indexed uncertain receiver calls against collection sources', () => {
    expect(
      inspectCloudflareUncertainReceiverIndexForTesting(
        'const values=[1];values.push(2);new Set(values)'
      )
    ).toEqual({ builds: 1, candidatesVisited: 1 });
  });

  it('bounds total candidate work across individually bounded phases', () => {
    expect(() =>
      inspectCloudflareAnalysisBudgetForTesting([
        131_000, 131_000, 131_000, 131_000, 289,
      ])
    ).toThrow('exceeded bounded candidate work');
  });

  it('bounds aggregate resolution across fresh lexical contexts', () => {
    expect(inspectCloudflareAggregateResolutionDepthForTesting(64)).toEqual({
      activeAfter: 0,
      activeAtLeaf: 64,
    });
    expect(() =>
      inspectCloudflareAggregateResolutionDepthForTesting(65)
    ).toThrow('exceeded bounded aggregate resolution stack');
    expect(inspectCloudflareAggregateResolutionDepthForTesting(1)).toEqual({
      activeAfter: 0,
      activeAtLeaf: 1,
    });
  });

  it('enforces independent base and invocation analysis ceilings', () => {
    expect(() =>
      inspectCloudflareAnalysisBucketsForTesting([
        { amount: 131_073, bucket: 'base' },
      ])
    ).toThrow('exceeded bounded candidate work');
    expect(() =>
      inspectCloudflareAnalysisBucketsForTesting([
        { amount: 262_145, bucket: 'invocation' },
      ])
    ).toThrow('exceeded bounded candidate work');
  });

  it('counts both analysis buckets toward the shared total ceiling', () => {
    expect(() =>
      inspectCloudflareAnalysisBucketsForTesting([
        { amount: 131_000, bucket: 'base', reset: true },
        { amount: 131_000, bucket: 'invocation', reset: true },
        { amount: 131_000, bucket: 'base', reset: true },
        { amount: 131_000, bucket: 'invocation', reset: true },
        { amount: 289, bucket: 'invocation', reset: true },
      ])
    ).toThrow('exceeded bounded candidate work');
  });

  it('restores the analysis bucket after nested success and failure', () => {
    expect(
      inspectCloudflareAnalysisBucketsForTesting([
        { amount: 1, bucket: 'nested-invocation' },
        { amount: 1, bucket: 'nested-invocation', catch: true, throw: true },
        { amount: 1, bucket: 'base' },
      ])
    ).toEqual({ activeBucket: undefined, base: 1, invocation: 2, total: 3 });
  });

  it('bounds recursive parameter receiver propagation before the JavaScript stack', () => {
    const wrappers = [
      'function f0(target){target.run=()=>fetch("https://invalid.example")}',
      ...Array.from({ length: 31 }, (_unused, offset) => {
        const index = offset + 1;
        return `function f${String(index)}(target){f${String(index - 1)}(target)}`;
      }),
    ].join(';');

    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        `${wrappers};const target={run:()=>0};f31(target);target.run();`
      )
    ).toThrow('exceeded bounded parameter projection depth');
  });

  it('indexes wide direct-call parameter mutations without quadratic program scans', () => {
    const functionCount = 2_048;
    const functions = Array.from(
      { length: functionCount },
      (_unused, index) =>
        `function mutate${String(index)}(target){target.member${String(index)}=()=>undefined}`
    ).join(';');
    const calls = Array.from(
      { length: functionCount },
      (_unused, index) => `mutate${String(index)}(target)`
    ).join(';');

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `const target={safe:()=>undefined};${functions};${calls};target.safe();`
      )
    ).toEqual([]);
  }, 15_000);

  it.each([
    [
      'dormant function',
      'const target={run:()=>undefined};function dormant(){target.run=()=>fetch("https://invalid.example")}target.run();',
    ],
    [
      'shadowed receiver',
      'const target={run:()=>undefined};function dormant(target){target.run=()=>fetch("https://invalid.example")}target.run();',
    ],
  ])('isolates member mutations in a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('flags an unresolved dynamic key and models its write as a wildcard mutation', () => {
    const source =
      'const target={run:()=>undefined};target[key]=()=>fetch("https://invalid.example");target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'key',
      'fetch("https://invalid.example")',
    ]);
  });

  it('flags unresolved key coercion even when the assigned value is safe', () => {
    const source =
      'const target={run:()=>undefined};target[key]=()=>undefined;target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(['key']);
  });

  it('keeps a recursive dynamic aggregate cursor locally scoped', () => {
    const source =
      'const walk=path=>{const root={_errors:[]};let curr=root;let i=0;while(i<path.length){const key=path[i];curr[key]=curr[key]||{_errors:[]};curr[key]._errors.push(()=>0);curr=curr[key];i++}};walk(["x"]);';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('analyzes a safe accessor installed by a prior member mutation', () => {
    const source =
      'const target={run:()=>undefined};Object.defineProperty(target,"run",{get(){return()=>undefined}});target.run();';

    const effects = inspectCloudflareLoadEffectsForTesting(source);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toContain('Object.defineProperty');
  });

  it('executes a setter installed by defineProperty on assignment', () => {
    const source =
      'const target={};Object.defineProperty(target,"run",{set:()=>fetch("https://invalid.example")});target.run=1;';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('executes a computed key expression during a write-only member access', () => {
    const source =
      'const target={};target.run=createValue();target[getKey()]=1;';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'getKey()',
    ]);
  });

  it.each([
    [
      'Object.assign aggregate replacement',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box={route};Object.assign(box,{route:({loader})=>loader()});box.route({loader:()=>fetch("https://invalid.example")});',
      false,
      ['box', 'createFileRoute', 'route'],
    ],
    [
      'direct aggregate member replacement',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box={route};box.route=({loader})=>loader();box.route({loader:()=>fetch("https://invalid.example")});',
      false,
      ['box', 'createFileRoute', 'route'],
    ],
    [
      'unrelated sibling mutation',
      'import{createFileRoute}from"./reviewed.js";const first=createFileRoute("/a");const second=createFileRoute("/b");Object.assign(first,{metadata:true});second({loader:()=>1});',
      true,
      ['createFileRoute', 'second'],
    ],
    [
      'nested parameter shadow mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");function dormant(route){route.metadata=true}route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'called parameter alias mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");function install(value){value.handler=()=>1}install(route);route({loader:()=>1});',
      false,
      ['createFileRoute', 'route'],
    ],
    [
      'nested lexical alias mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");{const alias=route;alias.handler=()=>1}route({loader:()=>1});',
      false,
      ['createFileRoute', 'route'],
    ],
    [
      'bound intrinsic mutation arguments',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const args=[route,{handler:()=>1}];Object.assign.apply(null,args);route({loader:()=>1});',
      false,
      ['args', 'createFileRoute', 'route'],
    ],
    [
      'nested Function.prototype.call intrinsic mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");Object.assign.call.call(Object.assign,null,route,{handler:()=>1});route({loader:()=>1});',
      false,
      ['createFileRoute', 'route'],
    ],
    [
      'nested Reflect.apply intrinsic mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");Reflect.apply(Reflect.apply,null,[Object.defineProperty,null,[route,"handler",{value:()=>1}]]);route({loader:()=>1});',
      false,
      ['createFileRoute', 'route'],
    ],
    [
      'direct bound intrinsic mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");Object.assign.bind(null,route,{handler:()=>1})();route({loader:()=>1});',
      false,
      ['createFileRoute', 'route'],
    ],
    [
      'aliased bound intrinsic mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const mutate=Object.assign.bind(null,route,{handler:()=>1});mutate();route({loader:()=>1});',
      false,
      ['createFileRoute', 'route'],
    ],
    [
      'destructured assignment alias mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");let alias;[alias]=[route];alias.handler=()=>1;route({loader:()=>1});',
      false,
      ['alias', 'createFileRoute', 'route'],
    ],
    [
      'spread intrinsic mutation arguments',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const args=[route,{handler:()=>1}];Object.assign(...args);route({loader:()=>1});',
      false,
      ['args', 'createFileRoute', 'route'],
    ],
    [
      'inline parameter projection mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");function mutate({route}){Object.assign(route,{handler:()=>1})}mutate({route});route({loader:()=>1});',
      false,
      ['createFileRoute', 'route'],
    ],
    [
      'unrelated closure capture mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const describe=()=>route;Object.assign(describe,{metadata:true});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'unrelated receiver member mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const alias=route.metadata;Object.assign(alias,{x:1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'statically unreachable conditional container',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box=false?{route}:{};Object.assign(box,{route:()=>1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'statically unreachable logical-and container',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box=false&&{route};Object.assign(box,{route:()=>1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'statically unreachable logical-or container',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box=true||{route};Object.assign(box,{route:()=>1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
  ])(
    'tracks reviewed receiver mutations for %s',
    (_label, source, unmutated, roots) => {
      const [state] =
        inspectCloudflareReviewedReceiverMutationsForTesting(source);

      expect(state).toEqual({
        callee: expect.any(String),
        roots,
        unmutated,
      });
    }
  );

  it('indexes reverse-ordered reviewed receiver aliases once', () => {
    const aliasCount = 4_096;
    const dependencies = [
      'route',
      ...Array.from(
        { length: aliasCount - 1 },
        (_unused, index) => `alias${index}`
      ),
    ];
    const aliases = Array.from({ length: aliasCount }, (_unused, index) => {
      const current = aliasCount - index - 1;
      const dependency = dependencies[current];
      return `const alias${current}={${dependency}};`;
    }).join('');
    const [state] = inspectCloudflareReviewedReceiverMutationsForTesting(
      `import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");${aliases}Object.assign(alias${aliasCount - 1},{changed:true});route({loader:()=>1});`
    );

    expect(state.unmutated).toBe(false);
    expect(state.roots).toHaveLength(aliasCount + 2);
    expect(state.roots).toContain(`alias${aliasCount - 1}`);
  }, 10_000);

  it('reuses reviewed receiver indexes across many invocations', () => {
    const routeCount = 800;
    const routes = Array.from(
      { length: routeCount },
      (_unused, index) =>
        `const route${index}=createFileRoute("/${index}");route${index}({loader:()=>${index}});`
    ).join('');
    const states = inspectCloudflareReviewedReceiverMutationsForTesting(
      `import{createFileRoute}from"./reviewed.js";${routes}`
    );

    expect(states).toHaveLength(routeCount);
    expect(states.every(({ unmutated }) => unmutated)).toBe(true);
  }, 5_000);

  it.each([
    [
      'an assignment alias',
      'let first;first=require_react();const second=require_react();first.useRef=()=>0;',
      ['first', 'second'],
      false,
    ],
    [
      'an object container alias',
      'const box={first:require_react()},second=require_react();box.first.useRef=()=>0;',
      ['box', 'second'],
      false,
    ],
    [
      'an array container alias',
      'const items=[require_react()],second=require_react();items[0].useRef=()=>0;',
      ['items', 'second'],
      false,
    ],
    [
      'safe repeated declarators',
      'const first=require_react(),second=require_react();void first;void second;',
      ['first', 'second'],
      true,
    ],
  ])(
    'indexes reviewed singleton results through %s',
    (_label, body, roots, unmutated) => {
      const states = inspectCloudflareReviewedSingletonReceiverRootsForTesting(
        `import{require_react}from"./react.js";${body}`
      );

      expect(states).toHaveLength(2);
      expect(states.every((state) => state.unmutated === unmutated)).toBe(true);
      expect(
        states.every(
          (state) => JSON.stringify(state.roots) === JSON.stringify(roots)
        )
      ).toBe(true);
    }
  );

  it('preserves exact object extension/transform and preprocess lineages', () => {
    expect(
      inspectCloudflareFactoryOriginLineagesForTesting(
        'import{object}from"./zod.js";const makeSchema=()=>object({a:1}).extend({b:2}).transform(value=>value);',
        'makeSchema'
      )
    ).toEqual([
      {
        complete: true,
        origins: [
          expect.objectContaining({
            factoryArgumentCount: 1,
            importedName: 'object',
            returnedPath: [
              'extend',
              { callResult: true },
              'transform',
              { callResult: true },
            ],
          }),
        ],
      },
    ]);
    expect(
      inspectCloudflareFactoryOriginLineagesForTesting(
        'import{preprocess}from"./zod.js";const makeSchema=()=>preprocess(value=>value,{parse(){}}).transform(value=>value);',
        'makeSchema'
      )
    ).toEqual([
      {
        complete: true,
        origins: [
          expect.objectContaining({
            factoryArgumentCount: 2,
            importedName: 'preprocess',
            returnedPath: ['transform', { callResult: true }],
          }),
        ],
      },
    ]);
  });

  it.each([
    ['spread-only use', '', 1, true],
    ['read-only member use', 'void import_react.forwardRef;', 1, true],
    [
      'direct namespace mutation',
      'import_react.forwardRef=()=>null;',
      0,
      false,
    ],
    [
      'aliased namespace mutation',
      'const alias=import_react;alias.forwardRef=()=>null;',
      0,
      false,
    ],
    [
      'an array-pattern member write',
      '[import_react.forwardRef]=[()=>null];',
      0,
      false,
    ],
    [
      'a nested object-pattern member write',
      '({value:{callback:import_react.forwardRef=()=>null}}={value:{}});',
      0,
      false,
    ],
    [
      'an object-rest member write',
      '({...import_react.forwardRef}={changed:true});',
      0,
      false,
    ],
    [
      'a for-of pattern member write',
      'for({callback:import_react.forwardRef}of[{callback:()=>null}]){}',
      0,
      false,
    ],
  ])(
    'authenticates a reviewed __toESM namespace aggregate with %s',
    (_label, use, candidates, readOnly) => {
      const source = `import{a as __toESM}from"./rolldown-runtime-7_rZTKki.js";import{t as require_react}from"./react-m4gW-Tkn.js";const import_react=__toESM(require_react(),1);${use}const namespace={...import_react};`;
      const fixtureState = createReviewedReactAnalyzerFixture(source);

      expect(
        inspectCloudflareReviewedAggregateSpreadsForTesting(
          source,
          fixtureState.analysisLabel,
          fixtureState.artifactRoot,
          fixtureCloudflareProvenanceKey
        )
      ).toEqual([
        {
          candidates,
          lineageComplete: true,
          localName: 'import_react',
          origins: [{ argumentsSafe: true, policySafe: true }],
          readOnly,
        },
      ]);
    }
  );

  it.each([
    ['read-only namespace', '', true],
    ['directly mutated namespace', 'import_react.forwardRef=()=>({});', false],
    [
      'aliased mutated namespace',
      'const reactAlias=import_react;reactAlias.forwardRef=()=>({});',
      false,
    ],
  ])(
    'classifies a reviewed React forwardRef result from a %s as isolated',
    (_label, setup, isolated) => {
      const expressionSource = 'import_react.forwardRef(()=>null)';
      const source = `import{a as __toESM}from"./rolldown-runtime-7_rZTKki.js";import{t as require_react}from"./react-m4gW-Tkn.js";const import_react=__toESM(require_react(),1);${setup}const Component=${expressionSource};`;
      const fixtureState = createReviewedReactAnalyzerFixture(source);

      expect(
        inspectCloudflareKnownIsolatedReceiverExpressionForTesting(
          source,
          expressionSource,
          fixtureState.analysisLabel,
          fixtureState.artifactRoot,
          fixtureCloudflareProvenanceKey
        )
      ).toEqual([isolated]);
    }
  );

  it.each([
    ['fresh initializer result', 'return {};', '', true],
    [
      'mutated React namespace',
      'return {};',
      'import_react.useRef=()=>({current:null});',
      false,
    ],
    [
      'aliased mutated React namespace',
      'return {};',
      'const reactAlias=import_react;reactAlias.useRef=()=>({current:null});',
      false,
    ],
    ['shared initializer result', 'return shared;', 'const shared={};', false],
  ])(
    'classifies useRefWithInit(createForkRef).current for a %s',
    (_label, initializerBody, setup, localRefCurrent) => {
      const expressionSource = 'useRefWithInit(createForkRef).current';
      const source = `import{a as __toESM}from"./rolldown-runtime-7_rZTKki.js";import{t as require_react}from"./react-m4gW-Tkn.js";const import_react=__toESM(require_react(),1);${setup}function useRefWithInit(init){const ref=import_react.useRef(null);if(ref.current===null)ref.current=init();return ref}function createForkRef(){${initializerBody}}const forkRef=${expressionSource};`;
      const fixtureState = createReviewedReactAnalyzerFixture(source);

      expect(
        inspectCloudflareKnownIsolatedExpressionForTesting(
          source,
          expressionSource,
          fixtureState.analysisLabel,
          fixtureState.artifactRoot,
          fixtureCloudflareProvenanceKey
        )
      ).toEqual([{ localRefCurrent }]);
    }
  );

  it.each([
    ['node', createNodeArtifact, undefined],
    ['vercel', createVercelArtifact, undefined],
    ['cloudflare', createCloudflareArtifact, { expectedAppSlug: 'acme-app' }],
  ])(
    'accepts the exact %s target artifact contract',
    (profile, create, options) => {
      const root = fixture();
      create(root);

      expect(verifyRuntimeProfile(profile, root, options)).toBe(profile);
    }
  );

  it('accepts the signed Cloudflare v5 owner contract through production verification', () => {
    const root = fixture();
    createCloudflareV5Artifact(root);

    expect(verifyCloudflareV5Fixture(root)).toBe('cloudflare');
  });

  it.each([
    [
      'a decoy request-scope adapter',
      'runWithCloudflareTelemetry(telemetry,()=>',
      'runWithCloudflareTelemetry(sentryOptions,()=>',
      'must run application work in the captured telemetry scope',
    ],
    [
      'a decoy request-flush adapter',
      'scheduleCloudflareRequestFlush(request,telemetry,',
      'scheduleCloudflareRequestFlush(request,sentryOptions,',
      'must flush its captured telemetry adapter',
    ],
    [
      'a missing required-exception owner binding',
      'const {requireSentryOwner,sentryOptions,telemetry}=',
      'const {sentryOptions,telemetry}=',
      'must keep exact request telemetry owners immutable',
    ],
    [
      'an untrusted request-telemetry input',
      'sentryRequestIsolationReady,tracing});',
      'sentryRequestIsolationReady,tracing:void 0});',
      'request telemetry configurator must receive exact trusted inputs',
    ],
    [
      'a missing Sentry exception-owner input',
      '({context,handle,request,requireSentryOwner,sentryOptions})=>',
      '({context,handle,request,sentryOptions})=>',
      'Sentry owner must accept exact active request inputs',
    ],
    [
      'a decoy forwarded Sentry exception owner',
      'runWithCloudflareSentry({api:Sentry,handle,request,requireSentryOwner,requestOptions:',
      'runWithCloudflareSentry({api:Sentry,handle,request,requireSentryOwner:false,requestOptions:',
      'must forward required exception ownership',
    ],
  ])(
    'rejects Cloudflare v5 entry composition with %s',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareV5Artifact(root);
      replaceCloudflareV5FixtureSource(
        root,
        'dist/server/index.js',
        search,
        replacement
      );

      expect(() => verifyCloudflareV5Fixture(root)).toThrow(error);
    }
  );

  it.each([
    [
      'a missing captured telemetry parameter',
      '(request,telemetry,waitUntil)=>',
      '(request,waitUntil)=>',
      'request flush owner must accept its captured telemetry adapter',
    ],
    [
      'a decoy captured telemetry argument',
      'forceFlushRequestTelemetry(request,telemetry)',
      'forceFlushRequestTelemetry(request,createNoOpTelemetry())',
      'request flush owner must flush the captured request adapter exactly once',
    ],
    [
      'a mutable global telemetry lookup',
      'const flush=forceFlushRequestTelemetry(request,telemetry)',
      'void getTelemetry;const flush=forceFlushRequestTelemetry(request,telemetry)',
      'request flush owner must not resolve mutable global telemetry',
    ],
  ])(
    'rejects a Cloudflare v5 lifecycle owner with %s',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareV5Artifact(root);
      replaceCloudflareV5FixtureSource(
        root,
        'dist/server/assets/request-lifecycle-fixture.js',
        search,
        replacement
      );

      const failure = cloudflareV5VerificationFailure(root);
      expect(failure.message).toContain(
        'Cloudflare v5 request lifecycle owner verification failed:'
      );
      expect(failure.message).toContain(error);
    }
  );

  it('rejects a Cloudflare v5 request-scope chunk that loses its storage owner', () => {
    const root = fixture();
    createCloudflareV5Artifact(root);
    replaceCloudflareV5FixtureSource(
      root,
      'dist/server/assets/telemetry-request-scope-fixture.js',
      'requestTelemetryStorage.run(telemetry,handle)',
      'decoyStorage.run(telemetry,handle)'
    );

    const failure = cloudflareV5VerificationFailure(root);
    expect(failure.message).toContain(
      'Cloudflare v5 telemetry scope owner verification failed:'
    );
    expect(failure.message).toContain('requestTelemetryStorage');
  });

  it('rejects a Cloudflare v5 Sentry chunk that loses its required-exception owner', () => {
    const root = fixture();
    createCloudflareV5Artifact(root);
    replaceEveryCloudflareV5FixtureSource(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      'requireSentryOwner',
      'exceptionOwner'
    );

    const failure = cloudflareV5VerificationFailure(root);
    expect(failure.message).toContain(
      'Cloudflare v5 Sentry owner verification failed:'
    );
    expect(failure.message).toContain('requireSentryOwner');
  });

  it.each([
    [
      'request telemetry configuration',
      'dist/server/assets/backend-request-config-fixture.js',
      'Cloudflare v5 request telemetry owner verification failed:',
    ],
    [
      'database client',
      'dist/server/assets/client-fixture.js',
      'Cloudflare v5 database owner verification failed:',
    ],
  ])(
    'rejects a signed Cloudflare v5 %s dependency with a load effect',
    (_label, relativePath, stage) => {
      const root = fixture();
      createCloudflareV5Artifact(root);
      const fixturePath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        `fetch("https://invalid.example");${fs.readFileSync(fixturePath, 'utf8')}`
      );

      const failure = cloudflareV5VerificationFailure(root);
      expect(failure.message).toContain(stage);
      expect(failure.message).toContain(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it('rejects a signed Cloudflare v5 owner whose AST and manifest import different chunks', () => {
    const root = fixture();
    createCloudflareV5Artifact(root);
    replaceCloudflareV5FixtureSource(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      './backend-request-config-fixture.js',
      './backend-decoy-fixture.js'
    );
    write(root, 'dist/server/assets/backend-decoy-fixture.js');

    const failure = cloudflareV5VerificationFailure(root);
    expect(failure.message).toContain(
      'Cloudflare v5 request telemetry owner verification failed:'
    );
    expect(failure.message).toContain(
      'must preserve its exact Vite static import graph'
    );
  });

  it.each([
    [
      'an extra manifest edge',
      (manifest) => {
        manifest['_backend-extra-fixture.js'] = {
          file: 'assets/backend-extra-fixture.js',
          imports: [],
          name: 'backend-extra',
        };
        manifest['src/runtime/cloudflare/request-telemetry.ts'].imports.push(
          '_backend-extra-fixture.js'
        );
      },
      (root) => write(root, 'dist/server/assets/backend-extra-fixture.js'),
    ],
    [
      'a missing manifest edge',
      (manifest) => {
        manifest['src/runtime/cloudflare/request-telemetry.ts'].imports =
          manifest[
            'src/runtime/cloudflare/request-telemetry.ts'
          ].imports.filter(
            (key) => key !== '_backend-request-config-fixture.js'
          );
      },
      () => {},
    ],
  ])(
    'rejects a signed Cloudflare v5 request owner with %s',
    (_label, mutateManifest, prepareArtifact) => {
      const root = fixture();
      createCloudflareV5Artifact(root);
      mutateCloudflareV5FixtureManifest(root, mutateManifest);
      prepareArtifact(root);

      const failure = cloudflareV5VerificationFailure(root);
      expect(failure.message).toContain(
        'Cloudflare v5 request telemetry owner verification failed:'
      );
      expect(failure.message).toContain(
        'must preserve its exact Vite static import graph'
      );
    }
  );

  it('rejects an absent allowed-family import in a signed Cloudflare v5 request owner', () => {
    const root = fixture();
    createCloudflareV5Artifact(root);
    replaceCloudflareV5FixtureSource(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      './backend-request-config-fixture.js',
      './backend-absent-fixture.js'
    );

    const failure = cloudflareV5VerificationFailure(root);
    expect(failure.message).toContain(
      'Cloudflare v5 request telemetry owner verification failed:'
    );
    expect(failure.message).toContain('backend-absent-fixture.js');
  });

  it.each([
    [
      'no request-scope installation',
      'initializeCloudflareTelemetryRequestScope();',
      'void 0;',
      'must install its telemetry request scope exactly once',
    ],
    [
      'duplicate request-scope installation',
      'initializeCloudflareTelemetryRequestScope();',
      'initializeCloudflareTelemetryRequestScope();initializeCloudflareTelemetryRequestScope();',
      'must install its telemetry request scope exactly once',
    ],
    [
      'delayed request-scope installation',
      'initializeCloudflareTelemetryRequestScope();var Sentry=await import("./assets/esm-fixture.js");',
      'var Sentry=await import("./assets/esm-fixture.js");initializeCloudflareTelemetryRequestScope();',
      'must install telemetry scope immediately after importing its owner',
    ],
  ])(
    'rejects Cloudflare v5 entry composition with %s',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareV5Artifact(root);
      replaceCloudflareV5FixtureSource(
        root,
        'dist/server/index.js',
        search,
        replacement
      );

      const failure = cloudflareV5VerificationFailure(root);
      expect(failure.message).toContain(
        'Cloudflare v5 telemetry scope owner verification failed:'
      );
      expect(failure.message).toContain(error);
    }
  );

  it.each([
    [
      'a global telemetry mutation',
      'return{requireSentryOwner,sentryOptions,telemetry}',
      'setTelemetry(telemetry);return{requireSentryOwner,sentryOptions,telemetry}',
      'must return request telemetry without mutating or reading a global adapter',
    ],
    [
      'a missing required-signal assertion',
      'assertRequiredTelemetrySignals({config,readiness});',
      'void readiness;',
      'configureCloudflareRequestTelemetry must call assertRequiredTelemetrySignals',
    ],
  ])(
    'rejects a Cloudflare v5 request telemetry owner with %s',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareV5Artifact(root);
      replaceCloudflareV5FixtureSource(
        root,
        'dist/server/assets/request-telemetry-fixture.js',
        search,
        replacement
      );

      const failure = cloudflareV5VerificationFailure(root);
      expect(failure.message).toContain(
        'Cloudflare v5 request telemetry owner verification failed:'
      );
      expect(failure.message).toContain(error);
    }
  );

  it.each([
    [
      'cross-request telemetry retention',
      'export{worker_entry_default as default};',
      'var lastKnownNativeTelemetry;export{worker_entry_default as default};',
      'must not retain telemetry across Worker requests',
    ],
    [
      'runtime owners out of dependency order',
      'var {tracing}=await import("cloudflare:workers");var {runWithCloudflareDatabase}=await import("./assets/database-request-fixture.js");',
      'var {runWithCloudflareDatabase}=await import("./assets/database-request-fixture.js");var {tracing}=await import("cloudflare:workers");',
      'must initialize Cloudflare runtime owners in dependency order',
    ],
    [
      'an extra module-scope statement',
      'export{worker_entry_default as default};',
      'const extraOwner=true;export{worker_entry_default as default};',
      'must contain only its bounded Cloudflare v5 module ownership sequence',
    ],
  ])(
    'rejects Cloudflare v5 entry composition with %s',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareV5Artifact(root);
      replaceCloudflareV5FixtureSource(
        root,
        'dist/server/index.js',
        search,
        replacement
      );

      expect(() => verifyCloudflareV5Fixture(root)).toThrow(error);
    }
  );

  it('explains how to verify a Cloudflare artifact without provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);

    expect(() =>
      verifyRuntimeProfileImplementation('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Cloudflare artifact verification requires a canonical 32-byte base64url build-time provenance key; run pnpm verify:artifact:cloudflare to build, sign, and verify atomically; advanced callers verifying the same signed build may pass cloudflareAppChunkProvenanceKey or START_UI_CLOUDFLARE_PROVENANCE_KEY'
    );
  });

  it.each([
    { legacyCloudflareTelemetryFixtureForTesting: true },
    Object.create({ legacyCloudflareTelemetryFixtureForTesting: true }),
  ])(
    'rejects the legacy fixture option through production verification',
    (options) => {
      expect(() =>
        verifyRuntimeProfileImplementation('cloudflare', fixture(), options)
      ).toThrow(
        'legacy Cloudflare telemetry fixtures are unavailable through production verification'
      );
    }
  );

  it('rejects legacy fixture verification outside an active Vitest test', () => {
    const verifierUrl = pathToFileURL(
      path.resolve(process.cwd(), 'scripts/verify-runtime-profile.mjs')
    ).href;
    const program = `import { verifyLegacyCloudflareTelemetryFixtureForTesting } from ${JSON.stringify(verifierUrl)};
try {
  verifyLegacyCloudflareTelemetryFixtureForTesting('cloudflare');
} catch (error) {
  process.stdout.write(String(error?.message));
}`;

    expect(
      execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', program],
        {
          encoding: 'utf8',
        }
      )
    ).toContain(
      'legacy Cloudflare telemetry fixture verification is available only inside an active Vitest test'
    );
  });

  it.each(['not base64url!', 'c2hvcnQ'])(
    'rejects a malformed Cloudflare provenance key before reading an artifact: %s',
    (cloudflareAppChunkProvenanceKey) => {
      const root = fixture();
      createCloudflareArtifact(root);

      expect(() =>
        verifyRuntimeProfileImplementation('cloudflare', root, {
          cloudflareAppChunkProvenanceKey,
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'Cloudflare artifact verification requires a canonical 32-byte base64url build-time provenance key'
      );
    }
  );

  it('drains a long cyclic Cloudflare load-effect graph without recursive stack growth', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareLoadEffectCycle(root, 1_024);

    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  }, 30_000);

  it.each([
    [
      'altered signature',
      (envelope) => ({ ...envelope, signature: 'A'.repeat(43) }),
      fixtureCloudflareProvenanceKey,
    ],
    [
      'unsigned envelope',
      (envelope) => ({ ...envelope, algorithm: 'none', signature: null }),
      fixtureCloudflareProvenanceKey,
    ],
  ])('rejects %s for app-owned build provenance', (_label, mutate, key) => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeFixtureCloudflareProvenance(root);
    const provenancePath = path.join(
      root,
      'dist/server/start-ui-app-chunk-provenance.json'
    );
    const envelope = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    writeJson(
      root,
      'dist/server/start-ui-app-chunk-provenance.json',
      mutate(envelope)
    );

    expect(() =>
      verifyRuntimeProfileImplementation('cloudflare', root, {
        cloudflareAppChunkProvenanceKey: key,
        cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare app-owned provenance authentication');
  });

  it.each([
    [
      'modified JavaScript bytes',
      (root) =>
        fs.appendFileSync(
          path.join(root, 'dist/server/assets/tags-fixture.js'),
          '\nconst postSignTamper=true;'
        ),
      'must have trusted app-owned build provenance',
    ],
    [
      'an unrecorded JavaScript file',
      (root) => write(root, 'dist/server/assets/post-sign-extra.js', ''),
      'Cloudflare app-owned provenance coverage',
    ],
    [
      'a removed recorded JavaScript file',
      (root) =>
        fs.rmSync(path.join(root, 'dist/server/assets/tags-fixture.js')),
      'tags-fixture.js',
    ],
  ])('rejects %s after provenance signing', (_label, tamper, message) => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeFixtureCloudflareProvenance(root);
    tamper(root);

    expect(() =>
      verifyRuntimeProfileImplementation('cloudflare', root, {
        cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
        cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(message);
  });

  it('rejects a freshly signed JavaScript file missing from the Vite manifest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/unmanifested-signed.js', '');
    writeFixtureCloudflareProvenance(root, {
      registerDetachedJavaScript: false,
    });

    expect(() =>
      verifyRuntimeProfileImplementation('cloudflare', root, {
        cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
        cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('unmanifested assets/unmanifested-signed.js');
  });

  it('rejects duplicate Vite manifest aliases for one JavaScript output', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_client-duplicate-fixture.js'] = {
      ...manifest['_client-fixture.js'],
    };
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must map one record to each JavaScript output');
  });

  it.each([
    ['dangling', ['_missing-fixture.js']],
    ['duplicate', ['_client-fixture.js', '_client-fixture.js']],
  ])('rejects %s Vite manifest edges', (_label, imports) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_backend-fixture.js'].imports = imports;
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare app-owned manifest graph');
  });

  it('parses the exact JavaScript bytes authenticated by provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/client-fixture.js';
    const filePath = path.join(root, relativePath);
    const safeSource = fs.readFileSync(filePath, 'utf8');
    write(root, relativePath, `fetch("https://invalid.example");${safeSource}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/authenticated-client.ts',
    ]);
    writeFixtureCloudflareProvenance(root);
    const readFile = fs.readFileSync.bind(fs);
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((candidate, options) =>
        readFixtureSourceOverride(
          readFile,
          filePath,
          safeSource,
          candidate,
          options
        )
      );

    try {
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
          cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it('rejects a symlinked Cloudflare output root', () => {
    const root = fixture();
    const external = fixture();
    createCloudflareArtifact(external);
    write(
      root,
      'wrangler.json',
      fs.readFileSync(path.join(external, 'wrangler.json'), 'utf8')
    );
    fs.symlinkSync(path.join(external, 'dist'), path.join(root, 'dist'), 'dir');

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must be a regular artifact directory');
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
    ['mixed', ['src/runtime/cloudflare/reviewed-load-owner.ts', 'non-app:pkg']],
    ['non-app', undefined],
  ])('deep-scans an unreviewed %s static chunk', (_ownership, modules) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const trustedFile = 'client-fixture.js';
    const substitutedFile = 'client-unreviewed-fixture.js';
    const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
    write(
      root,
      `dist/server/assets/${substitutedFile}`,
      `(function(){fetch("https://invalid.example")})();${fs.readFileSync(
        trustedPath,
        'utf8'
      )}`
    );
    const ownerPath = 'dist/server/assets/database-request-fixture.js';
    const ownerFile = path.join(root, ownerPath);
    write(
      root,
      ownerPath,
      fs.readFileSync(ownerFile, 'utf8').replace(trustedFile, substitutedFile)
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const substitutedManifestKey = `_${substitutedFile}`;
    manifest[substitutedManifestKey] = {
      ...manifest['_client-fixture.js'],
      file: `assets/${substitutedFile}`,
    };
    const ownerImports =
      manifest['src/runtime/cloudflare/database-request.ts'].imports;
    ownerImports.splice(
      ownerImports.indexOf('_client-fixture.js'),
      1,
      substitutedManifestKey
    );
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markOptionalFixtureAppOwnedChunk(
      root,
      `assets/${substitutedFile}`,
      modules
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    'const run=(fetch)=>fetch();run(()=>undefined);',
    'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run(()=>undefined);',
    'const run=({unused,effect})=>effect();run({unused:()=>fetch("https://invalid.example"),effect:()=>undefined});',
    'const run=(...effects)=>effects[0]();run(()=>undefined,()=>fetch("https://invalid.example"));',
    'const runner={call(effect){return undefined}};runner.call(()=>fetch("https://invalid.example"));',
    'const run=effect=>effect();const args=[()=>undefined];run(...args);',
    'const run=(object,key)=>object[key]();run({safe:()=>undefined},"safe");',
    'const runner={call(effect){return undefined}};const key="call";runner[key](()=>fetch("https://invalid.example"));',
    'const dormant=(effect)=>{const alias=effect;alias()};const unused=()=>dormant(()=>fetch("https://invalid.example"));',
    'const runner={};Object.defineProperty(runner,"run",{value:()=>fetch("https://invalid.example")});',
    'function* dormant(){fetch("https://invalid.example")}dormant();',
    'const left=()=>undefined,right=()=>fetch("https://invalid.example");(left||right)();',
    'class Factory{run(){fetch("https://invalid.example")}}const target=new Factory();void target;',
    'function Factory(){this.run=()=>fetch("https://invalid.example")}const target=new Factory();void target;',
    'function Factory(){return{run:()=>undefined}}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-function-constructor.invalid.example");right.run();',
    'function Factory(){this.run=()=>undefined;return this}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-this-constructor.invalid.example");right.run();',
    'class Factory{constructor(){return{run:()=>undefined}}}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-class-constructor.invalid.example");right.run();',
    'const Factory=new Proxy(function(){},{construct(){return{run:()=>undefined}}}),left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-proxy-constructor.invalid.example");right.run();',
    'function Factory(){const value={run:()=>undefined};return value}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-local-object-constructor.invalid.example");right.run();',
    'function Factory(){let value={run:()=>undefined};value={run:()=>undefined};return value}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://reassigned-fresh-local-object.invalid.example");right.run();',
    'function Factory({value}){return value}const left=new Factory({value:{run:()=>undefined}}),right=new Factory({value:{run:()=>undefined}});left.run=()=>fetch("https://fresh-object-parameter.invalid.example");right.run();',
    'function Factory([value]){return value}const leftArgument=[{run:()=>undefined}],rightArgument=[{run:()=>undefined}],left=new Factory(leftArgument),right=new Factory(rightArgument);left.run=()=>fetch("https://fresh-array-aggregate-constructor.invalid.example");right.run();',
    'function Factory(){return arguments[0]}const left=new Factory({run:()=>undefined}),right=new Factory({run:()=>undefined});left.run=()=>fetch("https://fresh-arguments-constructor.invalid.example");right.run();',
    'const Factory=new Proxy(function(){},{construct(_target,args){return args[0]}}),left=new Factory({run:()=>undefined}),right=new Factory({run:()=>undefined});left.run=()=>fetch("https://fresh-proxy-arguments-constructor.invalid.example");right.run();',
    'function Factory(){function value(){}return value}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-local-function-constructor.invalid.example");right.run();',
    'class Factory{constructor(){const value={run:()=>undefined};return value}}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-class-local-constructor.invalid.example");right.run();',
    'const Factory=new Proxy(function(){},{construct(){const value={run:()=>undefined};return value}}),left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-proxy-local-constructor.invalid.example");right.run();',
    'function make(){return{run:()=>undefined}}function Factory(){return make()}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-factory-constructor.invalid.example");right.run();',
    'function Factory(){return{run:()=>undefined}}function make(){return new Factory()}const left=make(),right=make();left.run=()=>fetch("https://wrapped-fresh-constructor.invalid.example");right.run();',
  ])('does not activate a dormant or shadowed load effect (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/safe-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    'const run=({effect})=>effect();run({...{effect:()=>fetch("https://invalid.example")}});',
    'const run=([effect])=>effect();run([...[()=>fetch("https://invalid.example")]]);',
    'const runner={...{run:()=>fetch("https://invalid.example")}};runner.run();',
    'const run=({safe,...rest})=>rest.effect();run({...{safe:true,effect:()=>fetch("https://invalid.example")}});',
    'const left=()=>undefined,right=()=>fetch("https://invalid.example");(false?left:right)();',
    'const evil=()=>fetch("https://invalid.example"),get=()=>evil;get()();',
    'const get=value=>value;get(()=>fetch("https://invalid.example"))();',
    'const make=effect=>()=>effect();make(()=>fetch("https://invalid.example"))();',
    'const make=effect=>({run:effect});make(()=>fetch("https://invalid.example")).run();',
    'const make=effect=>[effect];make(()=>fetch("https://invalid.example"))[0]();',
    'const make=options=>()=>options.effect();make({effect:()=>fetch("https://invalid.example")})();',
    'const run=({effect})=>effect();run({effect:()=>undefined,...{effect:()=>fetch("https://invalid.example")}});',
    'const run=({effect})=>effect();run({effect:()=>undefined,effect:()=>fetch("https://invalid.example")});',
    'class Runner{constructor(effect){effect()}}new Runner(()=>fetch("https://invalid.example"));',
    'const Runner=class{constructor(effect){effect()}};new Runner(()=>fetch("https://invalid.example"));',
    'class Runner{constructor(){this.run()}run(){fetch("https://invalid.example")}}new Runner();',
    'class Base{constructor(){fetch("https://invalid.example")}}class Child extends Base{}new Child();',
    'class Base{constructor(){fetch("https://invalid.example")}}class Child extends Base{constructor(){super()}}new Child();',
    'class Runner{effect=fetch("https://invalid.example")}new Runner();',
    'const make=effect=>()=>effect();const evil=make(()=>fetch("https://invalid.example"));evil();',
    'const make=effect=>()=>()=>effect();make(()=>fetch("https://invalid.example"))()();',
    'const make=effect=>({run:effect}),evil=make(()=>fetch("https://invalid.example"));evil.run();',
    'const make=effect=>[effect],evil=make(()=>fetch("https://invalid.example"));evil[0]();',
    'const evil=()=>fetch("https://invalid.example");const{run}={run:evil};run();',
    'const evil=()=>fetch("https://invalid.example");const[run]=[evil];run();',
    'let run;run=()=>fetch("https://invalid.example");run();',
    'let run=()=>undefined;run=()=>fetch("https://invalid.example");run();',
    'let run;({run}={run:()=>fetch("https://invalid.example")});run();',
    'class Runner{static run(){fetch("https://invalid.example")}}Runner.run();',
    'class Runner{run(){fetch("https://invalid.example")}}new Runner().run();',
    'class Base{run(){fetch("https://invalid.example")}}class Child extends Base{constructor(){super();this.run()}}new Child();',
    'class Runner{effect=()=>fetch("https://invalid.example");constructor(){this.effect()}}new Runner();',
    'const deeper=y=>()=>y(),wrap=x=>()=>x();wrap(deeper(()=>fetch("https://invalid.example")))()();',
    'const deeper=y=>()=>y(),wrap=x=>()=>x(),outer=z=>()=>z();outer(wrap(deeper(()=>fetch("https://invalid.example"))))()()();',
    'const make=async()=>()=>fetch("https://invalid.example");(await make())();',
    'const make=async()=>({run:()=>fetch("https://invalid.example")});(await make()).run();',
    'const make=async()=>()=>fetch("https://invalid.example"),evil=await make();evil();',
    'function Factory(){return()=>fetch("https://invalid.example")}(new Factory())();',
    'class Factory{constructor(){return()=>fetch("https://invalid.example")}}new Factory()();',
    'function Factory(){return{run:()=>fetch("https://invalid.example")}}new Factory().run();',
    'class Evil{run(){fetch("https://invalid.example")}}function Factory(){return new Evil()}new Factory().run();',
    'function Factory(){return Object.create({run:()=>fetch("https://invalid.example")})}new Factory().run();',
    'function Factory(){this.run=()=>fetch("https://invalid.example")}new Factory().run();',
    'const tag=()=>()=>fetch("https://invalid.example");tag``();',
    'const tag=()=>({run:()=>fetch("https://invalid.example")});tag``.run();',
    'const tag=(strings,effect)=>()=>effect();tag`${()=>fetch("https://invalid.example")}`();',
    'let evil;(evil=()=>fetch("https://invalid.example"))();',
    'let value;(value={run:()=>fetch("https://invalid.example")}).run();',
    'let evil;evil??=()=>fetch("https://invalid.example");evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}const evil=make().next().value;evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}const iterator=make(),evil=iterator.next().value;evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}const{value}=make().next();value();',
    'const runner={get run(){return()=>fetch("https://invalid.example")}};runner.run();',
    'const runner={get task(){return{run:()=>fetch("https://invalid.example")}}};runner.task.run();',
    'const runner={get effect(){fetch("https://invalid.example");return 1}},effect=runner.effect;',
    'class Runner{static get run(){return()=>fetch("https://invalid.example")}}Runner.run();',
    'class Runner{get task(){return{run:()=>fetch("https://invalid.example")}}}new Runner().task.run();',
    'class Runner{get effect(){fetch("https://invalid.example");return 1}}const runner=new Runner(),effect=runner.effect;',
    'const runner={set effect(value){fetch("https://invalid.example")}};runner.effect=1;',
    'class Runner{set effect(value){fetch("https://invalid.example")}}new Runner().effect=1;',
    'const source={get effect(){fetch("https://invalid.example");return 1}};Object.assign({},source);',
    'const runner={set effect(value){fetch("https://invalid.example")}};Reflect.set(runner,"effect",1);',
    'function* make(){return()=>fetch("https://invalid.example")}make().next().value();',
    'function* make(){yield()=>undefined;return()=>fetch("https://invalid.example")}const iterator=make();iterator.next();iterator.next().value();',
    'function* inner(){return()=>fetch("https://invalid.example")}function* outer(){return yield* inner()}outer().next().value();',
    'function* make(){yield()=>fetch("https://invalid.example")}const[evil]=make();evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}for(const evil of make()){evil()}',
    `(()=>{}).constructor('return fetch("https://invalid.example")')();`,
    `({}).toString.constructor('return fetch("https://invalid.example")')();`,
    `(function*(){}).constructor('yield fetch("https://invalid.example")')().next();`,
    `Reflect.construct(Function,['return fetch("https://invalid.example")'])();`,
    'function Factory(){this.run=()=>fetch("https://invalid.example");return()=>this.run()}new Factory()();',
    'const runner={tag(){return()=>this.run()},run(){fetch("https://invalid.example")}};runner.tag``();',
    'function Factory(){return()=>fetch("https://invalid.example")}const run=Reflect.construct(Factory,[]);run();',
    'const Factory=new Proxy(function(){},{construct(){return()=>fetch("https://invalid.example")}});new Factory()();',
    'class Base{constructor(){return()=>fetch("https://invalid.example")}}class Child extends Base{}new Child()();',
    'class Base{constructor(){return()=>fetch("https://invalid.example")}}class Child extends Base{constructor(){super()}}new Child()();',
    'class Base{effect=fetch("https://invalid.example")}class Child extends Base{}new Child();',
    'class Dormant{[fetch("https://invalid.example")]=1}',
    'const source={get effect(){fetch("https://invalid.example");return 1}};const{effect}=source;',
    'const source={get effect(){fetch("https://invalid.example");return 1}},run=({effect})=>1;run(source);',
    'const factory=strategy=>arg=>strategy(arg),ignore=arg=>undefined,invoke=arg=>arg();factory(ignore)(()=>undefined);factory(invoke)(()=>fetch("https://invalid.example"));',
    'const factory=strategy=>arg=>strategy(arg),ignore=arg=>undefined,invoke=arg=>arg();factory(invoke)(()=>fetch("https://invalid.example"));factory(ignore)(()=>undefined);',
    'const target={run:()=>undefined},source=[...[{},{}]],box=[...source,target];box[2].run=()=>fetch("https://nested-spread-offset.invalid.example");target.run();',
    'const target={run:()=>undefined},source=[...[,,]],box=[...source,target];box[2].run=()=>fetch("https://nested-hole-offset.invalid.example");target.run();',
    'const target={run:()=>undefined},source=flag?[{}]:[{},{}],box=[...source,target];box[1].run=()=>fetch("https://variable-spread-offset.invalid.example");target.run();',
    'const target={run:()=>undefined},source=flag?[{},{}]:[{}],box=[...source,target];box[1].run=()=>fetch("https://reversed-spread-offset.invalid.example");target.run();',
    'function Factory(){return globalThis}const target=new Factory();target.fetch("https://function-constructor-return.invalid.example");',
    'const shared=globalThis;class Factory{constructor(){return shared}}const target=new Factory();target.fetch("https://class-constructor-return.invalid.example");',
    'const Factory=new Proxy(function(){},{construct(){return globalThis}});const target=new Factory();target.fetch("https://proxy-constructor-return.invalid.example");',
    'const shared={run:()=>undefined};function Factory(){return shared}const target=new Factory();target.run=()=>fetch("https://function-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory(){const value=shared;return value}const target=new Factory();target.run=()=>fetch("https://local-shared-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory(value){return value}const target=new Factory(shared);target.run=()=>fetch("https://parameter-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory({value}){return value}const target=new Factory({value:shared});target.run=()=>fetch("https://object-parameter-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory([value]){return value}const target=new Factory([shared]);target.run=()=>fetch("https://array-parameter-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},argument={value:shared};function Factory({value}){return value}const target=new Factory(argument);target.run=()=>fetch("https://object-aggregate-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},argument=[shared];function Factory([value]){return value}const target=new Factory(argument);target.run=()=>fetch("https://array-aggregate-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},container={argument:{value:shared}};function Factory({value}){return value}const target=new Factory(container.argument);target.run=()=>fetch("https://member-aggregate-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory({value}){return value}const target=new Factory({...{value:shared}});target.run=()=>fetch("https://spread-aggregate-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},key="value",argument={[key]:shared};function Factory({value}){return value}const target=new Factory(argument);target.run=()=>fetch("https://computed-aggregate-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},key="value",argument={[key]:shared},Factory=new Proxy(function(){},{construct(_target,[{value}]){return value}}),target=new Factory(argument);target.run=()=>fetch("https://proxy-computed-aggregate-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},argument=globalThis.flag?[shared]:[{run:()=>undefined}];function Factory([value]){return value}const target=new Factory(argument);target.run=()=>fetch("https://branched-array-aggregate-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory(){return arguments[0]}const target=new Factory(shared);target.run=()=>fetch("https://arguments-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory(value){return value}const target=new Factory(...[shared]);target.run=()=>fetch("https://spread-arguments-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Factory(value=shared){return value}const target=new Factory();target.run=()=>fetch("https://default-parameter-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};class Factory{constructor(){return shared}}const target=new Factory();target.run=()=>fetch("https://class-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},Factory=new Proxy(function(){},{construct(){return shared}});const target=new Factory();target.run=()=>fetch("https://proxy-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},Factory=new Proxy(function(){},{construct(_target,[value]){return value}}),target=new Factory(shared);target.run=()=>fetch("https://proxy-tuple-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},Factory=new Proxy(function(){},{construct(_target,args){return args[0]}}),target=new Factory(shared);target.run=()=>fetch("https://proxy-arguments-constructor-alias.invalid.example");shared.run();',
    'const Factory=new Proxy(function Target(){},{construct(target){return target}}),left=new Factory(),right=new Factory();left.run=()=>fetch("https://proxy-target-constructor-alias.invalid.example");right.run();',
    'const flag=true,shared={run:()=>undefined};function Factory(){return flag?shared:{}}const target=new Factory();target.run=()=>fetch("https://conditional-constructor-alias.invalid.example");shared.run();',
    'const flag=true,shared={run:()=>undefined};function Factory(){return flag&&shared}const target=new Factory();target.run=()=>fetch("https://logical-constructor-alias.invalid.example");shared.run();',
    'const flag=true,left={run:()=>undefined},right={run:()=>undefined};function Factory(){return flag?left:right}const target=new Factory();target.run=()=>fetch("https://branched-constructor-alias.invalid.example");left.run();',
    'let alias;const shared={run:()=>undefined};function Factory(){return alias=shared}const target=new Factory();target.run=()=>fetch("https://assigned-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Target(){return shared}const Factory=new Proxy(Target,{}),target=new Factory();target.run=()=>fetch("https://missing-proxy-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Target(){return shared}const Factory=new Proxy(Target,{construct:undefined}),target=new Factory();target.run=()=>fetch("https://undefined-proxy-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined};function Target(){return shared}const Factory=new Proxy(Target,{construct(target,args,newTarget){return Reflect.construct(target,args,newTarget)}}),instance=new Factory();instance.run=()=>fetch("https://transparent-proxy-constructor-alias.invalid.example");shared.run();',
  ])('rejects a statically reachable aliased load effect (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/aliased-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    [
      'an implicit derived plain-function constructor',
      'const shared={run:()=>undefined};function Base(){return shared}class Factory extends Base{}const target=new Factory();target.run=()=>fetch("https://derived-constructor.invalid.example");shared.run();',
    ],
    [
      'an explicit derived plain-function constructor argument',
      'const shared={run:()=>undefined};function Base(value){return value}class Factory extends Base{constructor(value){super(value)}}const target=new Factory(shared);target.run=()=>fetch("https://derived-argument.invalid.example");shared.run();',
    ],
    [
      'an explicit derived plain-function constructor remapping',
      'const shared={run:()=>undefined};function Base(value){return value}class Factory extends Base{constructor(){super(shared)}}const target=new Factory();target.run=()=>fetch("https://derived-remapping.invalid.example");shared.run();',
    ],
    [
      'an implicit derived Proxy constructor',
      'const shared={run:()=>undefined},Base=new Proxy(function(){},{construct(){return shared}});class Factory extends Base{}const target=new Factory();target.run=()=>fetch("https://derived-proxy.invalid.example");shared.run();',
    ],
    [
      'an explicit derived Proxy constructor remapping',
      'const shared={run:()=>undefined},Base=new Proxy(function(){},{construct(_target,args){return args[0]}});class Factory extends Base{constructor(){super(shared)}}const target=new Factory();target.run=()=>fetch("https://derived-proxy-remapping.invalid.example");shared.run();',
    ],
    [
      'an intermediate derived constructor remapping',
      'const shared={run:()=>undefined};function Base(value){return value}class Middle extends Base{constructor(){super(shared)}}class Factory extends Middle{}const target=new Factory();target.run=()=>fetch("https://intermediate-derived-remapping.invalid.example");shared.run();',
    ],
    [
      'multiple explicit super branches targeting the same class',
      'const shared={run:()=>undefined},fresh={run:()=>undefined},flag=1>2;class Base{constructor(value){return value}}class Factory extends Base{constructor(){if(flag){super(fresh)}else{super(shared)}}}const target=new Factory();target.run=()=>fetch("https://branched-derived-remapping.invalid.example");shared.run();',
    ],
    [
      'multiple intermediate super branches targeting the same class',
      'const shared={run:()=>undefined},fresh={run:()=>undefined},flag=1>2;class Base{constructor(value){return value}}class Middle extends Base{constructor(){if(flag){super(fresh)}else{super(shared)}}}class Factory extends Middle{}const target=new Factory();target.run=()=>fetch("https://branched-intermediate-remapping.invalid.example");shared.run();',
    ],
    [
      'a lexical-arrow super invocation',
      'const shared={run:()=>undefined};function Base(value){return value}class Factory extends Base{constructor(){const initialize=()=>super(shared);initialize()}}const target=new Factory();target.run=()=>fetch("https://lexical-arrow-super.invalid.example");shared.run();',
    ],
    [
      'nested transparent Proxy constructor delegation',
      'const shared={run:()=>undefined};function Direct(value){return value}const Inner=new Proxy(Direct,{}),Base=new Proxy(Inner,{});class Factory extends Base{constructor(){super(shared)}}const target=new Factory();target.run=()=>fetch("https://nested-proxy-constructor.invalid.example");shared.run();',
    ],
    [
      'a Proxy trap remapping through Reflect.construct',
      'const shared={run:()=>undefined};function Direct(value){return value}const Base=new Proxy(Direct,{construct(target,_args,newTarget){return Reflect.construct(target,[shared],newTarget)}});class Factory extends Base{}const target=new Factory();target.run=()=>fetch("https://reflect-proxy-constructor.invalid.example");shared.run();',
    ],
    [
      'a Proxy argument projection remapping through Reflect.construct',
      'const shared={run:()=>undefined},fresh={run:()=>undefined};function Direct(value){return value}const Base=new Proxy(Direct,{construct(target,args,newTarget){return Reflect.construct(target,[args[1]],newTarget)}});class Factory extends Base{}const target=new Factory(fresh,shared);target.run=()=>fetch("https://reflect-projected-proxy-constructor.invalid.example");shared.run();',
    ],
    [
      'an aliased Proxy argument remapping through Reflect.construct',
      'const shared={run:()=>undefined},fresh={run:()=>undefined};function Direct(value){return value}const Base=new Proxy(Direct,{construct(target,args,newTarget){const value=args[1];return Reflect.construct(target,[value],newTarget)}});class Factory extends Base{}const target=new Factory(fresh,shared);target.run=()=>fetch("https://reflect-aliased-proxy-constructor.invalid.example");shared.run();',
    ],
    [
      'implicit Proxy arguments remapping through Reflect.construct',
      'const shared={run:()=>undefined},fresh={run:()=>undefined};function Direct(value){return value}const Base=new Proxy(Direct,{construct(){return Reflect.construct(arguments[0],[arguments[1][1]],arguments[2])}});class Factory extends Base{}const target=new Factory(fresh,shared);target.run=()=>fetch("https://reflect-implicit-proxy-constructor.invalid.example");shared.run();',
    ],
    [
      'a mixed Proxy and plain-function constructor callee',
      'const shared={run:()=>undefined};function Direct(){return shared}const Proxied=new Proxy(function(){},{construct(){return{}}}),flag=1<2,Factory=flag?Proxied:Direct,target=new Factory();target.run=()=>fetch("https://mixed-constructor.invalid.example");shared.run();',
    ],
    [
      'a mixed plain-function and Proxy constructor callee',
      'const shared={run:()=>undefined};function Direct(){return{}}const Proxied=new Proxy(function(){},{construct(){return shared}}),flag=1<2,Factory=flag?Proxied:Direct,target=new Factory();target.run=()=>fetch("https://mixed-proxy-constructor.invalid.example");shared.run();',
    ],
    [
      'an unresolved derived constructor shared across instances',
      'class Factory extends ExternalBase{}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://opaque-derived.invalid.example");right.run();',
    ],
    [
      'a known or unresolved constructor shared across instances',
      'class Fresh{constructor(){return{run:()=>undefined}}}const flag=1<2,Factory=flag?Fresh:External,left=new Factory(),right=new Factory();left.run=()=>fetch("https://opaque-constructor-alternative.invalid.example");right.run();',
    ],
    [
      'a known or unresolved derived base shared across instances',
      'class KnownFresh{constructor(){return{run:()=>undefined}}}const flag=1<2,Base=flag?KnownFresh:External;class Factory extends Base{}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://opaque-base-alternative.invalid.example");right.run();',
    ],
    [
      'an unresolved Proxy construct trap shared across instances',
      'class Fresh{constructor(){return{run:()=>undefined}}}const Base=new Proxy(Fresh,{construct:ExternalTrap});class Factory extends Base{}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://opaque-proxy-trap.invalid.example");right.run();',
    ],
  ])('retains constructor provenance through %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      expect.stringContaining('fetch('),
    ]);
  });

  it('fails closed without overflowing cyclic Proxy constructor analysis', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const shared={run:()=>undefined};let Factory;Factory=new Proxy(Factory,{});const left=new Factory(),right=new Factory();left.run=()=>fetch("https://cyclic-proxy-constructor.invalid.example");right.run();'
      )
    ).toContainEqual(expect.stringContaining('fetch('));
  });

  it.each([
    [
      'a self-returning function constructor',
      'function Factory(){return new Factory()}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://self-returning-function-constructor.invalid.example");right.run();',
    ],
    [
      'a self-returning class constructor',
      'class Factory{constructor(){return new Factory()}}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://self-returning-class-constructor.invalid.example");right.run();',
    ],
    [
      'mutually recursive constructors',
      'function Left(){return new Right()}function Right(){return new Left()}const left=new Left(),right=new Left();left.run=()=>fetch("https://mutual-constructor-cycle.invalid.example");right.run();',
    ],
  ])('fails closed without overflowing %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContainEqual(
      expect.stringContaining('fetch(')
    );
  });

  it.each([
    [
      'transparent proxies over one shared target',
      'const shared={run:()=>undefined};const left=new Proxy(shared,{}),right=new Proxy(shared,{});left.run=()=>fetch("https://proxy-shared-target.invalid.example");right.run();',
    ],
    [
      'nested transparent proxies over one shared target',
      'const shared={run:()=>undefined};const left=new Proxy(new Proxy(shared,{}),{}),right=new Proxy(new Proxy(shared,{}),{});left.run=()=>fetch("https://nested-proxy-shared-target.invalid.example");right.run();',
    ],
  ])('tracks receiver aliases through %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContainEqual(
      expect.stringContaining('fetch(')
    );
  });

  it.each([
    ['Object.assign', 'Object.assign(cl._zod,{parent:inst})', ''],
    [
      'Object.defineProperty',
      'Object.defineProperty(cl._zod,"parent",{value:inst})',
      '',
    ],
    [
      'an invoked helper',
      'assignParent(cl._zod,inst)',
      'function assignParent(target,value){target.parent=value}',
    ],
  ])(
    'tracks constructor-returned factory aliases installed through %s',
    (_label, mutation, helper) => {
      const source = `${helper}function C(value){value._zod={};return value}function clone(inst){const target={run:()=>undefined};const cl=new C(target);${mutation};return cl}const shared={run:()=>undefined},copy=clone(shared);shared.run=()=>fetch("https://normalized-factory-mutation.invalid.example");copy._zod.parent.run();`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toContainEqual(
        expect.stringContaining('fetch(')
      );
    }
  );

  it.each([
    [
      'a local Object.assign source factory',
      'function update(value){return{parent:value}}',
      'Object.assign(cl._zod,update(inst))',
    ],
    [
      'a transitive mutation helper',
      'function inner(target,value){target.parent=value}function outer(target,value){inner(target,value)}',
      'outer(cl._zod,inst)',
    ],
  ])(
    'tracks constructor-returned factory aliases through %s',
    (_label, helper, mutation) => {
      const source = `${helper}function C(value){value._zod={};return value}function clone(inst){const target={run:()=>undefined};const cl=new C(target);${mutation};return cl}const shared={run:()=>undefined},copy=clone(shared);shared.run=()=>fetch("https://transitive-normalized-factory-mutation.invalid.example");copy._zod.parent.run();`;

      expect(inspectCloudflareLoadEffectsForTesting(source)).toContainEqual(
        expect.stringContaining('fetch(')
      );
    }
  );

  it.each([
    [
      'a plain-function base returning fresh objects',
      'function Base(){return{run:()=>undefined}}class Factory extends Base{}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-derived.invalid.example");right.run();',
    ],
    [
      'a Proxy base returning fresh objects',
      'const Base=new Proxy(function(){},{construct(){return{run:()=>undefined}}});class Factory extends Base{}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-derived-proxy.invalid.example");right.run();',
    ],
    [
      'mixed constructors returning fresh objects',
      'function Direct(){return{run:()=>undefined}}const Proxied=new Proxy(function(){},{construct(){return{run:()=>undefined}}}),flag=1<2,Factory=flag?Proxied:Direct,left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-mixed.invalid.example");right.run();',
    ],
    [
      'an explicit super mapping that excludes a shared decoy',
      'const shared={run:()=>undefined},fresh={run:()=>undefined};function Base(value){return value}class Factory extends Base{constructor(){super(fresh)}}const target=new Factory();target.run=()=>fetch("https://fresh-explicit-mapping.invalid.example");shared.run();',
    ],
    [
      'an unreachable explicit super mapping that excludes a shared decoy',
      'const shared={run:()=>undefined},fresh={run:()=>undefined};class Base{constructor(value){return value}}class Factory extends Base{constructor(){if(true){super(fresh)}else{super(shared)}}}const target=new Factory();target.run=()=>fetch("https://fresh-unreachable-explicit-mapping.invalid.example");shared.run();',
    ],
    [
      'nested Proxy alternatives returning fresh objects',
      'const flag=1<2;function Base(){return{run:()=>undefined}}const Inner=new Proxy(Base,{}),Outer=new Proxy(Inner,{}),Factory=flag?Outer:Inner,left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-nested-proxy-alternative.invalid.example");right.run();',
    ],
    [
      'an unreachable self-returning function constructor branch',
      'function Factory(){if(false)return new Factory();return{run:()=>undefined}}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-unreachable-function-cycle.invalid.example");right.run();',
    ],
    [
      'an unreachable self-returning class constructor branch',
      'class Factory{constructor(){if(false)return new Factory();return{run:()=>undefined}}}const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-unreachable-class-cycle.invalid.example");right.run();',
    ],
    [
      'an unreachable self-returning Proxy constructor branch',
      'let Factory;function Direct(){return{run:()=>undefined}}Factory=new Proxy(Direct,{construct(){if(false)return new Factory();return{run:()=>undefined}}});const left=new Factory(),right=new Factory();left.run=()=>fetch("https://fresh-unreachable-proxy-cycle.invalid.example");right.run();',
    ],
  ])(
    'keeps distinct construction results isolated for %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it('fails closed after a loop-carried aggregate spread mutation', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://loop-carried-spread.invalid.example");source.push({});void value}target.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed after a do-while test mutates a prior aggregate spread', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source=[{}];let index=0;do{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://do-while-spread.invalid.example")}while((source.push({}),index++<1));target.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed when an increment setter mutates a later spread source', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source=[{}],obj={get x(){return 0},set x(_value){source.push({})}};obj.x++;const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://increment-setter-spread.invalid.example");target.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed for loop-carried spread mutation across a called helper', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://loop-helper-spread.invalid.example")}for(const value of [0,1]){build();source.push({});void value}target.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed for loop-carried spread mutation in an array callback', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source=[{}];[0,1].forEach((value)=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://array-callback-spread.invalid.example");source.push({});void value});target.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    [
      'an identifier alias',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://alias-loop.invalid.example")}const wrapper=build;for(const value of [0,1]){wrapper();source.push({});void value}target.run();',
    ],
    [
      'a bound alias',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://bound-loop.invalid.example")}const wrapper=build.bind(null);for(const value of [0,1]){wrapper();source.push({});void value}target.run();',
    ],
    [
      'an object member',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://member-loop.invalid.example")}const api={build};for(const value of [0,1]){api.build();source.push({});void value}target.run();',
    ],
    [
      'a transitive array callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://transitive-callback-loop.invalid.example")}function wrapper(){build()}[0,1].forEach(()=>{wrapper();source.push({})});target.run();',
    ],
    [
      'a helper called from an array callback',
      'const target={run:()=>undefined},source=[{}];function helper(){source.push({})}function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://callback-helper-loop.invalid.example");helper()}[0,1].forEach(build);target.run();',
    ],
    [
      'an Object.assign-installed callback helper',
      'const target={run:()=>undefined},source=[{}];function helper(){source.push({})}const api={};Object.assign(api,{go:helper});function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://assign-helper-loop.invalid.example");api.go()}[0,1].forEach(build);target.run();',
    ],
    [
      'an Object.defineProperty-installed callback helper',
      'const target={run:()=>undefined},source=[{}];function helper(){source.push({})}const api={};Object.defineProperty(api,"go",{value:helper});function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://define-helper-loop.invalid.example");api.go()}[0,1].forEach(build);target.run();',
    ],
    [
      'a getter-projected callback helper',
      'const target={run:()=>undefined},source=[{}];function helper(){source.push({})}const api={get go(){return helper}};function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://getter-helper-loop.invalid.example");api.go()}[0,1].forEach(build);target.run();',
    ],
    [
      'a factory-returned callback helper alias',
      'const target={run:()=>undefined},source=[{}];function make(){return function helper(){source.push({})}}function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://factory-helper-loop.invalid.example");const helper=make();helper()}[0,1].forEach(build);target.run();',
    ],
    [
      'a callback parameter specialization',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://parameter-callback-loop.invalid.example")}function each(fn){[0,1].forEach(()=>{fn();source.push({})})}each(build);target.run();',
    ],
  ])(
    'fails closed for loop-carried spread mutation through %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires statically analyzable aggregate spreads'
      );
    }
  );

  it.each([
    [
      'a direct callback parameter',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://direct-parameter-callback.invalid.example");source.push({})}function each(fn){[0,1].forEach(fn)}each(build);target.run();',
    ],
    [
      'a returned closure',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://returned-closure.invalid.example")}function wrap(fn){return()=>fn()}const wrapper=wrap(build);for(const value of [0,1]){wrapper();source.push({});void value}target.run();',
    ],
    [
      'a factory-returned array callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://factory-returned-callback.invalid.example");source.push({})}function wrap(fn){return()=>fn()}const wrapper=wrap(build);[0,1].forEach(wrapper);target.run();',
    ],
    [
      'an object-member factory-returned array callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://member-factory-returned-callback.invalid.example");source.push({})}const api={wrap(fn){return()=>fn()}};const wrapper=api.wrap(build);[0,1].forEach(wrapper);target.run();',
    ],
    [
      'an assigned object-member factory callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://assigned-member-factory.invalid.example");source.push({})}const api={};api.wrap=function(fn){return()=>fn()};const wrapper=api.wrap(build);[0,1].forEach(wrapper);target.run();',
    ],
    [
      'an assigned prototype-member factory callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://prototype-member-factory.invalid.example");source.push({})}function API(){}API.prototype.wrap=function(fn){return()=>fn()};const api=new API(),wrapper=api.wrap(build);[0,1].forEach(wrapper);target.run();',
    ],
    [
      'a conditional member-factory callback alias',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://conditional-member-factory.invalid.example");source.push({})}const api={wrap(fn){return()=>fn()}},wrapper=true?api.wrap(build):()=>undefined;[0,1].forEach(wrapper);target.run();',
    ],
    [
      'an object-contained member-factory callback alias',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://contained-member-factory.invalid.example");source.push({})}const api={wrap(fn){return()=>fn()}},callbacks={wrapper:api.wrap(build)},wrapper=callbacks.wrapper;[0,1].forEach(wrapper);target.run();',
    ],
    [
      'a projected member-factory callback result',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://projected-member-factory.invalid.example");source.push({})}const api={wrap(fn){return{run:()=>fn()}}},wrapper=api.wrap(build).run;[0,1].forEach(wrapper);target.run();',
    ],
    [
      'an object-destructured alias',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://object-destructured.invalid.example")}const {build:wrapper}={build};for(const value of [0,1]){wrapper();source.push({});void value}target.run();',
    ],
    [
      'an array-destructured alias',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://array-destructured.invalid.example")}const [wrapper]=[build];for(const value of [0,1]){wrapper();source.push({});void value}target.run();',
    ],
    [
      'Array.prototype.forEach.call',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://foreach-call.invalid.example");source.push({})}Array.prototype.forEach.call([0,1],build);target.run();',
    ],
    [
      'an extracted forEach.call',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://extracted-foreach-call.invalid.example");source.push({})}const each=Array.prototype.forEach;each.call([0,1],build);target.run();',
    ],
    [
      'a bound forEach callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://bound-foreach.invalid.example");source.push({})}[0,1].forEach.bind([0,1],build)();target.run();',
    ],
    [
      'an assigned bound forEach callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://assigned-bound-foreach.invalid.example");source.push({})}const run=Array.prototype.forEach.bind([0,1],build);run();target.run();',
    ],
    [
      'an assigned extracted bound forEach callback',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://assigned-extracted-bound-foreach.invalid.example");source.push({})}const each=Array.prototype.forEach,run=each.bind([0,1],build);run();target.run();',
    ],
    [
      'Array.prototype.reduce',
      'const target={run:()=>undefined},source=[{}];function build(acc){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://reduce.invalid.example");source.push({});return acc}[0,1].reduce(build,0);target.run();',
    ],
    [
      'Array.prototype.reduceRight',
      'const target={run:()=>undefined},source=[{}];function build(acc){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://reduce-right.invalid.example");source.push({});return acc}[0,1].reduceRight(build,0);target.run();',
    ],
    [
      'Array.prototype.sort',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://sort.invalid.example");source.push({});return 0}[3,2,1].sort(build);target.run();',
    ],
    [
      'Array.from mapping',
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://array-from.invalid.example");source.push({});return 0}Array.from([0,1],build);target.run();',
    ],
  ])('fails closed through %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable aggregate spreads'
    );
  });

  it.each(['[0]', '[]'])(
    'does not use literal callback cardinality after forEach is replaced (%s)',
    (receiver) => {
      expect(() =>
        inspectCloudflareLoadEffectsForTesting(
          `const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://overridden-foreach.invalid.example");source.push({})}Array.prototype.forEach=function(fn){fn();fn()};${receiver}.forEach(build);target.run();`
        )
      ).toThrow('requires statically analyzable aggregate spreads');
    }
  );

  it.each([
    [
      'a sparse for-of source',
      'const target={run:()=>undefined},source=[{}];for(const value of [,,]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://sparse-loop.invalid.example");source.push({});void value}target.run();',
    ],
    [
      'a mutated for-of source',
      'const target={run:()=>undefined},source=[{}],values=[0];values.push(1);for(const value of values){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://mutated-loop.invalid.example");source.push({});void value}target.run();',
    ],
    [
      'a mutated array-callback receiver',
      'const target={run:()=>undefined},source=[{}],values=[0];values.push(1);values.forEach(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://mutated-callback.invalid.example");source.push({})});target.run();',
    ],
    [
      'a forEach callback return',
      'const target={run:()=>undefined},source=[{}];[0,1].forEach(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://foreach-return.invalid.example");source.push({});return});target.run();',
    ],
    [
      'a some callback return',
      'const target={run:()=>undefined},source=[{}];[0,1].some(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://some-return.invalid.example");source.push({});return false});target.run();',
    ],
    [
      'a partial some callback return',
      'const target={run:()=>undefined},source=[{}];[0,1].some((value)=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://partial-some-return.invalid.example");source.push({});if(value)return true});target.run();',
    ],
    [
      'a partial find callback return',
      'const target={run:()=>undefined},source=[{}];[0,1].find((value)=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://partial-find-return.invalid.example");source.push({});if(value)return true});target.run();',
    ],
    [
      'an every callback return',
      'const target={run:()=>undefined},source=[{}];[0,1].every(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://every-return.invalid.example");source.push({});return true});target.run();',
    ],
    [
      'a find callback return',
      'const target={run:()=>undefined},source=[{}];[0,1].find(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://find-return.invalid.example");source.push({});return false});target.run();',
    ],
    [
      'a continue path before a later break',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://continue-loop.invalid.example");source.push({});if(true)continue;break;void value}target.run();',
    ],
  ])(
    'fails closed for a repeating spread mutation through %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires statically analyzable aggregate spreads'
      );
    }
  );

  it.each([
    [
      'a switch continue to the outer loop',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://switch-continue.invalid.example");source.push({});switch(0){case 0:continue outer}break;void value}target.run();',
    ],
    [
      'a nested-loop continue to the outer loop',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://nested-continue.invalid.example");source.push({});for(const inner of [0]){void inner;continue outer}break;void value}target.run();',
    ],
    [
      'a try/finally continue path',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://finally-continue.invalid.example");source.push({});try{continue}finally{}break;void value}target.run();',
    ],
    [
      'a pending continue through a mutating finalizer',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){try{continue}finally{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://pending-finally-continue.invalid.example");source.push({})}break;void value}target.run();',
    ],
    [
      'an unreachable outer break after an inner break',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://unreachable-outer-break.invalid.example");source.push({});for(const inner of [0]){break;break outer;void inner}void value}target.run();',
    ],
    [
      'a switch fallthrough after a labeled-block break',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://switch-labeled-break.invalid.example");source.push({});switch(0){case 0:label:break;case 1:break outer}void value}target.run();',
    ],
  ])('fails closed through %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable aggregate spreads'
    );
  });

  it('keeps reviewed policy from bypassing repeated callback analysis', () => {
    const source =
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://reviewed-callback.invalid.example");source.push({})}[0,1].forEach(build);target.run();';

    expect(() =>
      inspectCloudflareReviewedLoadEffectsForTesting(source, {})
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('keeps a dormant member-factory callback isolated from an active sibling', () => {
    const source =
      'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://dormant-member-factory.invalid.example");source.push({})}const api={wrap(fn){return()=>fn()}},dormant=api.wrap(build),active=api.wrap(()=>undefined);void dormant;[0,1].forEach(active);target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'an if test',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://if-test-back-edge.invalid.example");if((source.push({}),true))continue;break;void value}target.run();',
    ],
    [
      'a switch discriminant',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://switch-discriminant-back-edge.invalid.example");switch((source.push({}),0)){case 0:continue;default:break}break;void value}target.run();',
    ],
    [
      'a switch case test',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://switch-case-test-back-edge.invalid.example");switch(0){case(source.push({}),0):continue;default:break}break;void value}target.run();',
    ],
  ])(
    'fails closed when a mutation in %s reaches the loop back edge',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires statically analyzable aggregate spreads'
      );
    }
  );

  it.each([
    [
      'a statically false loop',
      'const target={run:()=>undefined},source=[{}];while(false){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://false-loop.invalid.example");source.push({})}target.run();',
    ],
    [
      'an unreachable mutation after break',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://post-break-loop.invalid.example");break;source.push({});void value}target.run();',
    ],
    [
      'a mutation before an unconditional break',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://single-iteration-loop.invalid.example");source.push({});break;void value}target.run();',
    ],
    [
      'a pending break through a normally completing finalizer',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){try{break}finally{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://pending-finally-break.invalid.example");source.push({})}void value}target.run();',
    ],
    [
      'a zero-entry nested outward continue',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://zero-entry-inner.invalid.example");source.push({});for(const inner of []){continue outer;void inner}break;void value}target.run();',
    ],
    [
      'a caught throw followed by an outer break',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://caught-throw-break.invalid.example");source.push({});try{throw 0}catch{break outer}void value}target.run();',
    ],
    [
      'a sequence discriminant selecting a breaking default',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://sequence-switch-break.invalid.example");switch((source.push({}),1)){case 0:continue;default:break}break;void value}target.run();',
    ],
  ])('keeps a non-repeating spread mutation safe for %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'sparse forEach',
      'const target={run:()=>undefined},source=[{}];[,,].forEach(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://sparse-foreach.invalid.example");source.push({})});target.run();',
    ],
    [
      'sparse map',
      'const target={run:()=>undefined},source=[{}];[,,].map(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://sparse-map.invalid.example");source.push({})});target.run();',
    ],
    [
      'sparse filter',
      'const target={run:()=>undefined},source=[{}];[,,].filter(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://sparse-filter.invalid.example");source.push({});return true});target.run();',
    ],
    [
      'some that stops immediately',
      'const target={run:()=>undefined},source=[{}];[0,1].some(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-some.invalid.example");source.push({});return true});target.run();',
    ],
    [
      'every that stops immediately',
      'const target={run:()=>undefined},source=[{}];[0,1].every(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-every.invalid.example");source.push({});return false});target.run();',
    ],
    [
      'find that stops immediately',
      'const target={run:()=>undefined},source=[{}];[0,1].find(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-find.invalid.example");source.push({});return true});target.run();',
    ],
    [
      'findIndex that stops immediately',
      'const target={run:()=>undefined},source=[{}];[0,1].findIndex(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-find-index.invalid.example");source.push({});return true});target.run();',
    ],
    [
      'findLast that stops immediately',
      'const target={run:()=>undefined},source=[{}];[0,1].findLast(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-find-last.invalid.example");source.push({});return true});target.run();',
    ],
    [
      'findLastIndex that stops immediately',
      'const target={run:()=>undefined},source=[{}];[0,1].findLastIndex(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-find-last-index.invalid.example");source.push({});return true});target.run();',
    ],
    [
      'some that stops through try/finally',
      'const target={run:()=>undefined},source=[{}];[0,1].some(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-some-finally.invalid.example");source.push({});try{return true}finally{return true}});target.run();',
    ],
    [
      'some that stops through an exhaustive switch',
      'const target={run:()=>undefined},source=[{}];[0,1].some(()=>{const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://stopping-some-switch.invalid.example");source.push({});switch(0){default:return true}});target.run();',
    ],
  ])(
    'keeps a statically non-repeating callback safe for %s',
    (_label, source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it.each([
    [
      'a switch break to the outer loop',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://switch-break.invalid.example");source.push({});switch(0){case 0:break outer}void value}target.run();',
    ],
    [
      'a nested-loop break to the outer loop',
      'const target={run:()=>undefined},source=[{}];outer:for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://nested-break.invalid.example");source.push({});for(const inner of [0]){void inner;break outer}void value}target.run();',
    ],
    [
      'a finally block that breaks the loop',
      'const target={run:()=>undefined},source=[{}];for(const value of [0,1]){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://finally-break.invalid.example");try{source.push({})}finally{break}void value}target.run();',
    ],
  ])('keeps one-iteration structured control safe for %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'function run(){label:{break label;}fetch("https://reachable-after-label.invalid.example")}run();',
    'function run(){label:{if(true)break label;}fetch("https://reachable-after-conditional-label.invalid.example")}run();',
  ])('keeps execution after a labeled break reachable (%s)', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContainEqual(
      expect.stringContaining('fetch(')
    );
  });

  it('ignores a projected spread invocation after an unconditional break', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source=[{}];function build(){const box=[...source,target];if(box[2])box[2].run=()=>fetch("https://unreachable-helper.invalid.example")}for(const value of [0,1]){source.push({});break;build();void value}target.run();'
      )
    ).toEqual([]);
  });

  it('invalidates spread stability when accessor resolution changes', () => {
    expect(
      inspectCloudflareSpreadStabilityCacheForTesting(
        'const source=[{}],obj={get x(){return 0},set x(value){source.push(value)}};void obj.x;const box=[...source];void box;'
      )
    ).toEqual({
      after: false,
      before: true,
      cacheKeyChanged: true,
      cachePreservedDuringTransient: true,
      duringMutationProgramBuild: true,
      transientCacheability: [false, false, false],
      transientRecomputed: true,
    });
  });

  it('fails closed when an unresolved array spread precedes a receiver alias', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source=getValues(),box=[...source,target];box[0].run=()=>fetch("https://opaque-spread-offset.invalid.example");target.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed for a constructor-return array pattern over a custom iterable', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const shared={run:()=>undefined},argument={[Symbol.iterator]:function*(){yield shared}};function Factory([value]){return value}const target=new Factory(argument);target.run=()=>fetch("https://iterable-constructor-alias.invalid.example");shared.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    'const shared={run:()=>undefined},argument={get value(){return shared}};function Factory({value}){return value}const target=new Factory(argument);target.run=()=>fetch("https://accessor-constructor-alias.invalid.example");shared.run();',
    'const shared={run:()=>undefined},argument={get value(){return shared}},Factory=new Proxy(function(){},{construct(_target,[{value}]){return value}}),target=new Factory(argument);target.run=()=>fetch("https://proxy-accessor-constructor-alias.invalid.example");shared.run();',
  ])(
    'fails closed for a constructor-return accessor projection (%s)',
    (source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'accessor properties in aggregate spreads'
      );
    }
  );

  it.each([
    'source.push({});',
    'source[1]=target;',
    'source[Symbol.iterator]=function*(){yield target};',
    'function mutate(){source.push({})}mutate();',
    'function mutate(){source[1]=target}mutate();',
    '(()=>source.push({}))();',
    'function identity(){return source}identity().push({});',
    'function mutate(){source.push({})}mutate.call(null);',
    'function mutate(){source.push({})}mutate.apply(null,[]);',
    'function mutate(){source.push({})}(flag?mutate:()=>{})();',
    'function mutate(){source.push({})}Reflect.apply(mutate,null,[]);',
    'function mutate(){source.push({})}mutate.bind(null)();',
    'function mutate(){source.push({})}[mutate][0]();',
    'function mutate(){source.push({})}(flag&&mutate)();',
    'function mutate(){source.push({})}(maybe??mutate)();',
    'Array.prototype.slice=()=>{source.push({});return []};source.slice();',
  ])('fails closed after an array spread source mutation (%s)', (mutation) => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        `const target={run:()=>undefined},source=[{}];${mutation}const box=[...source,target];box[2].run=()=>fetch("https://mutated-spread.invalid.example");target.run();`
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    'const [first,source]=[[{}],[{}]];',
    'const {first,source}={first:[{}],source:[{}]};',
  ])(
    'keeps sibling destructured spread-binding caches distinct (%s)',
    (declaration) => {
      expect(() =>
        inspectCloudflareLoadEffectsForTesting(
          `const target={run:()=>undefined};${declaration}function mutate(){Reflect.apply(Array.prototype.push,source,[{}])}mutate();const decoy=[...first],box=[...source,target];void decoy;box[2].run=()=>fetch("https://sibling-spread-cache.invalid.example");target.run();`
        )
      ).toThrow('requires statically analyzable aggregate spreads');
    }
  );

  it('fails closed after an object spread source mutation', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>undefined},source={safe:{}},alias=source;alias.key=target;const box={...source};box.key.run=()=>fetch("https://mutated-object-spread.invalid.example");target.run();'
      )
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    'class Mutator{constructor(){source.push({})}}new Mutator();',
    'class Mutator{get run(){source.push({});return 1}}const mutator=new Mutator();void mutator.run;',
    'class Mutator{set run(value){source.push(value)}}const mutator=new Mutator();mutator.run={};',
  ])(
    'fails closed after an executed owner mutates an array spread source (%s)',
    (mutation) => {
      expect(() =>
        inspectCloudflareLoadEffectsForTesting(
          `const target={run:()=>undefined},source=[{}];${mutation}const box=[...source,target];box[2].run=()=>fetch("https://executed-owner-spread.invalid.example");target.run();`
        )
      ).toThrow('requires statically analyzable aggregate spreads');
    }
  );

  it.each([
    'const source=[{}],length=source.length,box=[...source];void length;void box;',
    'const source={a:1},a=source.a,box={...source};void a;void box;',
    'const source=[{}],frozen=Object.freeze(source),box=[...source];void frozen;void box;',
  ])(
    'allows a read-only operation before an aggregate spread (%s)',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it('fails closed when variable-length receiver offsets exceed their bound', () => {
    const spreads = Array.from({ length: 513 }, () => '...source').join(',');
    const source = `const target={run:()=>undefined},source=flag?[]:[{}],box=[${spreads},target];box[64].run=()=>fetch("https://bounded-spread-offset.invalid.example");target.run();`;

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'Cloudflare load-effect analysis exceeded bounded candidate work'
    );
  });

  it('bounds ordinary receiver children after variable spread extents', () => {
    const choices = Array.from(
      { length: 9 },
      (_, index) => `s${index}=flag?[]:[${','.repeat(2 ** index)}]`
    ).join(',');
    const spreads = Array.from({ length: 9 }, (_, index) => `...s${index}`);
    const ordinary = Array.from({ length: 129 }, () => '{}');
    const source = `const target={run:()=>undefined},${choices},box=[${[...spreads, ...ordinary, 'target'].join(',')}];box[0].run=()=>fetch("https://bounded-children.invalid.example");target.run();`;

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'Cloudflare load-effect analysis exceeded bounded candidate work'
    );
  });

  it('keeps safe aggregate spread siblings dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const run=({effect})=>effect();const dormant=()=>fetch("https://invalid.example");run({...{dormant},...{effect:()=>undefined}});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/safe-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('bounds shared-DAG wildcard projection work', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const aggregateOwners = [
      'const leaf=()=>undefined;',
      'const a0=[leaf,leaf,leaf,leaf];',
      ...Array.from(
        { length: 9 },
        (_, index) =>
          `const a${index + 1}=[a${index},a${index},a${index},a${index}];`
      ),
    ].join('');
    const wildcardPath = Array.from(
      { length: 10 },
      (_, index) => `const k${index}=getKey();`
    ).join('');
    const memberPath = Array.from(
      { length: 10 },
      (_, index) => `[k${index}]`
    ).join('');
    const prefix = `${aggregateOwners}${wildcardPath}const run=value=>value${memberPath}();run(a9);`;
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/bounded-wildcard-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('exceeded bounded candidate work');
  });

  it('keeps an unconstructed instance field dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'class Runner{effect=fetch("https://invalid.example")}const dormant=Runner;';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/dormant-class-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    'const run=({effect})=>effect();run({effect:()=>fetch("https://invalid.example"),...{effect:()=>undefined}});',
    'const run=({effect})=>effect();run({effect:()=>fetch("https://invalid.example"),effect:()=>undefined});',
  ])('uses the final object property value (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/final-property-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects a getter executed by object spread', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const source={get effect(){fetch("https://invalid.example");return 1}},target={...source};';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/getter-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('rejects accessor properties in aggregate spreads');
  });

  it('keeps an opaque object spread in an uncalled function dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const prepare=fields=>({...fields.telemetryExtras,ready:true});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/dormant-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('allows a discarded Proxy whose traps cannot be observed', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'new Proxy({}, {get(){fetch("https://invalid.example");return 1}});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/discarded-proxy-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps function values copied by native Object.assign dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const target=Object.assign({}, {effect:()=>fetch("https://invalid.example")});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/native-object-assign-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('does not grant native Object.assign semantics to a shadowed binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const Object={assign:(target,source)=>source.effect()};Object.assign({}, {effect:()=>fetch("https://invalid.example")});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/shadowed-object-assign-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a directly observed Proxy get trap', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const source=new Proxy({}, {get(){fetch("https://invalid.example");return 1}}),effect=source.effect;';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/observed-proxy-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    'const source=new Proxy({x:1},{get(target,key){fetch("https://invalid.example");return target[key]}}),target={...source};',
    'const source={};Object.defineProperty(source,"effect",{enumerable:true,get(){fetch("https://invalid.example");return 1}});const target={...source};',
    'const source=getOptions(),target={...source};',
  ])(
    'fails closed for a dynamically accessor-backed object spread (%s)',
    (prefix) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const clientFile = 'dist/server/assets/client-fixture.js';
      const clientPath = path.join(root, clientFile);
      write(
        root,
        clientFile,
        `${prefix}${fs.readFileSync(clientPath, 'utf8')}`
      );
      markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
        'src/platform/dynamic-spread-client.ts',
      ]);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        /(?:requires statically analyzable aggregate spreads|must not execute fetch, eval, or worker effects while loading)/u
      );
    }
  );

  it('rejects an opaque aggregate spread', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const source=getOptions(),run=({effect})=>effect();run({...source});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/opaque-aggregate-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    'const run=value=>{value.effect();run(value.next)};run({effect:()=>undefined,next:{}});',
    'const first=value=>{value.effect();second(value.next)},second=value=>first(value.next);first({effect:()=>undefined,next:{}});',
  ])('bounds recursive parameter projection analysis (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/recursive-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('exceeded bounded parameter projection depth');
  });

  it('detects a load effect through a recursive factory cycle', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const choose=()=>globalThis.FLAG?choose():fetch;choose()("https://invalid.example");';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/recursive-factory-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch');
  });

  it('terminates a recursive factory cycle without a load effect', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const callNext=value=>value.done?value:callNext(value);callNext({done:true});'
      )
    ).toEqual([]);
  });

  it('bounds branching recursive parameter projections by count', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const run=value=>{value.effect();run(value.a);run(value.b)};run({effect:()=>undefined,a:{},b:{}});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/branching-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('exceeded bounded parameter projection count');
  });

  it('rejects an opaque spread passed to an invoked local function', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(
      root,
      clientFile,
      `const run=effect=>effect();const args=getArguments();run(...args);${fs.readFileSync(clientPath, 'utf8')}`
    );
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/opaque-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable spread arguments');
  });

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

  it('rejects unrelated top-level functions even with local catch bindings', () => {
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

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must contain only its bounded Cloudflare module ownership sequence'
    );
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
    ).toThrow(
      'must import its application owner after Cloudflare kernel guards'
    );
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
        '{other:createApplicationServerEntry}=await import'
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
      'var {application,sentryRequestIsolationReady}=await initializeCloudflareSentryApplication(Sentry,async()=>{const kernel=await import("./assets/backend-kernel-fixture.js");kernel.requireRuntimeDatabaseClient();kernel.validateServerBuildConfig("cloudflare");const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");return createApplicationServerEntry("cloudflare")});';
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
      'import{reportTelemetryFailure}from"./telemetry-fixture.js";const forceFlushTelemetry=()=>Promise.resolve();const forceFlushRequestTelemetry=()=>Promise.resolve();const registerRequestCompletion=()=>{};const snapshotRequestCompletions=()=>[];export{forceFlushTelemetry,forceFlushRequestTelemetry,registerRequestCompletion as n,snapshotRequestCompletions as r};'
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
      'node server entry owner runWithNodeSentryRequestIsolation',
    ],
    [
      'vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
      'runWithVercelSentryRequestIsolation',
      'must import Vercel owners initVercelTelemetry, runWithVercelSentryRequestIsolation together exactly once',
    ],
  ])(
    'rejects a %s artifact with detached Sentry request isolation',
    (profile, createArtifact, entry, owner, expected) => {
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
      expect(() => verifyRuntimeProfile(profile, root)).toThrow(expected);
    }
  );

  it.each([
    [
      'missing lifecycle owner',
      (source) =>
        source.replace(
          '"vercel",vercelRequestLifecycle,runWithVercelSentryRequestIsolation',
          '"vercel",undefined,runWithVercelSentryRequestIsolation'
        ),
      'must bind active Vercel lifecycle and request-isolation owners',
    ],
    [
      'missing telemetry initialization',
      (source) => source.replace('initVercelTelemetry();', ''),
      'must initialize Vercel telemetry exactly once',
    ],
    [
      'unreachable telemetry initialization',
      (source) =>
        source.replace(
          'initVercelTelemetry();',
          'false&&initVercelTelemetry();'
        ),
      'must initialize Vercel telemetry exactly once',
    ],
    [
      'same-name local isolation no-op',
      (source) =>
        source.replace(
          'runWithVercelSentryRequestIsolation}=await import',
          'runWithVercelSentryRequestIsolation:trustedIsolation}=await import'
        ) +
        'const runWithVercelSentryRequestIsolation=(run)=>run();void trustedIsolation;',
      'must import Vercel owners initVercelTelemetry, runWithVercelSentryRequestIsolation together exactly once',
    ],
  ])('rejects Vercel %s', (_label, mutate, error) => {
    const root = fixture();
    createVercelArtifact(root);
    const entry = '.vercel/output/functions/__server.func/_ssr/ssr.mjs';
    const entryPath = path.join(root, entry);
    write(root, entry, mutate(fs.readFileSync(entryPath, 'utf8')));

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(error);
  });

  it.each([
    [
      'Node',
      createNodeArtifact,
      '.output/node/server/index.mjs',
      'must route exactly once to the Nitro SSR renderer',
    ],
    [
      'Vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/index.mjs',
      'must route exactly once to the Nitro SSR renderer',
    ],
  ])(
    'rejects an empty declared %s deployment entry',
    (_profileName, createArtifact, entry, error) => {
      const root = fixture();
      createArtifact(root);
      write(root, entry, '');

      expect(() =>
        verifyRuntimeProfile(_profileName.toLowerCase(), root)
      ).toThrow(error);
    }
  );

  it('rejects a Vercel renderer detached from the reviewed SSR entry', () => {
    const root = fixture();
    createVercelArtifact(root);
    write(
      root,
      '.vercel/output/functions/__server.func/_chunks/ssr-renderer.mjs',
      'const lazyService=(load)=>load;const service=lazyService(()=>import("../_ssr/decoy.mjs"));const ssrRenderer=()=>service;export{ssrRenderer as default};'
    );
    write(
      root,
      '.vercel/output/functions/__server.func/_ssr/decoy.mjs',
      'export default {}'
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must load exactly one reviewed application SSR entry'
    );
  });

  it.each([
    [
      'missing telemetry exports',
      '.vercel/output/functions/__server.func/_libs/telemetry-owner.mjs',
      '"@vercel/otel";',
      'must export linked Vercel telemetry initializer',
    ],
    [
      'no-op telemetry implementation',
      '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs',
      'const initVercelTelemetry=()=>{};const runWithVercelSentryRequestIsolation=(operation)=>operation();export{runWithVercelSentryRequestIsolation as r,initVercelTelemetry as t};"@vercel/otel";',
      'Vercel telemetry initializer must reach',
    ],
    [
      'no-op lifecycle implementation',
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs',
      'const vercelRequestLifecycle={onRequestSettled(request){void request}};export{vercelRequestLifecycle};"@vercel/functions";',
      'must flush Vercel request telemetry with waitUntil',
    ],
    [
      'dummy application factory',
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
      'const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>({runtimeProfile,lifecycle,requestScope});export{createApplicationServerEntry};',
      'must import telemetry before the TanStack server entry',
    ],
  ])('rejects a Vercel %s', (_label, file, source, error) => {
    const root = fixture();
    createVercelArtifact(root);
    write(root, file, source);

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(error);
  });

  it.each([
    [
      'dead lifecycle scheduling',
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs',
      'import_functions.waitUntil(flush)',
      'if(false)import_functions.waitUntil(flush)',
      'must flush Vercel request telemetry with waitUntil',
    ],
    [
      'dead application entry return',
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
      'return tanstack.createServerEntry',
      'if(false)return tanstack.createServerEntry',
      'universal application server entry',
    ],
  ])('rejects Vercel %s', (_label, file, search, replacement, error) => {
    const root = fixture();
    createVercelArtifact(root);
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs.readFileSync(filePath, 'utf8').replace(search, replacement)
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(error);
  });

  it('rejects a Vercel lifecycle waitUntil decoy receiver', () => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'import_functions.waitUntil(flush)',
          '({waitUntil(){}}).waitUntil(flush)'
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must flush Vercel request telemetry with waitUntil'
    );
  });

  it('rejects locally shadowed Vercel lifecycle helpers', () => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'onRequestSettled(request){',
          'onRequestSettled(request){const forceFlushRequestTelemetry=()=>Promise.resolve(),getTelemetry=()=>({}),import_functions={waitUntil(){}};'
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must flush Vercel request telemetry with waitUntil'
    );
  });

  it('rejects mutation of the reviewed Vercel waitUntil receiver', () => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'const flush=',
          'import_functions.waitUntil=()=>{};const flush='
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must flush Vercel request telemetry with waitUntil'
    );
  });

  it('rejects Vercel lifecycle self-mutation hidden in the flush initializer', () => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'forceFlushRequestTelemetry(request,getTelemetry())',
          '(this.onRequestSettled=()=>{},forceFlushRequestTelemetry(request,getTelemetry()))'
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must flush Vercel request telemetry with waitUntil'
    );
  });

  it('rejects mutation of an alias of the reviewed Vercel waitUntil receiver', () => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'const flush=',
          'const waitAlias=import_functions;waitAlias.waitUntil=()=>{};const flush='
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must flush Vercel request telemetry with waitUntil'
    );
  });

  it('rejects conditionally scheduled Vercel request telemetry', () => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'import_functions.waitUntil(flush)',
          'if(Math.random()<0)import_functions.waitUntil(flush)'
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must flush Vercel request telemetry with waitUntil'
    );
  });

  it.each([
    [
      'mutated TanStack fetch receiver',
      'const handleRequest=async()=>{',
      'const handleRequest=async()=>{tanstack.default.fetch=()=>new Response("decoy");',
    ],
    [
      'mutated lifecycle receiver',
      'const handleRequest=async()=>{',
      'const handleRequest=async()=>{lifecycle.onRequestSettled=()=>{};',
    ],
    [
      'reassigned request scope',
      'async fetch(request){',
      'async fetch(request){requestScope=()=>new Response("decoy");',
    ],
    [
      'disconnected request scope',
      'try{return requestScope(runApplicationOnce)}',
      'requestScope(()=>{});try{return runApplicationOnce()}',
    ],
    [
      'discarded TanStack response',
      'return await tanstack.default.fetch(request,{context})',
      'await tanstack.default.fetch(request,{context});return new Response("decoy")',
    ],
  ])('rejects a Vercel application with %s', (_label, search, replacement) => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs.readFileSync(filePath, 'utf8').replace(search, replacement)
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow();
  });

  it.each([
    [
      'trace wrapper parameter',
      'const initializeTraceOwner=(config,contextManager)=>',
      'const initializeTraceOwner=(config,contextManager,runWithNormalizedOtelSdkEnvironment=(operation)=>operation())=>',
      'must delegate Vercel trace ownership to @vercel/otel',
    ],
    [
      'Sentry isolation parameter',
      'const runWithSentryNodeRequestIsolation=(operation)=>',
      'const runWithSentryNodeRequestIsolation=(operation,withIsolationScope=(value)=>value())=>',
      'must implement Sentry request isolation',
    ],
    [
      'telemetry owner parameters',
      'const initVercelTelemetry=()=>',
      'const initVercelTelemetry=(createSentryNodeRequestContextManager=()=>({}),initializeSignalOwners=()=>({}),initializeTraceOwner=()=>({}),installServerTelemetry=()=>{})=>',
      'Vercel telemetry initializer must reach',
    ],
  ])('rejects a shadowing Vercel %s', (_label, search, replacement, error) => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs.readFileSync(filePath, 'utf8').replace(search, replacement)
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(error);
  });

  it.each([
    [
      'telemetry initializer',
      '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs',
      'export{runWithVercelSentryRequestIsolation as r,initVercelTelemetry as t}',
      'initVercelTelemetry=()=>{};export{runWithVercelSentryRequestIsolation as r,initVercelTelemetry as t}',
    ],
    [
      'request-isolation owner',
      '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs',
      'export{runWithVercelSentryRequestIsolation as r,initVercelTelemetry as t}',
      'runWithVercelSentryRequestIsolation=(operation)=>operation();export{runWithVercelSentryRequestIsolation as r,initVercelTelemetry as t}',
    ],
    [
      'request lifecycle owner',
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs',
      'export{vercelRequestLifecycle}',
      'vercelRequestLifecycle={onRequestSettled(){}};export{vercelRequestLifecycle}',
    ],
    [
      'application entry owner',
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
      'export{createApplicationServerEntry}',
      'createApplicationServerEntry=async()=>({fetch(){return new Response("decoy")}});export{createApplicationServerEntry}',
    ],
    [
      'lifecycle helper',
      '.vercel/output/functions/__server.func/_ssr/request-completion-fixture.mjs',
      'export{forceFlushRequestTelemetry}',
      'forceFlushRequestTelemetry=()=>Promise.resolve();export{forceFlushRequestTelemetry}',
    ],
  ])(
    'rejects mutation of the linked Vercel %s',
    (_label, file, search, replacement) => {
      const root = fixture();
      createVercelArtifact(root);
      const filePath = path.join(root, file);
      write(
        root,
        file,
        fs.readFileSync(filePath, 'utf8').replace(search, replacement)
      );
      expect(() => verifyRuntimeProfile('vercel', root)).toThrow();
    }
  );

  it.each([
    [
      'direct waitUntil receiver alias',
      'const vercelRequestLifecycle=',
      'const waitAlias=import_functions;waitAlias.waitUntil=()=>{};const vercelRequestLifecycle=',
    ],
    [
      'wrapped waitUntil receiver alias',
      'const vercelRequestLifecycle=',
      'const box={value:import_functions};box.value.waitUntil=()=>{};const vercelRequestLifecycle=',
    ],
    [
      'destructured waitUntil receiver alias',
      'const vercelRequestLifecycle=',
      'const {value:waitAlias}={value:import_functions};waitAlias.waitUntil=()=>{};const vercelRequestLifecycle=',
    ],
    [
      'conditional waitUntil receiver alias',
      'const vercelRequestLifecycle=',
      'const waitAlias=true?import_functions:{};waitAlias.waitUntil=()=>{};const vercelRequestLifecycle=',
    ],
    [
      'helper-mutated waitUntil receiver',
      'const vercelRequestLifecycle=',
      'const replaceWait=value=>{value.waitUntil=()=>{}};replaceWait(import_functions);const vercelRequestLifecycle=',
    ],
    [
      'direct request lifecycle owner alias',
      'export{vercelRequestLifecycle}',
      'const lifecycleAlias=vercelRequestLifecycle;lifecycleAlias.onRequestSettled=()=>{};export{vercelRequestLifecycle}',
    ],
    [
      'wrapped request lifecycle owner alias',
      'export{vercelRequestLifecycle}',
      'const box={value:vercelRequestLifecycle};box.value.onRequestSettled=()=>{};export{vercelRequestLifecycle}',
    ],
    [
      'destructured request lifecycle owner alias',
      'export{vercelRequestLifecycle}',
      'const {value:lifecycleAlias}={value:vercelRequestLifecycle};lifecycleAlias.onRequestSettled=()=>{};export{vercelRequestLifecycle}',
    ],
    [
      'conditional request lifecycle owner alias',
      'export{vercelRequestLifecycle}',
      'const lifecycleAlias=true?vercelRequestLifecycle:{};lifecycleAlias.onRequestSettled=()=>{};export{vercelRequestLifecycle}',
    ],
    [
      'helper-mutated request lifecycle owner',
      'export{vercelRequestLifecycle}',
      'const replaceLifecycle=value=>{value.onRequestSettled=()=>{}};replaceLifecycle(vercelRequestLifecycle);export{vercelRequestLifecycle}',
    ],
  ])(
    'rejects a top-level alias mutation of the Vercel %s',
    (_label, search, replacement) => {
      const root = fixture();
      createVercelArtifact(root);
      const file =
        '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs';
      const filePath = path.join(root, file);
      write(
        root,
        file,
        fs.readFileSync(filePath, 'utf8').replace(search, replacement)
      );
      expect(() => verifyRuntimeProfile('vercel', root)).toThrow();
    }
  );

  it.each([
    [
      'replacement default',
      'export{vercel_web_default as default}',
      'const replacement={fetch(){return new Response("decoy")}};export{replacement as default}',
    ],
    [
      'aliased default mutation',
      'export{vercel_web_default as default}',
      'const defaultAlias=vercel_web_default;defaultAlias.fetch=()=>new Response("decoy");export{vercel_web_default as default}',
    ],
  ])(
    'rejects a Vercel deployed entry with %s',
    (_label, search, replacement) => {
      const root = fixture();
      createVercelArtifact(root);
      const file = '.vercel/output/functions/__server.func/index.mjs';
      const filePath = path.join(root, file);
      write(
        root,
        file,
        fs.readFileSync(filePath, 'utf8').replace(search, replacement)
      );
      expect(() => verifyRuntimeProfile('vercel', root)).toThrow();
    }
  );

  it.each([
    [
      'an unrelated request-scope result',
      'return applicationResult};try{return requestScope',
      'return new Response("decoy")};try{return requestScope',
    ],
    [
      'a different lifecycle request',
      'lifecycle?.onRequestSettled(request)',
      'lifecycle?.onRequestSettled(new Request("https://invalid.example"))',
    ],
    [
      'lifecycle settlement before the application result',
      'try{return await tanstack.default.fetch(request,{context})}',
      'lifecycle?.onRequestSettled(request);try{return await tanstack.default.fetch(request,{context})',
    ],
  ])(
    'rejects a Vercel application returning through %s',
    (_label, search, replacement) => {
      const root = fixture();
      createVercelArtifact(root);
      const file =
        '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs';
      const filePath = path.join(root, file);
      write(
        root,
        file,
        fs.readFileSync(filePath, 'utf8').replace(search, replacement)
      );
      expect(() => verifyRuntimeProfile('vercel', root)).toThrow();
    }
  );

  it.each([
    [
      'TanStack handler receiver',
      'tanstack.default.fetch(request,{context})',
      '({fetch:()=>new Response()}).fetch(request)',
    ],
    [
      'lifecycle receiver',
      'lifecycle?.onRequestSettled(request)',
      '({onRequestSettled(){}}).onRequestSettled(request)',
    ],
    [
      'request-scope binding',
      'async fetch(request){',
      'async fetch(request){const requestScope=(operation)=>operation();',
    ],
  ])('rejects a decoy Vercel application %s', (_label, search, replacement) => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs.readFileSync(filePath, 'utf8').replace(search, replacement)
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow();
  });

  it('rejects Vercel application evidence in an uninvoked nested function', () => {
    const root = fixture();
    createVercelArtifact(root);
    write(
      root,
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
      'const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>{const{telemetryProxy}=await import("./telemetry-proxy-fixture.mjs");const tanstack=await import("./entry-server-fixture.mjs");return tanstack.createServerEntry({async fetch(request){function decoy(){requestScope(()=>{});lifecycle.onRequestSettled(request);tanstack.default.fetch(request,{context:{runtimeProfile,telemetryProxy}})}return new Response("bypass")}})};export{createApplicationServerEntry};'
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow('universal');
  });

  it('rejects locally shadowed Vercel telemetry owners', () => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'const contextManager=createSentryNodeRequestContextManager();initializeTraceOwner(config,contextManager);initializeSignalOwners();installServerTelemetry()',
          'const createSentryNodeRequestContextManager=()=>{},initializeTraceOwner=()=>{},initializeSignalOwners=()=>{},installServerTelemetry=()=>{};const contextManager=createSentryNodeRequestContextManager();initializeTraceOwner(config,contextManager);initializeSignalOwners();installServerTelemetry()'
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'Vercel telemetry initializer must reach'
    );
  });

  it.each([
    [
      'trace wrapper',
      'const initializeTraceOwner=(config,contextManager)=>runWithNormalizedOtelSdkEnvironment(()=>registerOTel({config,contextManager}))',
      'const initializeTraceOwner=(config,contextManager)=>{const runWithNormalizedOtelSdkEnvironment=(operation)=>operation();return runWithNormalizedOtelSdkEnvironment(()=>registerOTel({config,contextManager}))}',
      'must delegate Vercel trace ownership to @vercel/otel',
    ],
    [
      'Sentry isolation wrapper',
      'const runWithSentryNodeRequestIsolation=(operation)=>withIsolationScope(operation)',
      'const runWithSentryNodeRequestIsolation=(operation)=>{const withIsolationScope=(value)=>value();return withIsolationScope(operation)}',
      'must implement Sentry request isolation',
    ],
  ])(
    'rejects a locally shadowed Vercel %s',
    (_label, search, replacement, error) => {
      const root = fixture();
      createVercelArtifact(root);
      const file =
        '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs';
      const filePath = path.join(root, file);
      write(
        root,
        file,
        fs.readFileSync(filePath, 'utf8').replace(search, replacement)
      );

      expect(() => verifyRuntimeProfile('vercel', root)).toThrow(error);
    }
  );

  it.each([
    ['return;', 'early return'],
    [
      'if(false){const contextManager=createSentryNodeRequestContextManager();initializeTraceOwner(config,contextManager);initializeSignalOwners();installServerTelemetry()}',
      'dead branch',
    ],
  ])('rejects Vercel telemetry owners behind an %s', (replacement) => {
    const root = fixture();
    createVercelArtifact(root);
    const file =
      '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs';
    const filePath = path.join(root, file);
    write(
      root,
      file,
      fs
        .readFileSync(filePath, 'utf8')
        .replace(
          'const contextManager=createSentryNodeRequestContextManager();initializeTraceOwner(config,contextManager);initializeSignalOwners();installServerTelemetry()',
          replacement
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'Vercel telemetry initializer must reach'
    );
  });

  it.each([
    [
      'lifecycle owner',
      '.vercel/output/functions/__server.func/_ssr/request-lifecycle-fixture.mjs',
      'onRequestSettled(request){',
      'onRequestSettled(request){if(true)return;',
      'must flush Vercel request telemetry with waitUntil',
    ],
    [
      'application handler',
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
      'async fetch(request){',
      'async fetch(request){if(true)return new Response();',
      'universal application server entry',
    ],
    [
      'telemetry initializer',
      '.vercel/output/functions/__server.func/_ssr/telemetry-implementation.mjs',
      'const initVercelTelemetry=()=>{',
      'const initVercelTelemetry=()=>{if(true)return;',
      'Vercel telemetry initializer must reach',
    ],
  ])(
    'rejects a statically terminating Vercel %s',
    (_label, file, search, replacement, error) => {
      const root = fixture();
      createVercelArtifact(root);
      const filePath = path.join(root, file);
      write(
        root,
        file,
        fs.readFileSync(filePath, 'utf8').replace(search, replacement)
      );

      expect(() => verifyRuntimeProfile('vercel', root)).toThrow(error);
    }
  );

  it('rejects disconnected Vercel application-entry evidence', () => {
    const root = fixture();
    createVercelArtifact(root);
    write(
      root,
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
      'const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>{const{telemetryProxy}=await import("./telemetry-proxy-fixture.mjs");const tanstack=await import("./entry-server-fixture.mjs");if(false){return tanstack.createServerEntry({async fetch(request){const handle=()=>tanstack.default.fetch(request,{context:{runtimeProfile,telemetryProxy}});try{return requestScope(handle)}finally{lifecycle?.onRequestSettled(request)}}})}return tanstack.createServerEntry({})};export{createApplicationServerEntry};'
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow('universal');
  });

  it('rejects dead lifecycle and request-scope evidence in the returned Vercel fetch owner', () => {
    const root = fixture();
    createVercelArtifact(root);
    write(
      root,
      '.vercel/output/functions/__server.func/_ssr/create-application-server-entry-fixture.mjs',
      'const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>{const{telemetryProxy}=await import("./telemetry-proxy-fixture.mjs");const tanstack=await import("./entry-server-fixture.mjs");return tanstack.createServerEntry({async fetch(request){if(false){requestScope(()=>{});lifecycle.onRequestSettled(request)}void runtimeProfile;void telemetryProxy;return tanstack.default.fetch(request)}})};export{createApplicationServerEntry};'
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow('universal');
  });

  it('rejects an aliased mutable Vercel lifecycle owner', () => {
    const root = fixture();
    createVercelArtifact(root);
    const entry = '.vercel/output/functions/__server.func/_ssr/ssr.mjs';
    const entryPath = path.join(root, entry);
    write(
      root,
      entry,
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'var {createApplicationServerEntry}',
          'const lifecycleAlias=vercelRequestLifecycle;lifecycleAlias.onRequestSettled=()=>{};var {createApplicationServerEntry}'
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must not alias mutable Vercel owners'
    );
  });

  it.each([
    'server_entry_default.fetch=()=>new Response("decoy");',
    'Reflect.set(server_entry_default,"fetch",()=>new Response("decoy"));',
    'const resultAlias=server_entry_default;resultAlias.fetch=()=>new Response("decoy");',
  ])('rejects mutation of the exported Vercel application result', (attack) => {
    const root = fixture();
    createVercelArtifact(root);
    const entry = '.vercel/output/functions/__server.func/_ssr/ssr.mjs';
    const entryPath = path.join(root, entry);
    write(
      root,
      entry,
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'export{server_entry_default as default}',
          `${attack}export{server_entry_default as default}`
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must immediately export one immutable Vercel application result'
    );
  });

  it('rejects an assignment alias of a mutable Vercel lifecycle owner', () => {
    const root = fixture();
    createVercelArtifact(root);
    const entry = '.vercel/output/functions/__server.func/_ssr/ssr.mjs';
    const entryPath = path.join(root, entry);
    write(
      root,
      entry,
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'var {createApplicationServerEntry}',
          'var lifecycleAlias;lifecycleAlias=vercelRequestLifecycle;lifecycleAlias.onRequestSettled=()=>{};var {createApplicationServerEntry}'
        )
    );

    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'must not alias mutable Vercel owners'
    );
  });

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

  it('rejects Worker identity drift', () => {
    const root = fixture();
    createCloudflareArtifact(root);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'different-app',
      })
    ).toThrow('Cloudflare APP_SLUG identity');
  });

  it('rejects recursively leaked Worker dev vars', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/nested/.dev.vars.preview', 'SECRET=x\n');

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
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

  it.each([
    [
      'cloudflare',
      createCloudflareArtifact,
      'dist/server/assets/leaked.js',
      'const provider = new AsyncLocalStorageContextManager();',
      { expectedAppSlug: 'acme-app' },
      'forbidden cloudflare runtime token AsyncLocalStorageContextManager',
    ],
    [
      'cloudflare',
      createCloudflareArtifact,
      'dist/server/assets/local-sqlite-sink.js',
      'const localSqliteEnabled = true; CREATE TABLE telemetry_summary;',
      { expectedAppSlug: 'acme-app' },
      'forbidden cloudflare runtime token telemetry_summary',
    ],
    [
      'node',
      createNodeArtifact,
      '.output/node/server/chunks/leaked.mjs',
      'import "@vercel/otel";',
      undefined,
      'forbidden node runtime token @vercel/otel',
    ],
    [
      'vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/chunks/leaked.mjs',
      'initOpenTelemetryServer();',
      undefined,
      'forbidden vercel runtime token initOpenTelemetryServer',
    ],
    [
      'vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/chunks/local-sqlite-sink.mjs',
      'CREATE TABLE telemetry_summary;',
      undefined,
      'forbidden vercel runtime token telemetry_summary',
    ],
  ])(
    'rejects %s runtime-specific provider leakage recursively: %s',
    (profile, create, file, source, options, message) => {
      const root = fixture();
      create(root);
      write(root, file, source);

      expect(() => verifyRuntimeProfile(profile, root, options)).toThrow(
        message
      );
    }
  );

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
      'if(isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error))telemetryProxy.captureException(error,{level:"error",tags:{event:"framework.request.failed",requestId:context.requestId}});',
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

  it.each([
    [
      'an injected loader import',
      'const kernel=await import("./assets/backend-kernel-fixture.js");',
      'await import("./assets/evil.js");const kernel=await import("./assets/backend-kernel-fixture.js");',
    ],
    [
      'a missing runtime-database guard',
      'kernel.requireRuntimeDatabaseClient();',
      '',
    ],
    [
      'a substituted build-profile guard',
      'kernel.validateServerBuildConfig("cloudflare");',
      'kernel.validateServerBuildConfig("node");',
    ],
  ])('rejects %s in the application loader', (_label, search, replacement) => {
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
    ).toThrow('application loader must run exact Cloudflare kernel guards');
  });

  it('rejects a missing Cloudflare kernel owner chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    fs.rmSync(path.join(root, 'dist/server/assets/backend-kernel-fixture.js'));

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('backend-kernel-fixture.js');
  });

  it.each([
    ['src', 'src/modules/kernel/forged.ts'],
    ['isDynamicEntry', false],
  ])('rejects forged kernel %s provenance', (field, value) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/kernel/backend.ts'][field] = value;
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must originate from src/modules/kernel/backend.ts');
  });

  it('rejects a kernel facade missing a required guard export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/backend-kernel-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'export{requireRuntimeDatabaseClient,validateServerBuildConfig}',
          'export{validateServerBuildConfig}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must expose exact Cloudflare kernel guards: requireRuntimeDatabaseClient'
    );
  });

  it('keeps the production Cloudflare kernel behind the inert top-level gate', () => {
    const source = [
      'import"./auth-fixture.js";',
      'import"./telemetry-fixture.js";',
      'import"./client-database-fixture.js";',
      'import"./client-environment-fixture.js";',
      'import"./runtime-fixture.js";',
      'import"./backend-fixture.js";',
      'fetch("https://invalid.example");',
    ].join('');

    expect(() =>
      inspectCloudflareProductionKernelStaticShapeForTesting(source)
    ).toThrow('must contain only inert top-level declarations');
  });

  it('rejects a local decoy application factory in the guarded loader', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{createApplicationServerEntry}=await import',
          '{createApplicationServerEntry:realCreateApplicationServerEntry}=await import'
        )
        .replace(
          'return createApplicationServerEntry("cloudflare")',
          'const createApplicationServerEntry=()=>({fetch:()=>new Response("bypassed")});return createApplicationServerEntry("cloudflare")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('application loader must run exact Cloudflare kernel guards');
  });

  it.each([
    [
      'a disabled exception-capture guard',
      'isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error)',
      'false&&false',
      'universal request owner must preserve framework failures',
    ],
    [
      'a malformed lifecycle failure scope',
      'finally{try{lifecycle?.onRequestSettled(request)}catch{}}',
      'finally{try{lifecycle?.onRequestSettled(request)}finally{}}',
      'universal request owner must settle its active lifecycle',
    ],
    [
      'a side-effecting application import declaration',
      'const tanstack=await import("./entry-server-fixture.js");',
      'const tanstack=await import("./entry-server-fixture.js"),sabotage=consume(request);',
      'must isolate trusted tanstack import',
    ],
    [
      'a substituted request-scope diagnostic key',
      'reportTelemetryFailure("sentry.request_scope",failure)',
      'reportTelemetryFailure("wrong",failure)',
      'universal request owner must preserve scoped execution',
    ],
    [
      'a side-effecting request-scope argument',
      'return requestScope(runApplicationOnce)',
      'return requestScope(runApplicationOnce,request.arrayBuffer())',
      'universal request owner must preserve scoped execution',
    ],
    [
      'an awaited disabled-scope application call',
      'if(!requestScope)return handleRequest();',
      'if(!requestScope)return await handleRequest();',
      'universal request owner must execute its application exactly once',
    ],
    [
      'a non-call lifecycle settlement statement',
      'lifecycle?.onRequestSettled(request)',
      '1',
      'universal request owner must settle its active lifecycle',
    ],
    [
      'a missing application result declaration',
      'let applicationResult;',
      ';',
      'universal request owner must execute its application exactly once',
    ],
    [
      'an expression-bodied application memoizer',
      'const runApplicationOnce=()=>{applicationResult??=handleRequest();return applicationResult}',
      'const runApplicationOnce=()=>applicationResult??=handleRequest()',
      'universal request owner must memoize one application execution',
    ],
    [
      'a request scope without a failure handler',
      'try{return requestScope(runApplicationOnce)}catch(failure){reportTelemetryFailure("sentry.request_scope",failure);return applicationResult??runApplicationOnce()}',
      'try{return requestScope(runApplicationOnce)}finally{}',
      'universal request owner must preserve scoped execution',
    ],
    [
      'a non-call TanStack entry return',
      'return tanstack.createServerEntry({',
      'return 1||tanstack.createServerEntry({',
      'must return one TanStack server entry',
    ],
  ])(
    'rejects %s with a bounded universal-entry diagnostic',
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

  it('rejects an expression-bodied universal request handler cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    const source = fs.readFileSync(chunkPath, 'utf8');
    const startMarker = 'const handleRequest=async()=>{';
    const endMarker = '};if(!requestScope)';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    const mutated =
      source.slice(0, start) +
      'const handleRequest=async()=>tanstack.default.fetch(request);if(!requestScope)' +
      source.slice(end + endMarker.length);
    write(root, relativePath, mutated);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'universal application server entry must own one live request handler'
    );
  });

  it('rejects a non-function universal fetch owner cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /return tanstack\.createServerEntry\(\{async fetch\(request\)\{[\s\S]*\}\}\)\};export\{createApplicationServerEntry\};/u,
          'return tanstack.createServerEntry({fetch:1})};export{createApplicationServerEntry};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'universal application server entry must own one live request handler'
    );
  });

  it('rejects substitution of a universal-entry static helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'r as createRequestExceptionCaptureState',
          'r as realCreateRequestExceptionCaptureState'
        )
        .replace(
          ';const createApplicationServerEntry=',
          ';const createRequestExceptionCaptureState=()=>({});const createApplicationServerEntry='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted helper createRequestExceptionCaptureState exactly once'
    );
  });

  it('rejects a universal helper without a Vite manifest record', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest['_request-failure-fixture.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare app-owned manifest graph');
  });

  it('rejects a universal helper detached from its application manifest edge', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const application =
      manifest['src/runtime/create-application-server-entry.ts'];
    application.imports = application.imports.filter(
      (key) => key !== '_request-failure-fixture.js'
    );
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import exactly its trusted helper manifest records');
  });

  it.each([
    'dist/server/assets/create-application-server-entry-fixture.js',
    'dist/server/assets/database-request-fixture.js',
    'dist/server/assets/request-failure-fixture.js',
  ])('rejects load-time execution in %s', (relativePath) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `fetch("https://invalid.example");${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it('rejects an unbound top-level application initializer', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const sabotage=missingIdentifier;${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it.each([
    'const sabotage={valueOf:()=>fetch("https://invalid.example")}+1;',
    'const sabotage=+{valueOf:()=>fetch("https://invalid.example")};',
  ])('rejects coercing top-level application initializers', (initializer) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${initializer}${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it('rejects a collection initializer that crashes during module evaluation', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const sabotage=new Set({});${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it('rejects load-time execution in the TanStack entry chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `fetch("https://invalid.example");${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it.each([
    [
      'const entry={fetch:createStartHandler(observedStreamHandler)};',
      'const entry={fetch:fetch("https://invalid.example")};',
    ],
    [
      'const createServerEntry=(serverEntry)=>serverEntry;',
      'const createServerEntry=(serverEntry)=>(fetch("https://invalid.example"),serverEntry);',
    ],
  ])(
    'rejects executable substitutions in the TanStack entry owners',
    (trustedOwner, substitutedOwner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath = 'dist/server/assets/entry-server-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs
          .readFileSync(chunkPath, 'utf8')
          .replace(trustedOwner, substitutedOwner)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must preserve the import-safe TanStack server entry shape');
    }
  );

  it('rejects a substituted TanStack observed stream handler', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const observedStreamHandler=.*?;const entry=/u,
          'const observedStreamHandler=defineHandlerCallback(async()=>fetch("https://invalid.example"));const entry='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it('rejects a TanStack observed stream handler that discards its response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'return createSsrStreamResponse(router,response)',
          'return(createSsrStreamResponse(router,response),new Response("bypassed"))'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it('rejects a computed side effect in an otherwise unchanged observed handler', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'registerRequestCompletion(request,stream)',
          'registerRequestCompletion(request,stream,globalThis["fetch"]("https://invalid.example"))'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed observed stream handler');
  });

  it.each([
    'new Response(responseStream)',
    'new Response(responseStream,(globalThis["fetch"]("https://invalid.example"),{headers:responseHeaders,status:router.stores.statusCode.get()}))',
  ])('rejects substituted TanStack response options: %s', (substitution) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'new Response(responseStream,{headers:responseHeaders,status:router.stores.statusCode.get()})',
          substitution
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it.each(['createStartHandler', 'defineHandlerCallback'])(
    'rejects a synchronized same-family %s owner substitution',
    (ownerName) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const trustedFile = 'server-fixture.js';
      const substitutedFile = 'server-decoy-fixture.js';
      const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
      const substitutedOwner = `${ownerName}Decoy`;
      const trustedExports =
        'export{createSsrStreamResponse,createStartHandler,defineHandlerCallback,isbot,StartServer,transformReadableStreamWithRouter}';
      write(
        root,
        `dist/server/assets/${substitutedFile}`,
        fs
          .readFileSync(trustedPath, 'utf8')
          .replace(`const ${ownerName}=`, `const ${substitutedOwner}=`)
          .replace(
            trustedExports,
            trustedExports.replace(
              ownerName,
              `${substitutedOwner} as ${ownerName}`
            )
          )
      );
      const entryPath = 'dist/server/assets/entry-server-fixture.js';
      write(
        root,
        entryPath,
        fs
          .readFileSync(path.join(root, entryPath), 'utf8')
          .replace(trustedFile, substitutedFile)
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const trustedManifestKey = '_server-fixture.js';
      const substitutedManifestKey = '_server-decoy-fixture.js';
      manifest[substitutedManifestKey] = {
        ...manifest[trustedManifestKey],
        file: `assets/${substitutedFile}`,
      };
      const entryImports = manifest['src/entry-server.ts'].imports;
      entryImports.splice(
        entryImports.indexOf(trustedManifestKey),
        1,
        substitutedManifestKey
      );
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`must import the ${ownerName} export from its owner chunk`);
    }
  );

  it.each(['createStartHandler', 'defineHandlerCallback'])(
    'rejects a synchronized same-name %s body substitution',
    (ownerName) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const trustedFile = 'server-fixture.js';
      const substitutedFile = 'server-decoy-fixture.js';
      const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
      write(
        root,
        `dist/server/assets/${substitutedFile}`,
        fs
          .readFileSync(trustedPath, 'utf8')
          .replace(
            `const ${ownerName}=(handler)=>handler`,
            `const ${ownerName}=(handler)=>(fetch("https://invalid.example"),handler)`
          )
      );
      const entryPath = 'dist/server/assets/entry-server-fixture.js';
      write(
        root,
        entryPath,
        fs
          .readFileSync(path.join(root, entryPath), 'utf8')
          .replace(trustedFile, substitutedFile)
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const trustedManifestKey = '_server-fixture.js';
      const substitutedManifestKey = '_server-decoy-fixture.js';
      manifest[substitutedManifestKey] = {
        ...manifest[trustedManifestKey],
        file: `assets/${substitutedFile}`,
      };
      const entryImports = manifest['src/entry-server.ts'].imports;
      entryImports.splice(
        entryImports.indexOf(trustedManifestKey),
        1,
        substitutedManifestKey
      );
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`must use the reviewed ${ownerName} implementation`);
    }
  );

  it('rejects a synchronized transitive TanStack server substitution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const trustedFile = 'server-fixture.js';
    const substitutedFile = 'server-decoy-fixture.js';
    const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
    write(
      root,
      `dist/server/assets/${substitutedFile}`,
      fs
        .readFileSync(trustedPath, 'utf8')
        .replace(
          'const createSsrStreamResponse=(_router,response)=>response',
          'const createSsrStreamResponse=(_router,response)=>(fetch("https://invalid.example"),response)'
        )
    );
    const entryPath = 'dist/server/assets/entry-server-fixture.js';
    write(
      root,
      entryPath,
      fs
        .readFileSync(path.join(root, entryPath), 'utf8')
        .replace(trustedFile, substitutedFile)
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const trustedManifestKey = '_server-fixture.js';
    const substitutedManifestKey = '_server-decoy-fixture.js';
    manifest[substitutedManifestKey] = {
      ...manifest[trustedManifestKey],
      file: `assets/${substitutedFile}`,
    };
    const entryImports = manifest['src/entry-server.ts'].imports;
    entryImports.splice(
      entryImports.indexOf(trustedManifestKey),
      1,
      substitutedManifestKey
    );
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack server static import closure');
  });

  it.each([
    [
      'TanStack server',
      {
        parentFile: 'server-fixture.js',
        parentManifestKey: '_server-fixture.js',
        replacementFile: 'createCsrfMiddleware-BBBBBBBB.js',
        replacementManifestKey: '_createCsrfMiddleware-BBBBBBBB.js',
        transform: (source) =>
          source.replace(
            'const createCsrfMiddleware=()=>{}',
            'const createCsrfMiddleware=()=>true'
          ),
        trustedFile: 'createCsrfMiddleware-AAAAAAAA.js',
        trustedManifestKey: '_createCsrfMiddleware-AAAAAAAA.js',
      },
      'must use the reviewed TanStack server static import closure',
    ],
    [
      'React server renderer',
      {
        parentFile: 'server.edge-fixture.js',
        parentManifestKey: '_server.edge-fixture.js',
        replacementFile: 'react-dom-BBBBBBBB.js',
        replacementManifestKey: '_react-dom-BBBBBBBB.js',
        transform: (source) =>
          source.replace(
            'const renderToReadableStream=()=>new ReadableStream()',
            'const renderToReadableStream=()=>fetch("https://invalid.example")'
          ),
        trustedFile: 'react-dom-AAAAAAAA.js',
        trustedManifestKey: '_react-dom-AAAAAAAA.js',
      },
      'must use the reviewed React server renderer static import closure',
    ],
  ])(
    'rejects a synchronized hashed dependency substitution in the %s closure',
    (_label, substitution, expectedMessage) => {
      const root = fixture();
      createCloudflareArtifact(root);
      replaceManifestBackedHashedDependency(root, substitution);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(expectedMessage);
    }
  );

  it('accepts a content-identical hashed dependency rename', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    replaceManifestBackedHashedDependency(root, {
      parentFile: 'server-fixture.js',
      parentManifestKey: '_server-fixture.js',
      replacementFile: 'createCsrfMiddleware-BBBBBBBB.js',
      replacementManifestKey: '_createCsrfMiddleware-BBBBBBBB.js',
      transform: (source) => source,
      trustedFile: 'createCsrfMiddleware-AAAAAAAA.js',
      trustedManifestKey: '_createCsrfMiddleware-AAAAAAAA.js',
    });

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects a synchronized dynamic dependency substitution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const assets = path.join(root, 'dist/server/assets');
    const trustedFile = 'empty-plugin-adapters-AAAAAAAA.js';
    const replacementFile = 'empty-plugin-adapters-BBBBBBBB.js';
    write(
      root,
      `dist/server/assets/${replacementFile}`,
      fs
        .readFileSync(path.join(assets, trustedFile), 'utf8')
        .replace(
          'const emptyPluginAdapter=true',
          'const emptyPluginAdapter=fetch("https://invalid.example")'
        )
    );
    const serverPath = path.join(assets, 'server-fixture.js');
    write(
      root,
      'dist/server/assets/server-fixture.js',
      fs.readFileSync(serverPath, 'utf8').replace(trustedFile, replacementFile)
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest[fixtureEmptyPluginAdaptersSource] = {
      ...manifest[fixtureEmptyPluginAdaptersSource],
      file: `assets/${replacementFile}`,
    };
    fs.rmSync(path.join(assets, trustedFile));
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed empty plugin adapters owner');
  });

  it('rejects mutation of the dynamically loaded getRouter owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(routerPath, 'utf8')
        .replace(
          'function getRouter(){',
          'function getRouter(){globalThis.fetch("https://invalid.example");'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects mutation of a local helper reachable from getRouter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(routerPath, 'utf8')
        .replace(
          'const getRouterCspNonce=()=>undefined',
          'const getRouterCspNonce=()=>globalThis.fetch("https://invalid.example")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it.each([
    [
      'a transitive alias',
      'const startInstance={};const alias=startInstance;alias.compromised=()=>1;export{startInstance};',
    ],
    [
      'Object.assign',
      'const startInstance={};Object.assign(startInstance,{compromised:()=>1});export{startInstance};',
    ],
    [
      'Reflect.set',
      'const startInstance={};const alias=startInstance;Reflect.set(alias,"compromised",()=>1);export{startInstance};',
    ],
    [
      'an invoked top-level helper',
      'const startInstance={};const mutate=()=>Object.assign(startInstance,{getOptions:()=>fetch("https://invalid.example")});mutate();export{startInstance};',
    ],
    [
      'an array-destructured alias',
      'const startInstance={};const[alias]=[startInstance];alias.getOptions=()=>fetch("https://invalid.example");export{startInstance};',
    ],
    [
      'an object-destructured alias',
      'const startInstance={};const{owner:alias}={owner:startInstance};alias.getOptions=()=>fetch("https://invalid.example");export{startInstance};',
    ],
    [
      'a function-returned alias',
      'const startInstance={};const getOwner=()=>startInstance;getOwner().getOptions=()=>fetch("https://invalid.example");export{startInstance};',
    ],
  ])('rejects startInstance mutation through %s', (_label, source) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/start-AAAAAAAA.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('ignores a shadowed owner mutation inside an unrelated function', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={};const unrelated=(startInstance)=>{startInstance={}};export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('pins a runtime consumer that mutates startInstance through a parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};const mutate=(target)=>{target.compromised=()=>1};mutate(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const startInstance={};const mutate=(target)=>{target.compromised=()=>fetch("https://invalid.example")};mutate(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('pins transitive runtime consumers of a reviewed owner parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};const inner=(target)=>{target.compromised=()=>1};const outer=(target)=>inner(target);outer(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const startInstance={};const inner=(target)=>{target.compromised=()=>fetch("https://invalid.example")};const outer=(target)=>inner(target);outer(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    [
      'builtin',
      'const startInstance={};const consume=()=>{String(startInstance);return 1};consume();export{startInstance};',
      'const startInstance={};const consume=()=>{String(startInstance);return 2};consume();export{startInstance};',
    ],
    [
      'member',
      'const startInstance={};const sink={consume:()=>1};const consume=()=>{sink.consume(startInstance);return 1};consume();export{startInstance};',
      'const startInstance={};const sink={consume:()=>1};const consume=()=>{sink.consume(startInstance);return 2};consume();export{startInstance};',
    ],
  ])(
    'pins an invoked containing owner before ignoring its %s consumer',
    (_label, trustedSource, substitutedSource) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(root, startPath, trustedSource);
      const startOwnerClosure = emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );

      write(root, startPath, substitutedSource);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareTanStackOwnerDigests: {
            ...fixtureTanStackOwnerDigests,
            startOwnerClosure,
          },
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must use the reviewed startInstance artifact owner closure');
    }
  );

  it('pins a top-level local method that consumes a reviewed owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink={consume(value){return value}};const startInstance={};sink.consume(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink.consume(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    [
      'named',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance={};sink.consume(startInstance);export{startInstance};',
      'const sink={consume(value){return value}};export{sink};',
      'const sink={consume(value){value.compromised=true;return value}};export{sink};',
    ],
    [
      'default',
      'import sink from"./sink-AAAAAAAA.js";const startInstance={};sink.consume(startInstance);export{startInstance};',
      'const sink={consume(value){return value}};export{sink as default};',
      'const sink={consume(value){value.compromised=true;return value}};export{sink as default};',
    ],
    [
      'namespace',
      'import*as receivers from"./sink-AAAAAAAA.js";const startInstance={};receivers.sink.consume(startInstance);export{startInstance};',
      'const sink={consume(value){return value}};export{sink};',
      'const sink={consume(value){value.compromised=true;return value}};export{sink};',
    ],
  ])(
    'pins a manifest-backed %s-import receiver that consumes a reviewed owner',
    (_kind, startSource, trustedSink, substitutedSink) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      const sinkPath = 'dist/server/assets/sink-AAAAAAAA.js';
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['src/start.ts'].imports = ['_sink-AAAAAAAA.js'];
      manifest['_sink-AAAAAAAA.js'] = {
        file: 'assets/sink-AAAAAAAA.js',
        imports: [],
        name: 'sink',
      };
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      write(root, startPath, startSource);
      write(root, sinkPath, trustedSink);
      const startOwnerClosure = emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );

      write(root, sinkPath, substitutedSink);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareTanStackOwnerDigests: {
            ...fixtureTanStackOwnerDigests,
            startOwnerClosure,
          },
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must use the reviewed startInstance artifact owner closure');
    }
  );

  it('pins a local tag that consumes a reviewed owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink=(strings,value)=>value;const startInstance={};sink`x${startInstance}`;export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const sink=(strings,value)=>{value.compromised=true;return value};const startInstance={};sink`x${startInstance}`;export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    [
      'named',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance={};sink`x${startInstance}`;export{startInstance};',
      'const sink=(strings,value)=>value;export{sink};',
      'const sink=(strings,value)=>{value.compromised=true;return value};export{sink};',
    ],
    [
      'default',
      'import sink from"./sink-AAAAAAAA.js";const startInstance={};sink`x${startInstance}`;export{startInstance};',
      'const sink=(strings,value)=>value;export{sink as default};',
      'const sink=(strings,value)=>{value.compromised=true;return value};export{sink as default};',
    ],
    [
      'namespace',
      'import*as receivers from"./sink-AAAAAAAA.js";const startInstance={};receivers.sink`x${startInstance}`;export{startInstance};',
      'const sink=(strings,value)=>value;export{sink};',
      'const sink=(strings,value)=>{value.compromised=true;return value};export{sink};',
    ],
  ])(
    'pins a manifest-backed %s-import tag that consumes a reviewed owner',
    (_kind, startSource, trustedSink, substitutedSink) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      const sinkPath = 'dist/server/assets/sink-AAAAAAAA.js';
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['src/start.ts'].imports = ['_sink-AAAAAAAA.js'];
      manifest['_sink-AAAAAAAA.js'] = {
        file: 'assets/sink-AAAAAAAA.js',
        imports: [],
        name: 'sink',
      };
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      write(root, startPath, startSource);
      write(root, sinkPath, trustedSink);
      const startOwnerClosure = emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );

      write(root, sinkPath, substitutedSink);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareTanStackOwnerDigests: {
            ...fixtureTanStackOwnerDigests,
            startOwnerClosure,
          },
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must use the reviewed startInstance artifact owner closure');
    }
  );

  it.each([
    ['call callback', 'sink(()=>startInstance)'],
    ['constructor callback', 'new sink(()=>startInstance)'],
    ['tag callback', 'sink`x${()=>startInstance}`'],
    ['top-level callback owner', 'const read=()=>startInstance;sink(read)'],
    ['object callback payload', 'sink({read:()=>startInstance})'],
  ])('pins an imported consumer reached through a %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    ['call', 'mystery(()=>startInstance)'],
    ['constructor', 'new Mystery(()=>startInstance)'],
    ['tag', 'mystery`x${()=>startInstance}`'],
  ])(
    'rejects a callback owner escape through an unresolved %s',
    (_label, execution) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `const startInstance={};${execution};export{startInstance};`
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must not escape to an unresolved runtime consumer');
    }
  );

  it.each([
    ['an assignment alias', 'let alias;alias=startInstance;sink(alias)'],
    ['a conditional alias', 'const alias=true?startInstance:{};sink(alias)'],
    ['an indexed array alias', 'const alias=[startInstance][0];sink(alias)'],
  ])('pins an imported consumer reached through %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    ['a block-local payload alias', '{const alias=startInstance;sink(alias)}'],
    ['a block-local target alias', '{const local=sink;local(startInstance)}'],
    [
      'a for-of assignment alias',
      'let alias={};for(alias of [startInstance])sink(alias)',
    ],
  ])('pins an imported consumer reached through %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('keeps unrelated statements out of a block-local consumer digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;const unrelated=1;sink(startInstance)}export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;const unrelated=2;sink(startInstance)}export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps nested shadow mutations out of an outer lexical binding digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;{let sink;sink=()=>1}sink(startInstance)}export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;{let sink;sink=()=>2}sink(startInstance)}export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    ['call result', 'const load=()=>startInstance;sink(load())'],
    [
      'constructed result',
      'class Box{constructor(){return startInstance}}sink(new Box())',
    ],
    ['tag result', 'const tag=()=>startInstance;sink(tag``)'],
    [
      'local collection roundtrip',
      'const store=new Map();store.set("x",startInstance);sink(store.get("x"))',
    ],
  ])('pins an imported consumer reached through a %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    [
      'function-scoped var',
      'const run=()=>{var alias=startInstance;sink(alias)};run()',
    ],
    [
      'catch binding',
      'const run=()=>{try{throw startInstance}catch(alias){sink(alias)}};run()',
    ],
    [
      'object binding default',
      '{const {value:alias=startInstance}={};sink(alias)}',
    ],
    ['array binding default', '{const [alias=startInstance]=[];sink(alias)}'],
    [
      'assignment binding default',
      '{let alias;({value:alias=startInstance}={});sink(alias)}',
    ],
    ['parameter default', 'const run=(alias=startInstance)=>sink(alias);run()'],
    [
      'destructured parameter default',
      'const run=({value:alias=startInstance}={})=>sink(alias);run()',
    ],
    ['for-of declaration', 'for(const alias of [startInstance])sink(alias)'],
    [
      'destructured for-of declaration',
      'for(const {value:alias} of [{value:startInstance}])sink(alias)',
    ],
  ])('pins an imported consumer reached through a %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('does not attribute for-in keys to values in the iterated object', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const sink=(value)=>value;const startInstance={};for(const alias in {value:startInstance})sink(alias);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps unrelated caller declarations out of an imported consumer digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'import{sink}from"./sink-AAAAAAAA.js";const unrelated=1;const startInstance={};sink(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'import{sink}from"./sink-AAAAAAAA.js";const unrelated=2;const startInstance={};sink(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a shadowed caller binding from pulling in an unrelated top-level owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const startSource = (unrelatedValue) =>
      `import{store,load}from"./sink-AAAAAAAA.js";const alias=${unrelatedValue};function run(){let alias;alias=load();return alias}const startInstance={};store(startInstance);run();export{startInstance};`;
    write(root, startPath, startSource(1));
    addCloudflareSinkModule(
      root,
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;export{load,store};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(root, startPath, startSource(2));

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'interaction order',
      'store(startInstance);load()',
      'load();store(startInstance)',
    ],
    [
      'control-flow guard',
      'if(true)sink(startInstance)',
      'if(false)sink(startInstance)',
    ],
  ])(
    'pins imported-consumer caller %s',
    (_label, trustedExecution, substitutedExecution) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(
        root,
        startPath,
        `import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};${trustedExecution};export{startInstance};`
      );
      addCloudflareSinkModule(
        root,
        'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};'
      );
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        startPath,
        `import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};${substitutedExecution};export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('pins the imported export selected by a consumer binding', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'import{sink as consume}from"./sink-AAAAAAAA.js";const startInstance={};consume(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'const sink=(value)=>value;const evil=(value)=>{value.compromised=true;return value};export{evil,sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'import{evil as consume}from"./sink-AAAAAAAA.js";const startInstance={};consume(startInstance);export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    [
      'named callback',
      'const callback=(value)=>value;on(callback)',
      'const callback=(value)=>{value.compromised=true;return value};on(callback)',
    ],
    [
      'object callback',
      'const callbacks={receive:(value)=>value};on(callbacks.receive)',
      'const callbacks={receive:(value)=>{value.compromised=true;return value}};on(callbacks.receive)',
    ],
    [
      'transitive callback holder',
      'const callback=(value)=>value;const callbacks={receive:callback};on(callbacks.receive)',
      'const callback=(value)=>{value.compromised=true;return value};const callbacks={receive:callback};on(callbacks.receive)',
    ],
    [
      'block-local consumer chain',
      '{const read=load;const value=read();sink(value)}',
      '{const read=load;const value=read();value.compromised=true;sink(value)}',
    ],
  ])(
    'pins a stateful imported consumer reached through a %s',
    (_label, trustedRegistration, substitutedRegistration) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      const sinkSource =
        'let callback=(value)=>value;let stored;const on=(next)=>{callback=next};const emit=(value)=>callback(value);const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{emit,load,on,sink,store};';
      write(
        root,
        startPath,
        `import{emit,load,on,sink,store}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);${trustedRegistration};emit(startInstance);export{startInstance};`
      );
      addCloudflareSinkModule(root, sinkSource);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        startPath,
        `import{emit,load,on,sink,store}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);${substitutedRegistration};emit(startInstance);export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it.each([
    [
      'call receiver',
      'sink.consume(startInstance)',
      'sink.consume=(value)=>{value.compromised=true;return value};sink.consume(startInstance)',
      'const sink={consume(value){return value}};export{sink};',
    ],
    [
      'constructor receiver',
      'new sink.Consumer(startInstance)',
      'sink.Consumer=class{constructor(value){value.compromised=true;return value}};new sink.Consumer(startInstance)',
      'const sink={Consumer:class{constructor(value){return value}}};export{sink};',
    ],
    [
      'tag receiver',
      'sink.tag`x${startInstance}`',
      'sink.tag=(strings,value)=>{value.compromised=true;return value};sink.tag`x${startInstance}`',
      'const sink={tag:(strings,value)=>value};export{sink};',
    ],
  ])(
    'pins a local mutation of an imported %s',
    (_label, trustedExecution, substitutedExecution, sinkSource) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(
        root,
        startPath,
        `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${trustedExecution};export{startInstance};`
      );
      addCloudflareSinkModule(root, sinkSource);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        startPath,
        `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${substitutedExecution};export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('rejects reviewed owner storage on the global object', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const sink=(value)=>value;const startInstance={};globalThis.slot=startInstance;sink(globalThis.slot);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /(?:must not escape to an unresolved runtime consumer|rejects a replaced intrinsic global)/u
    );
  });

  it('rejects reviewed owner storage on an imported object', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{store,sink}from"./sink-AAAAAAAA.js";const startInstance={};store.slot=startInstance;sink(store.slot);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'const store={};const sink=(value)=>value;export{sink,store};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /(?:must not escape to an unresolved runtime consumer|rejects a replaced intrinsic global)/u
    );
  });

  it.each([
    [
      'shared store implementation',
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};',
      'let stored;const store=(value)=>{stored=value};const load=()=>{stored.compromised=true;return stored};const sink=(value)=>value;export{load,sink,store};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();sink(alias);export{startInstance};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();sink(alias);export{startInstance};',
    ],
    [
      'shared store caller',
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};',
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();sink(alias);export{startInstance};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();alias.compromised=true;sink(alias);export{startInstance};',
    ],
    [
      'registered callback',
      'let callback=(value)=>value;const on=(next)=>{callback=next};const emit=(value)=>callback(value);export{emit,on};',
      'let callback=(value)=>value;const on=(next)=>{callback=(value)=>{value.compromised=true;return next(value)}};const emit=(value)=>callback(value);export{emit,on};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>value);const startInstance={};emit(startInstance);export{startInstance};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>value);const startInstance={};emit(startInstance);export{startInstance};',
    ],
    [
      'registered caller callback',
      'let callback=(value)=>value;const on=(next)=>{callback=next};const emit=(value)=>callback(value);export{emit,on};',
      'let callback=(value)=>value;const on=(next)=>{callback=next};const emit=(value)=>callback(value);export{emit,on};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>value);const startInstance={};emit(startInstance);export{startInstance};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>{value.compromised=true;return value});const startInstance={};emit(startInstance);export{startInstance};',
    ],
  ])(
    'pins stateful cross-export interactions through the %s',
    (_label, trustedSink, substitutedSink, trustedStart, substitutedStart) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(root, startPath, trustedStart);
      addCloudflareSinkModule(root, trustedSink);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(root, startPath, substitutedStart);
      write(root, 'dist/server/assets/sink-AAAAAAAA.js', substitutedSink);

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it.each([
    [
      'named',
      'import{sink as String}from"./sink-AAAAAAAA.js";',
      'function sink(value){return value}export{sink};',
      'function sink(value){value.compromised=true;return value}export{sink};',
    ],
    [
      'default',
      'import String from"./sink-AAAAAAAA.js";',
      'function sink(value){return value}export{sink as default};',
      'function sink(value){value.compromised=true;return value}export{sink as default};',
    ],
  ])(
    'does not trust a %s import that collides with an ambient consumer',
    (_label, importSource, trustedSink, substitutedSink) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `${importSource}const startInstance={};String(startInstance);export{startInstance};`
      );
      addCloudflareSinkModule(root, trustedSink);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(root, 'dist/server/assets/sink-AAAAAAAA.js', substitutedSink);

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it.each([
    [
      'String',
      'class String{constructor(value){return value}}',
      'class String{constructor(value){value.compromised=true;return value}}',
    ],
    [
      'URL',
      'class URL{constructor(value){return value}}',
      'class URL{constructor(value){value.compromised=true;return value}}',
    ],
  ])(
    'pins a local %s class instead of trusting its ambient name',
    (name, trustedClass, substitutedClass) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `${trustedClass};const startInstance={};new ${name}(startInstance);export{startInstance};`
      );
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `${substitutedClass};const startInstance={};new ${name}(startInstance);export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('rejects an ambient consumer after its global implementation is overridden', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'globalThis.String=(value)=>value;const startInstance={};String(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /(?:rejects a replaced intrinsic global|must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading))/u
    );
  });

  it('rejects an ambient consumer after a constant-key global override', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const key="String";globalThis[key]=(value)=>value;const startInstance={};String(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /(?:rejects a replaced intrinsic global|must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading))/u
    );
  });

  it.each([
    ['global alias', 'const root=globalThis;root.String=(value)=>value'],
    ['self member', 'self.String=(value)=>value'],
    ['window member', 'window.String=(value)=>value'],
    [
      'object assignment pattern',
      '({String:globalThis.String}={String:(value)=>value})',
    ],
    ['array assignment pattern', '[globalThis.String]=[(value)=>value]'],
    [
      'for-of assignment target',
      'for(globalThis.String of [(value)=>value]){}',
    ],
    ['Reflect.set on self', 'Reflect.set(self,"String",(value)=>value)'],
    [
      'Object.defineProperty on self',
      'Object.defineProperty(self,"String",{value:(value)=>value})',
    ],
    [
      'legacy getter installation',
      'self.__defineGetter__("String",()=>value=>value)',
    ],
  ])('rejects an ambient consumer after a %s override', (_label, override) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `${override};const startInstance={};String(startInstance);export{startInstance};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /(?:rejects a replaced intrinsic global|must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading))/u
    );
  });

  it.each([
    [
      'Promise method assignment',
      'Promise.resolve=(value)=>value;const startInstance={};Promise.resolve(startInstance);export{startInstance};',
    ],
    [
      'Intl constructor assignment',
      'Intl.Collator=class{constructor(value){return value}};const startInstance={};new Intl.Collator(startInstance);export{startInstance};',
    ],
    [
      'String tag assignment',
      'String.raw=(strings,value)=>value;const startInstance={};String.raw`x${startInstance}`;export{startInstance};',
    ],
    [
      'ambient descriptor installation',
      'Object.defineProperty(Promise,"resolve",{value:(value)=>value});const startInstance={};Promise.resolve(startInstance);export{startInstance};',
    ],
  ])('rejects a reviewed owner after %s', (_label, source) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/start-AAAAAAAA.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading)/u
    );
  });

  it.each([
    [
      'call alias',
      'globalThis.JSON={stringify(value){return String(value)}};const consumer=JSON.stringify;const startInstance={};consumer(startInstance);export{startInstance};',
    ],
    [
      'constructor alias',
      'globalThis.Intl={Collator:class{constructor(value){return value}}};const Consumer=Intl.Collator;const startInstance={};new Consumer(startInstance);export{startInstance};',
    ],
    [
      'tag alias',
      'globalThis.String={raw:(strings,value)=>value};const tag=String.raw;const startInstance={};tag`x${startInstance}`;export{startInstance};',
    ],
  ])('preserves ambient provenance through a %s', (_label, source) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/start-AAAAAAAA.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /(?:must not escape to an unresolved runtime consumer|rejects a replaced intrinsic global)/u
    );
  });

  it('pins helper-based global descriptor installation for ambient consumers', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const descriptors=(value)=>value;Object.defineProperties(globalThis,descriptors({Temporal:{value:{}}}));const startInstance={};Boolean(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const descriptors=(value)=>({...value,Boolean:{value:()=>false}});Object.defineProperties(globalThis,descriptors({Temporal:{value:{}}}));const startInstance={};Boolean(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /(?:must use the reviewed startInstance artifact owner closure|must not execute fetch, eval, or worker effects while loading|rejects a replaced intrinsic global Boolean)/u
    );
  });

  it('allows a symbol-keyed global cache without weakening ambient provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const key=Symbol.for("cache");globalThis[key]={};const startInstance={};Boolean(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('pins the assigned result of an owner-consuming execution', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};let escaped;escaped=Promise.resolve(startInstance);escaped.then(value=>value);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};let escaped;escaped=Promise.resolve(startInstance);escaped.then(value=>{value.compromised=true;return value});export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('pins a block-local consumer with a shadowing top-level name', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};{const sink=(value)=>value;sink(startInstance)}export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};{const sink=(value)=>{value.compromised=true;return value};sink(startInstance)}export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    [
      'method alias',
      'const sink={consume(value){return value}};const consume=sink.consume;const startInstance={};consume(startInstance);export{startInstance};',
      'const sink={consume(value){value.compromised=true;return value}};const consume=sink.consume;const startInstance={};consume(startInstance);export{startInstance};',
    ],
    [
      'Function.call',
      'const sink={consume(value){return value}};const startInstance={};sink.consume.call(null,startInstance);export{startInstance};',
      'const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink.consume.call(null,startInstance);export{startInstance};',
    ],
    [
      'Function.apply',
      'const sink={consume(value){return value}};const startInstance={};sink.consume.apply(null,[startInstance]);export{startInstance};',
      'const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink.consume.apply(null,[startInstance]);export{startInstance};',
    ],
    [
      'computed selector',
      'const key="consume";const sink={consume(value){return value}};const startInstance={};sink[key](startInstance);export{startInstance};',
      'const key="consume";const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink[key](startInstance);export{startInstance};',
    ],
    [
      'Reflect.construct',
      'function Sink(value){return value}const startInstance={};Reflect.construct(Sink,[startInstance]);export{startInstance};',
      'function Sink(value){value.compromised=true;return value}const startInstance={};Reflect.construct(Sink,[startInstance]);export{startInstance};',
    ],
  ])(
    'pins a reviewed owner passed through %s',
    (_label, trusted, substituted) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(root, startPath, trusted);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(root, startPath, substituted);

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('preserves identical owner-consuming execution occurrences', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};sink(startInstance);sink(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};sink(startInstance);export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('pins an inline class that consumes a reviewed owner', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};new(class{constructor(value){return value}})(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};new(class{constructor(value){value.compromised=true;return value}})(startInstance);export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('does not attribute a called helper parameter shadow to startInstance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};const unrelated=(startInstance)=>{startInstance.compromised=()=>1};unrelated({});export{startInstance};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      startPath,
      'const startInstance={};const unrelated=(startInstance)=>{startInstance.compromised=()=>2};unrelated({});export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a parameter-shadowed top-level helper outside getRouter reachability', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerPath = 'dist/server/assets/router-AAAAAAAA.js';
    write(
      root,
      routerPath,
      'const shadowedHelper=()=>1;function getRouter(shadowedHelper=()=>({cspNonce:undefined})){return shadowedHelper()}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      routerPath,
      'const shadowedHelper=()=>2;function getRouter(shadowedHelper=()=>({cspNonce:undefined})){return shadowedHelper()}export{getRouter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          routerLocalClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps function-body var bindings out of default-parameter scope', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerPath = 'dist/server/assets/router-AAAAAAAA.js';
    write(
      root,
      routerPath,
      'const helper=()=>1;function getRouter(value=helper){var helper=()=>0;return{cspNonce:value()}}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      routerPath,
      'const helper=()=>2;function getRouter(value=helper){var helper=()=>0;return{cspNonce:value()}}export{getRouter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          routerLocalClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('keeps a nested free helper reference in getRouter reachability', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerPath = 'dist/server/assets/router-AAAAAAAA.js';
    write(
      root,
      routerPath,
      'const nestedHelper=()=>1;function getRouter(){return()=>nestedHelper()}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      routerPath,
      'const nestedHelper=()=>2;function getRouter(){return()=>nestedHelper()}export{getRouter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          routerLocalClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects a synchronized imported getRouter owner substitution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>undefined;export{importedNonce};'
    );
    write(
      root,
      relativePath,
      `import{importedNonce}from"./router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-helper-AAAAAAAA.js'] = {
      file: 'assets/router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['src/router.tsx'].imports = ['_router-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>fetch("https://invalid.example");export{importedNonce};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('keeps reachable owner identities stable when an unrelated name collides', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>undefined;export{importedNonce};'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    write(
      root,
      'dist/server/assets/unrelated-helper-AAAAAAAA.js',
      'const unrelated=true;export{unrelated};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-helper-AAAAAAAA.js'] = {
      file: 'assets/router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['_unrelated-helper-AAAAAAAA.js'] = {
      file: 'assets/unrelated-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['src/router.tsx'].imports = ['_router-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('pins a default-imported getRouter helper implementation', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>undefined;export{importedNonce as default};'
    );
    write(
      root,
      routerRelativePath,
      `import importedNonce from"./router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-helper-AAAAAAAA.js'] = {
      file: 'assets/router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['src/router.tsx'].imports = ['_router-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>fetch("https://invalid.example");export{importedNonce as default};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('does not hard-code app-owned behavior into framework owner digests', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'const importedNonce=()=>1;export{importedNonce};'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./app-router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/example/router-helper.ts'] = {
      file: 'assets/app-router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
      src: 'src/modules/example/router-helper.ts',
    };
    manifest['src/router.tsx'].imports = [
      'src/modules/example/router-helper.ts',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'const importedNonce=()=>fetch("https://example.test/nonce");export{importedNonce};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('traverses from a reviewed owner through an app-only child into non-app code', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'import"./router-vendor-AAAAAAAA.js";const importedNonce=()=>1;export{importedNonce};'
    );
    write(
      root,
      'dist/server/assets/router-vendor-AAAAAAAA.js',
      'const vendorValue=1;export{vendorValue};'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./app-router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/example/router-helper.ts'] = {
      file: 'assets/app-router-helper-AAAAAAAA.js',
      imports: ['_router-vendor-AAAAAAAA.js'],
      name: 'router-helper',
      src: 'src/modules/example/router-helper.ts',
    };
    manifest['_router-vendor-AAAAAAAA.js'] = {
      file: 'assets/router-vendor-AAAAAAAA.js',
      imports: [],
      name: 'router-vendor',
    };
    manifest['src/router.tsx'].imports = [
      'src/modules/example/router-helper.ts',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/app-router-helper-AAAAAAAA.js', [
      'src/modules/example/router-helper.ts',
    ]);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-vendor-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rescans an earlier shallow chunk after a later caller invokes its export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'const importedNonce=()=>1;export{importedNonce};'
    );
    write(
      root,
      'dist/server/assets/late-callee-AAAAAAAA.js',
      'const danger=()=>undefined;export{danger};'
    );
    write(
      root,
      'dist/server/assets/late-caller-AAAAAAAA.js',
      'import{danger}from"./late-callee-AAAAAAAA.js";danger();'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./app-router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/example/router-helper.ts'] = {
      file: 'assets/app-router-helper-AAAAAAAA.js',
      imports: ['_late-caller-AAAAAAAA.js', '_late-callee-AAAAAAAA.js'],
      name: 'router-helper',
      src: 'src/modules/example/router-helper.ts',
    };
    manifest['_late-caller-AAAAAAAA.js'] = {
      file: 'assets/late-caller-AAAAAAAA.js',
      imports: ['_late-callee-AAAAAAAA.js'],
      name: 'late-caller',
    };
    manifest['_late-callee-AAAAAAAA.js'] = {
      file: 'assets/late-callee-AAAAAAAA.js',
      imports: [],
      name: 'late-callee',
    };
    manifest['src/router.tsx'].imports = [
      'src/modules/example/router-helper.ts',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/app-router-helper-AAAAAAAA.js', [
      'src/modules/example/router-helper.ts',
    ]);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    write(
      root,
      'dist/server/assets/late-callee-AAAAAAAA.js',
      'const danger=()=>fetch("https://invalid.example");export{danger};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('follows a namespace-imported load-effect owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'const run=()=>undefined;export{run};'
    );
    write(
      root,
      routerRelativePath,
      `import*as effects from"./router-effect-AAAAAAAA.js";effects.run();${fs.readFileSync(
        routerPath,
        'utf8'
      )}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-effect-AAAAAAAA.js'] = {
      file: 'assets/router-effect-AAAAAAAA.js',
      imports: [],
      name: 'router-effect',
    };
    manifest['src/router.tsx'].imports = ['_router-effect-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/router-effect-AAAAAAAA.js', [
      'src/router-effect.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'const run=()=>fetch("https://invalid.example");export{run};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a cross-chunk load effect invoked by a dynamic owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'const run=()=>fetch("https://invalid.example");export{run};'
    );
    write(
      root,
      relativePath,
      `import{run}from"./router-effect-AAAAAAAA.js";run();${fs.readFileSync(
        routerPath,
        'utf8'
      )}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-effect-AAAAAAAA.js'] = {
      file: 'assets/router-effect-AAAAAAAA.js',
      imports: [],
      name: 'router-effect',
    };
    manifest['src/router.tsx'].imports = ['_router-effect-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/router-effect-AAAAAAAA.js', [
      'src/router-effect.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    [
      'callback',
      'import{make}from"./router-effect-AAAAAAAA.js";make()();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>evil;export{make};',
    ],
    [
      'object method',
      'import{make}from"./router-effect-AAAAAAAA.js";make().run();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>({run:evil});export{make};',
    ],
    [
      'array member',
      'import{make}from"./router-effect-AAAAAAAA.js";make()[0]();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>[evil];export{make};',
    ],
    [
      'nested callback',
      'import{make}from"./router-effect-AAAAAAAA.js";make()()();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>()=>evil;export{make};',
    ],
    [
      'nested object method',
      'import{make}from"./router-effect-AAAAAAAA.js";make().create()();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>({create:()=>evil});export{make};',
    ],
    [
      'constructor callback',
      'import{Factory}from"./router-effect-AAAAAAAA.js";(new Factory())();',
      'function Factory(){return()=>fetch("https://invalid.example")}export{Factory};',
    ],
    [
      'constructor object method',
      'import{Factory}from"./router-effect-AAAAAAAA.js";new Factory().run();',
      'function Factory(){return{run:()=>fetch("https://invalid.example")}}export{Factory};',
    ],
    [
      'tagged-template callback',
      'import{tag}from"./router-effect-AAAAAAAA.js";tag``();',
      'const tag=()=>()=>fetch("https://invalid.example");export{tag};',
    ],
    [
      'tagged-template object method',
      'import{tag}from"./router-effect-AAAAAAAA.js";tag``.run();',
      'const tag=()=>({run:()=>fetch("https://invalid.example")});export{tag};',
    ],
  ])(
    'rejects a cross-chunk factory-returned %s load effect',
    (_label, caller, owner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      addCloudflareRouterEffectModule(root, caller, owner);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it('tracks an explicit callable capture through a cross-chunk factory', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>undefined)();',
      'const make=(effect)=>()=>effect();export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'direct imported callback storage',
      'import{store}from"./router-effect-AAAAAAAA.js";store(()=>fetch("https://invalid.example"));',
      'const store=effect=>({effect});export{store};',
    ],
    [
      'factory-result callback storage',
      'import{make}from"./router-effect-AAAAAAAA.js";make().store(()=>fetch("https://invalid.example"));',
      'const make=()=>({store:effect=>({effect})});export{make};',
    ],
    [
      'nested callback storage',
      'import{configure}from"./router-effect-AAAAAAAA.js";configure({onError:()=>fetch("https://invalid.example")});',
      'const configure=options=>({options});export{configure};',
    ],
  ])('keeps a callback dormant through %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a callback dormant through a destructured cross-chunk factory owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{withForm}from"./router-effect-AAAAAAAA.js";withForm({render:()=>fetch("https://invalid.example"),props:{}});',
      'const useField=()=>{const field=getUnknown();return{...field}};function createFactory({components}){function withForm({render,props}){return function Render(inner){return render({...props,...inner})}}return{withForm,components}}const{withForm}=createFactory({components:{useField}});export{withForm};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects a callback invoked by a destructured cross-chunk factory owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{consume}from"./router-effect-AAAAAAAA.js";consume({render:()=>fetch("https://invalid.example")});',
      'const useField=()=>{const field=getUnknown();return{...field}};function createFactory({components}){function consume({render}){return render()}return{consume,components}}const{consume}=createFactory({components:{useField}});export{consume};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch');
  });

  it.each([
    [
      'a direct imported consumer',
      'import{consume}from"./router-effect-AAAAAAAA.js";consume(()=>fetch("https://invalid.example"));',
      'const consume=effect=>effect();export{consume};',
    ],
    [
      'an imported factory-result consumer',
      'import{make}from"./router-effect-AAAAAAAA.js";make().consume(()=>fetch("https://invalid.example"));',
      'const make=()=>({consume:effect=>effect()});export{make};',
    ],
    [
      'an imported nested callback consumer',
      'import{configure}from"./router-effect-AAAAAAAA.js";configure({onError:()=>fetch("https://invalid.example")});',
      'const configure=options=>options.onError();export{configure};',
    ],
  ])('rejects a callback invoked by %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('accepts safe root and terminal callbacks for an imported factory-result consumer', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>0).consume(()=>0);',
      'const make=root=>({consume:terminal=>{root();terminal()}});export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps an uncaptured imported factory root callback dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>fetch("https://invalid.example"))();',
      'const make=_effect=>()=>0;export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'root callback',
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>fetch("https://invalid.example")).consume(()=>0);',
    ],
    [
      'terminal callback',
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>0).consume(()=>fetch("https://invalid.example"));',
    ],
  ])('keeps the imported factory-result %s distinct', (_label, caller) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      caller,
      'const make=root=>({consume:terminal=>{root();terminal()}});export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    [
      'a function-local imported alias',
      'import{consume}from"./router-effect-AAAAAAAA.js";function run(effect){const invoke=consume;invoke(effect)}run(()=>fetch("https://invalid.example"));',
      'const consume=effect=>effect();export{consume};',
    ],
    [
      'a destructured namespace alias',
      'import*as owner from"./router-effect-AAAAAAAA.js";function run(effect){const{consume:invoke}=owner;invoke(effect)}run(()=>fetch("https://invalid.example"));',
      'const consume=effect=>effect();export{consume};',
    ],
    [
      'an imported factory-result alias',
      'import{make}from"./router-effect-AAAAAAAA.js";function run(effect){const service=make(),invoke=service.consume;invoke(effect)}run(()=>fetch("https://invalid.example"));',
      'const make=()=>({consume:effect=>effect()});export{make};',
    ],
  ])('rejects a callback invoked through %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    [
      'a function-local imported factory alias',
      'import{make}from"./router-effect-AAAAAAAA.js";function run(){const alias=make;alias(()=>fetch("https://invalid.example"))()}run();',
      'const make=effect=>()=>effect();export{make};',
    ],
    [
      'a function-local imported factory member alias',
      'import{make}from"./router-effect-AAAAAAAA.js";function run(){const alias=make;alias(()=>fetch("https://invalid.example")).consume()}run();',
      'const make=effect=>({consume:()=>effect()});export{make};',
    ],
    [
      'a function-local imported factory constructor alias',
      'import{Factory}from"./router-effect-AAAAAAAA.js";function run(){const Alias=Factory;(new Alias())()}run();',
      'function Factory(){return()=>fetch("https://invalid.example")}export{Factory};',
    ],
    [
      'a function-local imported tagged factory alias',
      'import{tag}from"./router-effect-AAAAAAAA.js";function run(){const alias=tag;alias``()}run();',
      'const tag=()=>()=>fetch("https://invalid.example");export{tag};',
    ],
    [
      'a nested imported factory origin',
      'import{consume,make}from"./router-effect-AAAAAAAA.js";consume(make(()=>fetch("https://invalid.example")))();',
      'const make=effect=>()=>effect(),consume=action=>()=>action();export{consume,make};',
    ],
    [
      'a stored nested imported factory origin',
      'import{consume,make}from"./router-effect-AAAAAAAA.js";const nested=make(()=>fetch("https://invalid.example"));consume(nested)();',
      'const make=effect=>()=>effect(),consume=action=>()=>action();export{consume,make};',
    ],
    [
      'the hazardous second nested imported factory sibling',
      'import{compose,make}from"./router-effect-AAAAAAAA.js";compose(make(()=>0),make(()=>fetch("https://invalid.example")))();',
      'const make=effect=>()=>effect(),compose=(_first,second)=>()=>second();export{compose,make};',
    ],
    [
      'the hazardous first nested imported factory sibling',
      'import{compose,make}from"./router-effect-AAAAAAAA.js";compose(make(()=>fetch("https://invalid.example")),make(()=>0))();',
      'const make=effect=>()=>effect(),compose=(first,_second)=>()=>first();export{compose,make};',
    ],
    [
      'a two-level nested imported factory origin',
      'import{consume,wrap,make}from"./router-effect-AAAAAAAA.js";consume(wrap(make(()=>fetch("https://invalid.example"))))();',
      'const make=effect=>()=>effect(),wrap=action=>()=>action(),consume=action=>()=>action();export{consume,wrap,make};',
    ],
    [
      'the hazardous first two-level nested imported factory sibling',
      'import{consume,wrap,make}from"./router-effect-AAAAAAAA.js";consume(wrap(make(()=>fetch("https://invalid.example")),make(()=>0)))();',
      'const make=effect=>()=>effect(),wrap=(first,_second)=>()=>first(),consume=action=>()=>action();export{consume,wrap,make};',
    ],
    [
      'a two-level nested imported factory member path',
      'import{consume,wrap,make}from"./router-effect-AAAAAAAA.js";consume(wrap(make(()=>fetch("https://invalid.example")))).run();',
      'const make=effect=>()=>effect(),wrap=action=>()=>action(),consume=action=>({run:()=>action()});export{consume,wrap,make};',
    ],
    [
      'a three-level nested imported factory origin',
      'import{consume,outer,inner,make}from"./router-effect-AAAAAAAA.js";consume(outer(inner(make(()=>fetch("https://invalid.example")))))();',
      'const make=effect=>()=>effect(),inner=action=>()=>action(),outer=action=>()=>action(),consume=action=>()=>action();export{consume,outer,inner,make};',
    ],
  ])('rejects a callback invoked through %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('keeps an unused hazardous imported factory sibling dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{compose,make}from"./router-effect-AAAAAAAA.js";compose(make(()=>fetch("https://invalid.example")),make(()=>0))();',
      'const make=effect=>()=>effect(),compose=(_first,second)=>()=>second();export{compose,make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('accepts a consumed nested imported factory without a load effect', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{consume,make}from"./router-effect-AAAAAAAA.js";consume(make(()=>0))();',
      'const make=effect=>()=>effect(),consume=action=>()=>action();export{consume,make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps an unused two-level hazardous factory sibling dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{consume,wrap,make}from"./router-effect-AAAAAAAA.js";consume(wrap(make(()=>fetch("https://invalid.example")),make(()=>0)))();',
      'const make=effect=>()=>effect(),wrap=(_first,second)=>()=>second(),consume=action=>()=>action();export{consume,wrap,make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('executes a nested root callback while preserving a terminal callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{consume,make}from"./router-effect-AAAAAAAA.js";consume(make(()=>fetch("https://invalid.example")))(()=>0);',
      'const make=effect=>()=>effect(),consume=action=>terminal=>{action();terminal()};export{consume,make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('ignores an unused nested root callback while preserving a terminal callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{consume,make}from"./router-effect-AAAAAAAA.js";consume(make(()=>fetch("https://invalid.example")))(()=>0);',
      'const make=effect=>()=>effect(),consume=_action=>terminal=>terminal();export{consume,make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a dormant nested imported factory call site inert', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{consume,wrap,make}from"./router-effect-AAAAAAAA.js";const dormant=wrap(make(()=>fetch("https://invalid.example")));consume(()=>0)();void dormant;',
      'const make=effect=>()=>effect(),wrap=action=>()=>action(),consume=action=>()=>action();export{consume,wrap,make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  const localSharedFactoryDagSource = (layerCount) => {
    const layers = [
      'const layer0=make(()=>0);',
      ...Array.from(
        { length: layerCount },
        (_unused, index) =>
          `const layer${index + 1}=fan(layer${index},layer${index});`
      ),
    ].join('');
    return `const make=effect=>()=>effect(),fan=(left,right)=>()=>{left();right()},consume=action=>()=>action();${layers}consume(layer${layerCount})();`;
  };

  it.each([8, 10])(
    'accepts a bounded local shared factory DAG with %s layers',
    (layerCount) => {
      expect(
        inspectCloudflareLoadEffectsForTesting(
          localSharedFactoryDagSource(layerCount)
        )
      ).toEqual([]);
    }
  );

  it('fails at the target-resolution depth bound for a 14-layer local shared factory DAG', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(localSharedFactoryDagSource(14))
    ).toThrow('bounded target candidate resolution depth');
  });

  it('clears bounded factory specializations after repeated analyses', () => {
    const runs = inspectCloudflareFactorySpecializationLifecycleForTesting(
      localSharedFactoryDagSource(10),
      3
    );

    expect(runs).toHaveLength(3);
    expect(runs.every(({ effects }) => effects.length === 0)).toBe(true);
    expect(runs.every(({ clearCount }) => clearCount === 1)).toBe(true);
    expect(runs.every(({ entriesAfterClear }) => entriesAfterClear === 0)).toBe(
      true
    );
    expect(
      runs.every(({ inProgressAfterClear }) => inProgressAfterClear === 0)
    ).toBe(true);
    expect(runs.every(({ peakEntries }) => peakEntries > 0)).toBe(true);
    expect(runs.every(({ peakEntries }) => peakEntries <= 1_024)).toBe(true);
  });

  const verifySharedNestedImportedFactoryDag = (
    leaf,
    layerCount = 8,
    cloudflareOriginFactStats
  ) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const layers = [
      `const layer0=make(${leaf});`,
      ...Array.from(
        { length: layerCount },
        (_unused, index) =>
          `const layer${index + 1}=fan(layer${index},layer${index});`
      ),
    ].join('');
    addCloudflareRouterEffectModule(
      root,
      `import{consume,fan,make}from"./router-effect-AAAAAAAA.js";${layers}consume(layer${layerCount})();`,
      'const make=effect=>()=>effect(),fan=(left,right)=>()=>{left();right()},consume=action=>()=>action();export{consume,fan,make};'
    );
    return () =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareOriginFactStats,
        expectedAppSlug: 'acme-app',
      });
  };

  it('rejects a shared nested imported factory DAG without duplicate fact expansion', () => {
    expect(
      verifySharedNestedImportedFactoryDag(
        '()=>fetch("https://invalid.example")'
      )
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  }, 10_000);

  it('accepts a safe shared nested imported factory DAG without duplicate fact expansion', () => {
    expect(verifySharedNestedImportedFactoryDag('()=>0')).not.toThrow();
  }, 10_000);

  it('bounds a deep shared nested imported factory DAG by unique work', () => {
    const stats = {};

    expect(
      verifySharedNestedImportedFactoryDag('()=>0', 18, stats)
    ).not.toThrow();
    expect(stats).toMatchObject({ cacheHits: expect.any(Number) });
    expect(stats.cacheHits).toBeGreaterThan(0);
    expect(stats.uniqueFacts).toBeLessThanOrEqual(stats.attemptedFacts);
    expect(stats.work).toBeLessThan(1_024);
  }, 10_000);

  it('rejects a consumed nested factory callback in a non-app owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{consume,make}from"./router-effect-AAAAAAAA.js";consume(make(()=>fetch("https://invalid.example")))();',
      'const make=effect=>()=>effect(),consume=action=>()=>action();export{consume,make};',
      null
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    [
      'a destructured factory owner',
      'import{consume}from"./router-effect-AAAAAAAA.js";consume(()=>fetch("https://invalid.example"));',
      'function create(){if(flag)return{consume:effect=>({effect})};return getUnknown()}const{consume}=create();export{consume};',
      'rejects unresolved destructured factory branches',
    ],
    [
      'a returned factory owner',
      'import{make}from"./router-effect-AAAAAAAA.js";make().consume(()=>fetch("https://invalid.example"));',
      'function make(){if(flag)return{consume:effect=>({effect})};return getUnknown()}export{make};',
      'rejects unresolved imported factory branches',
    ],
  ])(
    'fails closed for an unresolved branch in %s',
    (_label, caller, owner, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      addCloudflareRouterEffectModule(root, caller, owner);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it('tracks a callback owner through a destructured factory result', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const create=()=>({store:effect=>({effect})}),{store}=create();store(()=>fetch("https://invalid.example"));';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/destructured-factory-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'an imported class instance whose methods remain dormant',
      'import{Runner}from"./router-effect-AAAAAAAA.js";const runner=new Runner();',
      'class Runner{run(){fetch("https://invalid.example")}}export{Runner};',
    ],
    [
      'an imported direct aggregate spread',
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      'const selectors={ready:true};export{selectors};',
    ],
  ])('accepts %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('accepts an aggregate only through the exact reviewed read-only sink', () => {
    const root = createReviewedAggregateSinkArtifact({
      consumerSource:
        'import{Ar as selectors}from"./aggregate-owner-AAAAAAAA.js";import{c as useRenderElement}from"./aggregate-sink-AAAAAAAA.js";useRenderElement(null,null,{stateAttributesMapping:selectors});const copy={...selectors};',
      ownerSource:
        'import{c as useRenderElement}from"./aggregate-sink-AAAAAAAA.js";const selectors={ready:true};useRenderElement(null,null,{stateAttributesMapping:selectors});export{selectors as Ar};',
    });

    expect(inspectReviewedAggregateSinkArtifact(root)).toEqual([1]);
  });

  it.each([
    ['an alternate property', 'useRenderElement(null,null,{danger:selectors})'],
    [
      'a computed property',
      'useRenderElement(null,null,{["stateAttributesMapping"]:selectors})',
    ],
    [
      'a duplicate property',
      'useRenderElement(null,null,{stateAttributesMapping:selectors,stateAttributesMapping:selectors})',
    ],
    [
      'an intermediate options object',
      'const options={stateAttributesMapping:selectors};useRenderElement(null,null,options)',
    ],
    [
      'a second leaking property',
      'useRenderElement(null,null,{stateAttributesMapping:selectors,leak:selectors})',
    ],
    [
      'an escaped container property',
      'const consume=value=>value;const box={value:selectors};consume(box)',
    ],
    [
      'a shadowed sink parameter',
      'function relay(useRenderElement){useRenderElement(null,null,{stateAttributesMapping:selectors})}relay(()=>null)',
    ],
    [
      'a reassigned sink alias',
      'let sink=useRenderElement;sink=()=>null;sink(null,null,{stateAttributesMapping:selectors})',
    ],
    ['a local re-export', 'export{selectors}'],
    ['a direct aggregate mutation', 'Object.assign(selectors,{ready:false})'],
  ])('rejects aggregate laundering through %s', (_label, use) => {
    const root = createReviewedAggregateSinkArtifact({
      consumerSource: `import{Ar as selectors}from"./aggregate-owner-AAAAAAAA.js";import{c as useRenderElement}from"./aggregate-sink-AAAAAAAA.js";${use};const copy={...selectors};`,
      ownerSource:
        'import{c as useRenderElement}from"./aggregate-sink-AAAAAAAA.js";const selectors={ready:true};useRenderElement(null,null,{stateAttributesMapping:selectors});export{selectors as Ar};',
    });

    expect(inspectReviewedAggregateSinkArtifact(root)).toEqual([0]);
  });

  it('rejects an escaped default aggregate import', () => {
    const root = createReviewedAggregateSinkArtifact({
      consumerSource:
        'import selectors from"./aggregate-owner-AAAAAAAA.js";const consume=value=>value;consume(selectors);const copy={...selectors};',
      ownerSource:
        'import{c as useRenderElement}from"./aggregate-sink-AAAAAAAA.js";const selectors={ready:true};useRenderElement(null,null,{stateAttributesMapping:selectors});export{selectors as default};',
    });

    expect(inspectReviewedAggregateSinkArtifact(root)).toEqual([0]);
  });

  it('rejects an aggregate member call that can mutate its receiver', () => {
    const root = createReviewedAggregateSinkArtifact({
      consumerSource:
        'import{Ar as selectors}from"./aggregate-owner-AAAAAAAA.js";const copy={...selectors};',
      ownerSource:
        'const selectors={ready(){this.evil=()=>fetch("https://invalid.example")}};selectors.ready();export{selectors as Ar};',
    });

    expect(inspectReviewedAggregateSinkArtifact(root)).toEqual([0]);
  });

  it('resolves an authenticated enum-style imported member to its primitive value', () => {
    const root = createImportedStaticPrimitiveArtifact({
      consumerSource:
        'import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";var TooltipTriggerDataAttributes=function(TooltipTriggerDataAttributes){TooltipTriggerDataAttributes[TooltipTriggerDataAttributes["popupOpen"]=CommonTriggerDataAttributes.popupOpen]="popupOpen";return TooltipTriggerDataAttributes}({});',
      ownerSource:
        'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";CommonTriggerDataAttributes["pressed"]="data-pressed";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
    });

    expect(
      inspectImportedStaticPrimitiveArtifact(
        root,
        'CommonTriggerDataAttributes.popupOpen'
      )
    ).toEqual([['data-popup-open']]);
  });

  it.each([
    [
      'a shared receiver',
      'const shared={};var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}(shared);export{CommonTriggerDataAttributes as c};',
      [],
    ],
    [
      'an unresolved factory result',
      'const CommonTriggerDataAttributes=createUnknown();export{CommonTriggerDataAttributes as c};',
      [],
    ],
    [
      'an accessor member',
      'const CommonTriggerDataAttributes={get popupOpen(){return "data-popup-open"}};export{CommonTriggerDataAttributes as c};',
      [],
    ],
    [
      'a nonempty receiver literal',
      'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({existing:true});export{CommonTriggerDataAttributes as c};',
      [],
    ],
    [
      'a named function expression',
      'var CommonTriggerDataAttributes=function initialize(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
      [],
    ],
    [
      'a reassigned receiver parameter',
      'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes=globalThis;CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
      [],
    ],
    [
      'an alternate return value',
      'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return {popupOpen:"other"}}({});export{CommonTriggerDataAttributes as c};',
      [],
    ],
    [
      'a prior Object prototype setter',
      'Object.defineProperty(Object.prototype,"popupOpen",{set(){fetch("https://invalid.example")}});var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
      [],
    ],
  ])('rejects imported primitive proof through %s', (_label, ownerSource) => {
    const root = createImportedStaticPrimitiveArtifact({
      consumerSource:
        'import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";const value=CommonTriggerDataAttributes.popupOpen;',
      ownerSource,
    });

    expect(
      inspectImportedStaticPrimitiveArtifact(
        root,
        'CommonTriggerDataAttributes.popupOpen'
      )
    ).toEqual([[]]);
  });

  it('rejects imported primitive proof when another signed consumer mutates the export', () => {
    const root = createImportedStaticPrimitiveArtifact({
      consumerSource:
        'import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";const value=CommonTriggerDataAttributes.popupOpen;',
      extraConsumerSources: [
        'import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";CommonTriggerDataAttributes.popupOpen="changed";',
      ],
      ownerSource:
        'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
    });

    expect(
      inspectImportedStaticPrimitiveArtifact(
        root,
        'CommonTriggerDataAttributes.popupOpen'
      )
    ).toEqual([[]]);
  });

  it.each([
    [
      'an array-pattern member write',
      '[CommonTriggerDataAttributes.popupOpen]=["changed"]',
    ],
    [
      'a nested object-pattern default member write',
      '({value:{key:CommonTriggerDataAttributes.popupOpen="changed"}}={value:{}})',
    ],
    [
      'an array-rest member write',
      '[...CommonTriggerDataAttributes.popupOpen]=["changed"]',
    ],
    [
      'a for-in pattern member write',
      'for([CommonTriggerDataAttributes.popupOpen]in{changed:true}){}',
    ],
  ])(
    'rejects imported primitive proof when another signed consumer performs %s',
    (_label, mutation) => {
      const root = createImportedStaticPrimitiveArtifact({
        consumerSource:
          'import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";const value=CommonTriggerDataAttributes.popupOpen;',
        extraConsumerSources: [
          `import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";${mutation};`,
        ],
        ownerSource:
          'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
      });

      expect(
        inspectImportedStaticPrimitiveArtifact(
          root,
          'CommonTriggerDataAttributes.popupOpen'
        )
      ).toEqual([[]]);
    }
  );

  it('does not resolve a shadowed imported aggregate binding', () => {
    const root = createImportedStaticPrimitiveArtifact({
      consumerSource:
        'import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";const value=(function(CommonTriggerDataAttributes){return CommonTriggerDataAttributes.popupOpen})({popupOpen:"hostile"});',
      ownerSource:
        'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
    });

    expect(
      inspectImportedStaticPrimitiveArtifact(
        root,
        'CommonTriggerDataAttributes.popupOpen'
      )
    ).toEqual([[]]);
  });

  it('does not resolve an imported aggregate member invoked as a method', () => {
    const root = createImportedStaticPrimitiveArtifact({
      consumerSource:
        'import{c as CommonTriggerDataAttributes}from"./primitive-owner-AAAAAAAA.js";CommonTriggerDataAttributes.popupOpen();',
      ownerSource:
        'var CommonTriggerDataAttributes=function(CommonTriggerDataAttributes){CommonTriggerDataAttributes["popupOpen"]="data-popup-open";return CommonTriggerDataAttributes}({});export{CommonTriggerDataAttributes as c};',
    });

    expect(
      inspectImportedStaticPrimitiveArtifact(
        root,
        'CommonTriggerDataAttributes.popupOpen'
      )
    ).toEqual([[]]);
  });

  it('resolves an authenticated imported Symbol.for property key', () => {
    const root = createImportedStaticPrimitiveArtifact({
      consumerSource:
        'import{c as TSS_SERVER_FUNCTION}from"./primitive-owner-AAAAAAAA.js";const metadata={[TSS_SERVER_FUNCTION]:true};',
      ownerSource:
        'var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");export{TSS_SERVER_FUNCTION as c};',
    });

    expect(
      inspectCloudflareStaticPropertyKeysForTesting(
        root,
        'assets/primitive-consumer-AAAAAAAA.js',
        '[TSS_SERVER_FUNCTION]:true',
        fixtureCloudflareProvenanceKey,
        { includeSafety: true }
      )
    ).toEqual([
      {
        key: '\0symbol-for:"TSS_SERVER_FUNCTION"',
        safe: true,
      },
    ]);
  });

  it.each([
    [
      'a unique Symbol call',
      'var TSS_SERVER_FUNCTION=Symbol("TSS_SERVER_FUNCTION");export{TSS_SERVER_FUNCTION as c};',
    ],
    [
      'a reassigned owner binding',
      'var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");TSS_SERVER_FUNCTION=Symbol.for("changed");export{TSS_SERVER_FUNCTION as c};',
    ],
    [
      'a shadowed Symbol intrinsic',
      'const Symbol={for:()=>"not-a-symbol"};var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");export{TSS_SERVER_FUNCTION as c};',
    ],
    [
      'a string-returning factory',
      'var TSS_SERVER_FUNCTION=createKey("TSS_SERVER_FUNCTION");export{TSS_SERVER_FUNCTION as c};',
    ],
    [
      'an object-pattern binding write',
      'var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");({key:TSS_SERVER_FUNCTION}={key:"changed"});export{TSS_SERVER_FUNCTION as c};',
    ],
    [
      'an array-pattern default binding write',
      'var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");[TSS_SERVER_FUNCTION="changed"]=[];export{TSS_SERVER_FUNCTION as c};',
    ],
    [
      'an object-rest binding write',
      'var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");({...TSS_SERVER_FUNCTION}={changed:true});export{TSS_SERVER_FUNCTION as c};',
    ],
    [
      'a for-of pattern binding write',
      'var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");for([TSS_SERVER_FUNCTION]of[["changed"]]){}export{TSS_SERVER_FUNCTION as c};',
    ],
  ])(
    'rejects imported static symbol proof through %s',
    (_label, ownerSource) => {
      const root = createImportedStaticPrimitiveArtifact({
        consumerSource:
          'import{c as TSS_SERVER_FUNCTION}from"./primitive-owner-AAAAAAAA.js";const metadata={[TSS_SERVER_FUNCTION]:true};',
        ownerSource,
      });

      expect(
        inspectCloudflareStaticPropertyKeysForTesting(
          root,
          'assets/primitive-consumer-AAAAAAAA.js',
          '[TSS_SERVER_FUNCTION]:true',
          fixtureCloudflareProvenanceKey
        )
      ).toEqual([undefined]);
    }
  );

  it('does not resolve a shadowed imported Symbol.for binding', () => {
    const root = createImportedStaticPrimitiveArtifact({
      consumerSource:
        'import{c as TSS_SERVER_FUNCTION}from"./primitive-owner-AAAAAAAA.js";const metadata=(function(TSS_SERVER_FUNCTION){return {[TSS_SERVER_FUNCTION]:true}})("hostile");',
      ownerSource:
        'var TSS_SERVER_FUNCTION=Symbol.for("TSS_SERVER_FUNCTION");export{TSS_SERVER_FUNCTION as c};',
    });

    expect(
      inspectCloudflareStaticPropertyKeysForTesting(
        root,
        'assets/primitive-consumer-AAAAAAAA.js',
        '[TSS_SERVER_FUNCTION]:true',
        fixtureCloudflareProvenanceKey
      )
    ).toEqual([undefined]);
  });

  it.each([
    [
      'an imported class constructor effect',
      'import{Runner}from"./router-effect-AAAAAAAA.js";const runner=new Runner();',
      'class Runner{constructor(){fetch("https://invalid.example")}}export{Runner};',
      'must not execute fetch, eval, or worker effects while loading',
    ],
    [
      'an imported aggregate getter',
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      'const selectors={get ready(){fetch("https://invalid.example");return true}};export{selectors};',
      'rejects accessor properties in aggregate spreads',
    ],
    [
      'an imported aggregate with a nested spread',
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      'const base={ready:true},selectors={...base};export{selectors};',
      'requires statically analyzable aggregate spreads',
    ],
  ])('rejects %s', (_label, caller, owner, message) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(message);
  });

  it.each([
    [
      'a direct live-binding reassignment',
      'let selectors={ready:true};selectors={get ready(){fetch("https://invalid.example");return true}};export{selectors};',
    ],
    [
      'a destructured live-binding reassignment',
      'let selectors={ready:true};({selectors}={selectors:{get ready(){fetch("https://invalid.example");return true}}});export{selectors};',
    ],
  ])('rejects %s before an imported aggregate spread', (_label, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      owner
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    [
      'direct definition',
      'const selectors={ready:true};Object.defineProperty(selectors,"ready",{get(){fetch("https://invalid.example");return true}});export{selectors};',
    ],
    [
      'aliased assignment',
      'const selectors={ready:true},alias=selectors;Object.assign(alias,{get ready(){fetch("https://invalid.example");return true}});export{selectors};',
    ],
  ])('rejects imported aggregate mutation by %s', (_label, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      owner
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('keeps an imported Object.assign callable result dormant when stored', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";const handler=make(()=>fetch("https://invalid.example"));',
      'const make=(effect)=>Object.assign(effect,{kind:"handler"});export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('activates an imported Object.assign callable result when invoked', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>fetch("https://invalid.example"))();',
      'const make=(effect)=>Object.assign(effect,{kind:"handler"});export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('accepts the provably falsy branch of a logical-and spread', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const maybe=globalThis.optionalFeature&&{ready:true},copy={...maybe};';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/logical-and-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects an opaque logical-or aggregate spread branch', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const maybe=globalThis.optionalFeature||globalThis.options,copy={...maybe};';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/logical-or-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed for a cross-chunk factory result that captures a parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make()();',
      'const make=(effect=()=>fetch("https://invalid.example"))=>()=>effect();export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable cross-chunk factory captures');
  });

  it.each([
    ['non-app', null],
    ['mixed', ['src/router-effect.ts', 'node_modules/example/index.js']],
  ])(
    'deep-scans a factory result returned by an unreviewed %s chunk',
    (_label, modules) => {
      const root = fixture();
      createCloudflareArtifact(root);
      addCloudflareRouterEffectModule(
        root,
        'import{make}from"./router-effect-AAAAAAAA.js";make()();',
        'const evil=()=>fetch("https://invalid.example");const make=()=>evil;export{make};',
        modules
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it('rejects a side-effecting dynamic target owned by the router entry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${fs.readFileSync(routerPath, 'utf8')}const loadEvil=()=>import("./router-evil-AAAAAAAA.js");`
    );
    write(
      root,
      'dist/server/assets/router-evil-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-evil-AAAAAAAA.js'] = {
      file: 'assets/router-evil-AAAAAAAA.js',
      imports: [],
      name: 'router-evil',
    };
    manifest['src/router.tsx'].dynamicImports = ['_router-evil-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a nested side-effect import below a dynamic target', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      routerRelativePath,
      `${fs.readFileSync(routerPath, 'utf8')}const loadEvil=()=>import("./router-evil-AAAAAAAA.js");`
    );
    write(
      root,
      'dist/server/assets/router-evil-AAAAAAAA.js',
      'import"./nested-evil-AAAAAAAA.js";'
    );
    write(
      root,
      'dist/server/assets/nested-evil-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-evil-AAAAAAAA.js'] = {
      file: 'assets/router-evil-AAAAAAAA.js',
      imports: ['_nested-evil-AAAAAAAA.js'],
      name: 'router-evil',
    };
    manifest['_nested-evil-AAAAAAAA.js'] = {
      file: 'assets/nested-evil-AAAAAAAA.js',
      imports: [],
      name: 'nested-evil',
    };
    manifest['src/router.tsx'].dynamicImports = ['_router-evil-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a substituted startInstance owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={compromised:()=>fetch("https://invalid.example")};export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('rejects a substituted generated route manifest owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      'const tsrStartManifest=()=>({routes:{compromised:true}});export{tsrStartManifest};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack route manifest shape');
  });

  it('accepts inert TanStack boolean and undefined route-manifest data', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},children:void 0,scripts:[{attrs:{async:!0}}]}}});export{tsrStartManifest};`
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects a generated route file outside the active checkout', () => {
    const root = fixture();
    const foreignRoot = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    write(foreignRoot, 'src/routes/example.tsx');
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))}}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(foreignRoot, 'src/routes/example.tsx'))}}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack route manifest shape');
  });

  it('keeps generated route owner digests stable across checkout roots', () => {
    const digestForRoot = (root) => {
      createCloudflareArtifact(root);
      write(root, 'src/routes/example.tsx');
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
      );
      write(
        root,
        'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
        `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))}}}});export{tsrStartManifest};`
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      return emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );
    };

    expect(digestForRoot(fixture())).toBe(digestForRoot(fixture()));
  }, 15_000);

  it('pins src/routes-like strings outside the filePath field', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/trusted/src/routes/child"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/evil/src/routes/child"]}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('pins asset-like strings outside reviewed asset-bearing fields', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/assets/child-AAAAAAAA.js"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/assets/child-BBBBBBBB.js"]}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    ['a destructive unary value', 'scripts:delete globalThis.fetch'],
    ['a tagged-template value', 'preloads:[fetch`https://invalid.example`]'],
  ])('rejects %s in generated route-manifest data', (_label, fieldSource) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},${fieldSource}}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack route manifest shape');
  });

  it('rejects an eager side-effecting start dynamic target', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance=import("./start-evil-AAAAAAAA.js");export{startInstance};'
    );
    write(
      root,
      'dist/server/assets/start-evil-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_start-evil-AAAAAAAA.js'] = {
      file: 'assets/start-evil-AAAAAAAA.js',
      imports: [],
      name: 'start-evil',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-evil-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('pins the implementation closure of a start dynamic target', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={getOptions:async()=>{const{run}=await import("./start-helper-AAAAAAAA.js");return run()}};export{startInstance};'
    );
    write(
      root,
      'dist/server/assets/start-helper-AAAAAAAA.js',
      'const run=()=>undefined;export{run};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_start-helper-AAAAAAAA.js'] = {
      file: 'assets/start-helper-AAAAAAAA.js',
      imports: [],
      name: 'start-helper',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      startOwnerClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/start-helper-AAAAAAAA.js',
      'const run=()=>fetch("https://invalid.example");export{run};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('keeps a reviewed dynamic owner stable across content-identical chunk hashes', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const trustedHelper = 'start-helper-AAAAAAAA.js';
    const replacementHelper = 'start-helper-BBBBBBBB.js';
    write(
      root,
      startPath,
      `const startInstance={getOptions:async()=>{const{run}=await import("./${trustedHelper}");return run()}};export{startInstance};`
    );
    write(
      root,
      `dist/server/assets/${trustedHelper}`,
      'const run=()=>undefined;export{run};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_start-helper-AAAAAAAA.js'] = {
      file: `assets/${trustedHelper}`,
      imports: [],
      name: 'start-helper',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      startOwnerClosure,
    };

    write(
      root,
      startPath,
      fs
        .readFileSync(path.join(root, startPath), 'utf8')
        .replace(trustedHelper, replacementHelper)
    );
    write(
      root,
      `dist/server/assets/${replacementHelper}`,
      fs.readFileSync(
        path.join(root, 'dist/server/assets', trustedHelper),
        'utf8'
      )
    );
    fs.rmSync(path.join(root, 'dist/server/assets', trustedHelper));
    delete manifest['_start-helper-AAAAAAAA.js'];
    manifest['_start-helper-BBBBBBBB.js'] = {
      file: `assets/${replacementHelper}`,
      imports: [],
      name: 'start-helper',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-helper-BBBBBBBB.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a namespace consumer stable across content-identical dependency hashes', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const sinkPath = 'dist/server/assets/sink-AAAAAAAA.js';
    const trustedHelper = 'sink-helper-AAAAAAAA.js';
    const replacementHelper = 'sink-helper-BBBBBBBB.js';
    write(
      root,
      startPath,
      'import*as consumer from"./sink-AAAAAAAA.js";const startInstance={};consumer.sink(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      `import{identity}from"./${trustedHelper}";const sink=(value)=>identity(value);export{sink};`
    );
    write(
      root,
      `dist/server/assets/${trustedHelper}`,
      'const identity=(value)=>value;export{identity};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_sink-AAAAAAAA.js'].imports = ['_sink-helper-AAAAAAAA.js'];
    manifest['_sink-helper-AAAAAAAA.js'] = {
      file: `assets/${trustedHelper}`,
      imports: [],
      name: 'sink-helper',
    };
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      sinkPath,
      fs
        .readFileSync(path.join(root, sinkPath), 'utf8')
        .replace(trustedHelper, replacementHelper)
    );
    write(
      root,
      `dist/server/assets/${replacementHelper}`,
      fs.readFileSync(
        path.join(root, 'dist/server/assets', trustedHelper),
        'utf8'
      )
    );
    fs.rmSync(path.join(root, 'dist/server/assets', trustedHelper));
    delete manifest['_sink-helper-AAAAAAAA.js'];
    manifest['_sink-helper-BBBBBBBB.js'] = {
      file: `assets/${replacementHelper}`,
      imports: [],
      name: 'sink-helper',
    };
    manifest['_sink-AAAAAAAA.js'].imports = ['_sink-helper-BBBBBBBB.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('treats build-proven app-only chunks as source-governed owner boundaries', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance=sink({});export{startInstance};'
    );
    addCloudflareSinkModule(root, 'const sink=(value)=>value;export{sink};');
    markFixtureAppOwnedChunk(root, 'assets/sink-AAAAAAAA.js', [
      'src/modules/example/index.ts',
    ]);
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'const sink=(value)=>({...value});export{sink};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('does not trust an emitted app-source comment as chunk provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance=sink({});export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      '//#region src/modules/example/index.ts\nconst sink=(value)=>value;export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      '//#region src/modules/example/index.ts\nconst sink=(value)=>({...value});export{sink};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('isolates large generated owner analysis without weakening its digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance=sink({});export{startInstance};'
    );
    const padding = `/*${'x'.repeat(65_536)}*/`;
    addCloudflareSinkModule(
      root,
      `${padding}const sink=(value)=>value;export{sink};`
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      `${padding}const sink=(value)=>({...value});export{sink};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('rejects colliding manifest identities inside a namespace closure', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import*as consumer from"./sink-AAAAAAAA.js";const startInstance={};consumer.sink(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'import{first}from"./sink-helper-AAAAAAAA.js";import{second}from"./sink-helper-BBBBBBBB.js";const sink=(value)=>first(second(value));export{sink};'
    );
    write(
      root,
      'dist/server/assets/sink-helper-AAAAAAAA.js',
      'const first=(value)=>value;export{first};'
    );
    write(
      root,
      'dist/server/assets/sink-helper-BBBBBBBB.js',
      'const second=(value)=>value;export{second};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_sink-AAAAAAAA.js'].imports = [
      '_sink-helper-AAAAAAAA.js',
      '_sink-helper-BBBBBBBB.js',
    ];
    manifest['_sink-helper-AAAAAAAA.js'] = {
      file: 'assets/sink-helper-AAAAAAAA.js',
      imports: [],
      name: 'sink-helper',
    };
    manifest['_sink-helper-BBBBBBBB.js'] = {
      file: 'assets/sink-helper-BBBBBBBB.js',
      imports: [],
      name: 'sink-helper',
    };
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(/manifest identity .* maps to both/u);
  });

  it('normalizes a namespace-imported TanStack route manifest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    const routeManifestSource = (routeFile, firstAsset, secondAsset) =>
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(routeFile)},preloads:["/assets/${firstAsset}","/assets/${secondAsset}"]}}});export{tsrStartManifest};`;
    write(
      root,
      startPath,
      'import*as routeManifest from"./tanstack-start-manifest-AAAAAAAA.js";const startInstance={load:()=>routeManifest.tsrStartManifest()};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      routeManifestSource(
        path.join(root, 'src/routes/example.tsx'),
        'example-AAAAAAAA.js',
        'presentation-BBBBBBBB.js'
      )
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].imports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      manifestOwnerPath,
      routeManifestSource(
        path.join(root, 'src/routes/example.tsx'),
        'presentation-DDDDDDDD.js',
        'example-CCCCCCCC.js'
      )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps route-manifest asset hashes and preload order out of reviewed owner digests', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},preloads:["/assets/example-AAAAAAAA.js","/assets/presentation-CCCCCCCC.js"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      startOwnerClosure,
    };

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},preloads:["/assets/presentation-DDDDDDDD.js","/assets/example-BBBBBBBB.js"]}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps route-manifest preload ordering independent of the ambient locale', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},preloads:["/assets/I-AAAAAAAA.js","/assets/i-BBBBBBBB.js"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(ambientLocaleReviewDigest(root, 'en_US.UTF-8')).toBe(
      ambientLocaleReviewDigest(root, 'tr_TR.UTF-8')
    );
  });

  it('pins a non-literal dynamic import inside a reviewed router owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/router-AAAAAAAA.js',
      'const getRouterCspNonce=(source)=>import(source);function getRouter(){const cspNonce=getRouterCspNonce("node:crypto");return{cspNonce}}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-AAAAAAAA.js',
      'const getRouterCspNonce=(source)=>import(`${source}/promises`);function getRouter(){const cspNonce=getRouterCspNonce("node:fs");return{cspNonce}}export{getRouter};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects an eager non-literal import outside a reviewed owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${fs.readFileSync(routerPath, 'utf8')}const eagerRuntimeModule=import(globalThis.RUNTIME_MODULE);`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects a side-effect import owned by the dynamic router entry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `import"./router-effect-AAAAAAAA.js";${fs.readFileSync(routerPath, 'utf8')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-effect-AAAAAAAA.js'] = {
      file: 'assets/router-effect-AAAAAAAA.js',
      imports: [],
      name: 'router-effect',
    };
    manifest['src/router.tsx'].imports.push('_router-effect-AAAAAAAA.js');
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('reports a missing TanStack dynamic-import manifest list cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest['_server-fixture.js'].dynamicImports;
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve its reviewed TanStack dynamic owner graph');
  });

  it('rejects a dynamic import introduced below the reviewed closure root', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${fs.readFileSync(chunkPath, 'utf8')}const loadCycle=()=>import("../runtime/cycle-marker-AAAAAAAA.js");`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_createCsrfMiddleware-AAAAAAAA.js'].dynamicImports = [
      '_cycle-marker-AAAAAAAA.js',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack server static import closure');
  });

  it('reports BigInt changes through the reviewed owner diagnostic', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/empty-plugin-adapters-AAAAAAAA.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const bigintMarker=0n;${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed empty plugin adapters owner');
  });

  it('rejects an unreviewed external inside the reviewed static closure', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('import"node:stream"', 'import"unreviewed:runtime"')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack server static import closure');
  });

  it.each([
    [
      'lexical escape',
      '../../outside-BBBBBBBB.js',
      '../outside-BBBBBBBB.js',
      () => {},
      'Cloudflare app-owned provenance coverage',
    ],
    [
      'symlink escape',
      './cycle-marker-BBBBBBBB.js',
      'assets/cycle-marker-BBBBBBBB.js',
      (root) =>
        fs.symlinkSync(
          '../../outside-BBBBBBBB.js',
          path.join(root, 'dist/server/assets/cycle-marker-BBBBBBBB.js')
        ),
      'must be a regular artifact entry',
    ],
  ])(
    'rejects a %s inside the reviewed static closure',
    (
      _label,
      replacementSource,
      replacementFile,
      prepareEscape,
      expectedError
    ) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/outside-BBBBBBBB.js',
        'const serverCycleMarker=false;export{serverCycleMarker};'
      );
      prepareEscape(root);
      replaceManifestStaticEdge(root, {
        ownerFile: 'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js',
        ownerManifestKey: '_createCsrfMiddleware-AAAAAAAA.js',
        replacementEntry: {
          file: replacementFile,
          imports: [],
          name: 'cycle-marker',
        },
        replacementManifestKey: '_cycle-marker-BBBBBBBB.js',
        replacementSource,
        trustedManifestKey: '_cycle-marker-AAAAAAAA.js',
        trustedSource: '../runtime/cycle-marker-AAAAAAAA.js',
      });

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(expectedError);
    }
  );

  it('rejects a substituted React server renderer implementation', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/server.edge-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const require_server_edge=()=>({renderToReadableStream})',
          'const require_server_edge=()=>(globalThis.fetch("https://invalid.example"),{renderToReadableStream})'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must use the reviewed React server renderer static import closure'
    );
  });

  it.each([
    [
      'dist/server/assets/request-failure-fixture.js',
      '_request-failure-fixture.js',
    ],
    [
      'dist/server/assets/request-exception-state-fixture.js',
      '_request-exception-state-fixture.js',
    ],
    [
      'dist/server/assets/request-completion-fixture.js',
      '_request-completion-fixture.js',
    ],
    ['dist/server/assets/telemetry-fixture.js', '_telemetry-fixture.js'],
  ])(
    'rejects a manifest-backed untrusted helper import in %s',
    (relativePath, manifestKey) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/evil.js',
        'fetch("https://invalid.example");'
      );
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        `import"./evil.js";${fs.readFileSync(chunkPath, 'utf8')}`
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['_evil.js'] = {
        file: 'assets/evil.js',
        imports: [],
        name: 'evil',
      };
      manifest[manifestKey].imports.push('_evil.js');
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must import only its trusted static owner chunks');
    }
  );

  it.each([
    [
      'dist/server/assets/create-application-server-entry-fixture.js',
      'src/runtime/create-application-server-entry.ts',
      'must import exactly its trusted helper manifest records',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'must import only its trusted static owner chunks',
    ],
    [
      'dist/server/assets/backend-kernel-fixture.js',
      'src/modules/kernel/backend.ts',
      'must import only its trusted static owner chunks',
    ],
  ])(
    'rejects a manifest-backed untrusted static import in %s',
    (relativePath, manifestKey, expectedMessage) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/evil.js',
        'fetch("https://invalid.example");'
      );
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        `import"./evil.js";${fs.readFileSync(chunkPath, 'utf8')}`
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['_evil.js'] = {
        file: 'assets/evil.js',
        imports: [],
        name: 'evil',
      };
      manifest[manifestKey].imports.push('_evil.js');
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(expectedMessage);
    }
  );

  it.each([
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'fetch("https://invalid.example");',
    ],
    [
      'dist/server/assets/backend-kernel-fixture.js',
      'book-fixture.js',
      'book-evil-fixture.js',
      '_book-fixture.js',
      'src/modules/kernel/backend.ts',
      'fetch("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '(()=>fetch("https://invalid.example"))();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=()=>fetch("https://invalid.example");run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'export const run=()=>fetch("https://invalid.example");run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const fetchOwner=()=>fetch("https://invalid.example");const run=fetchOwner;run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'export default function run(){globalThis["fetch"]("https://invalid.example")}run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>globalThis["fetch"]("https://invalid.example");const alias=(effect);alias();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const box={run(){globalThis["fetch"]("https://invalid.example")}};box.run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '[()=>globalThis["fetch"]("https://invalid.example")][0]();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>globalThis["fetch"]("https://invalid.example");effect.bind(null)();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=globalThis["eval"];effect("void 0");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const Effect=globalThis["Function"];Effect("return undefined")();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '({run:()=>fetch("https://invalid.example")}).run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'globalThis.eval("void 0");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'new Function("return undefined")();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '(0,fetch)("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'fetch.call(null,"https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'globalThis["fetch"]("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'new (function(){fetch("https://invalid.example")})();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '(function(){fetch("https://invalid.example")})`x`;',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=()=>{const effect=globalThis.fetch;effect("https://invalid.example")};run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=({effect})=>effect();run({effect:()=>fetch("https://invalid.example")});',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=([effect])=>effect();run([()=>fetch("https://invalid.example")]);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(...effects)=>effects[0]();run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect)=>{const alias=effect;alias.call(null)};run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect)=>{const {handler:alias}={handler:effect};new alias()};run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect)=>{const alias=effect;alias`x`};run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const inner=({effect})=>effect();const outer=value=>inner({effect:value});outer(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();run.call(null,()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();run.apply(null,[()=>fetch("https://invalid.example")]);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(strings,effect)=>effect();run`x${()=>fetch("https://invalid.example")}`;',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run(undefined);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run(void 0);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>fetch("https://invalid.example"),payload={effect};const run=({effect})=>effect();run(payload);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>fetch("https://invalid.example"),payload=[effect];const run=([effect])=>effect();run(payload);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=options=>options.effect();run({effect:()=>fetch("https://invalid.example")});',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(...effects)=>effects[1]();run(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const runner={call(effect){effect()}};runner.call(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const invoke=run.call;invoke(null,()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const invoke=run.bind(null,()=>fetch("https://invalid.example"));invoke();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=({first,...rest})=>rest.effect();run({first:0,effect:()=>fetch("https://invalid.example")});',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=([first,...rest])=>rest[0]();run([undefined,()=>fetch("https://invalid.example")]);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const args=[()=>fetch("https://invalid.example")];run(...args);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const args=[()=>fetch("https://invalid.example")];run.apply(null,args);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const key="fetch";globalThis[key]("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const key="run",runner={run:()=>fetch("https://invalid.example")};runner[key]();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(object,key)=>object[key]();run({danger:()=>fetch("https://invalid.example")},"danger");',
    ],
  ])(
    'rejects a matching-family static chunk substitution in %s (%s -> %s; %s; %s; %s)',
    (
      ownerPath,
      trustedFile,
      substitutedFile,
      manifestKey,
      ownerManifestKey,
      executablePrefix
    ) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
      write(
        root,
        `dist/server/assets/${substitutedFile}`,
        `${executablePrefix}${fs.readFileSync(trustedPath, 'utf8')}`
      );
      const ownerFile = path.join(root, ownerPath);
      write(
        root,
        ownerPath,
        fs.readFileSync(ownerFile, 'utf8').replace(trustedFile, substitutedFile)
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const substitutedManifestKey = `_${substitutedFile}`;
      manifest[substitutedManifestKey] = {
        ...manifest[manifestKey],
        file: `assets/${substitutedFile}`,
      };
      const ownerImports = manifest[ownerManifestKey].imports;
      ownerImports.splice(
        ownerImports.indexOf(manifestKey),
        1,
        substitutedManifestKey
      );
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      markFixtureAppOwnedChunk(root, `assets/${substitutedFile}`, [
        'src/runtime/cloudflare/reviewed-load-owner.ts',
      ]);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it.each([
    [
      'dist/server/assets/create-application-server-entry-fixture.js',
      'must import only its trusted static owner chunks',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'must import only its trusted static owner chunks',
    ],
    [
      'dist/server/assets/request-failure-fixture.js',
      'must import only its trusted static owner chunks',
    ],
  ])('rejects a detached side-effect import in %s', (relativePath, message) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/evil.js',
      'fetch("https://invalid.example");'
    );
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `import"./evil.js";${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(message);
  });

  it('rejects a symlink escape from an exact static import graph', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const linkedPath = path.join(root, 'dist/server/assets/react-fixture.js');
    write(root, 'dist/outside-react.js', fs.readFileSync(linkedPath, 'utf8'));
    fs.rmSync(linkedPath);
    fs.symlinkSync('../../outside-react.js', linkedPath);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must be a regular artifact entry');
  });

  it.each([
    [
      'file',
      (root, external) => {
        write(external, 'evil.js', 'fetch("https://invalid.example");');
        fs.symlinkSync(
          path.join(external, 'evil.js'),
          path.join(root, 'dist/server/assets/runtime-plugin.js')
        );
      },
    ],
    [
      'directory',
      (root, external) => {
        write(external, 'evil/entry.js', 'fetch("https://invalid.example");');
        fs.symlinkSync(
          path.join(external, 'evil'),
          path.join(root, 'dist/server/assets/runtime-plugin'),
          'dir'
        );
      },
    ],
  ])(
    'rejects an unmanifested %s symlink after provenance signing',
    (_kind, prepareSymlink) => {
      const root = fixture();
      createCloudflareArtifact(root);
      writeFixtureCloudflareProvenance(root);
      const external = fixture();
      prepareSymlink(root, external);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
          cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must be a regular artifact entry');
    }
  );

  it.each(['js', 'map', 'txt'])(
    'rejects an ephemeral provenance key leaked into a .%s artifact',
    (extension) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        `dist/server/leaked-key.${extension}`,
        fixtureCloudflareProvenanceKey
      );
      writeFixtureCloudflareProvenance(root);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
          cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
          expectedAppSlug: 'acme-app',
          forbiddenArtifactSecrets: [fixtureCloudflareProvenanceKey],
        })
      ).toThrow('contains a build secret');
    }
  );

  it.each([
    ['entry-server', 'tanstack'],
    ['telemetry-entry', 'telemetryProxy'],
  ])('rejects a detached dynamic %s owner chunk', (ownerFile, ownerName) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const sourceRelativePath = `dist/server/assets/${ownerFile}-fixture.js`;
    const sourcePath = path.join(root, sourceRelativePath);
    const decoyFile = `${ownerFile}-decoy.js`;
    write(
      root,
      `dist/server/assets/${decoyFile}`,
      fs.readFileSync(sourcePath, 'utf8')
    );
    const applicationRelativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const applicationPath = path.join(root, applicationRelativePath);
    write(
      root,
      applicationRelativePath,
      fs
        .readFileSync(applicationPath, 'utf8')
        .replace(`${ownerFile}-fixture.js`, decoyFile)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must originate from ${dynamicOwnerSourceNames[ownerName]}`);
  });

  it('rejects a detached application dynamic-import manifest edge', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/runtime/create-application-server-entry.ts'].dynamicImports =
      ['src/platform/telemetry/index.ts'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve its exact Vite dynamic import graph');
  });

  it('rejects a shadowed crypto owner in the universal entry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const crypto={randomUUID:()=>"fixed"};${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted crypto built-in');
  });

  it.each(['globalThis', 'window', 'global'])(
    'rejects %s access in the Worker entry module',
    (globalAlias) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const entryPath = path.join(root, 'dist/server/index.js');
      write(
        root,
        'dist/server/index.js',
        `${globalAlias}.Response=class{};${fs.readFileSync(entryPath, 'utf8')}`
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must not access alternate global built-ins');
    }
  );

  it('rejects an extra top-level Worker module import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      `await import("./assets/evil.js");${fs.readFileSync(entryPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must contain only its bounded Cloudflare module ownership sequence'
    );
  });

  it('reports forbidden Worker Response access accurately', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      `new Response();${fs.readFileSync(entryPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not access the Response built-in');
  });

  it('rejects a non-object Vite manifest cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeJson(root, 'dist/server/.vite/manifest.json', []);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain a Vite manifest object');
  });

  it.each([
    [
      'Reflect.apply',
      'const transform=effect=>Reflect.apply(effect,null,[])',
      'effect',
    ],
    [
      'Reflect.construct',
      'const transform=Effect=>Reflect.construct(Effect,[])',
      'Effect',
    ],
    [
      'Function.prototype.call',
      'const transform=effect=>effect.call(null)',
      'effect',
    ],
    [
      'Function.prototype.apply',
      'const transform=effect=>effect.apply(null,[])',
      'effect',
    ],
  ])(
    'classifies a callable parameter invoked through %s',
    (_label, source, name) => {
      expect(
        inspectCloudflareInvokedParameterProjectionsForTesting(
          source,
          'transform'
        )
      ).toEqual([{ name, path: [] }]);
    }
  );

  it.each([
    [
      'Reflect.apply.call',
      'const transform=effect=>Reflect.apply.call(null,effect,null,[])',
      'effect',
    ],
    [
      'Reflect.apply.apply',
      'const transform=effect=>Reflect.apply.apply(null,[effect,null,[]])',
      'effect',
    ],
    [
      'Function.prototype.call.call',
      'const transform=effect=>Function.prototype.call.call(effect,null)',
      'effect',
    ],
    [
      'Function.prototype.apply.call',
      'const transform=effect=>Function.prototype.apply.call(effect,null,[])',
      'effect',
    ],
  ])(
    'classifies a callable parameter invoked through nested %s',
    (_label, source, name) => {
      expect(
        inspectCloudflareInvokedParameterProjectionsForTesting(
          source,
          'transform'
        )
      ).toEqual([{ name, path: [] }]);
    }
  );

  it.each([
    'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}Reflect.apply(mutate,null,[]);target.run();',
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};Reflect.apply(api.mutate,api,[]);target.run();',
    'const target={run:()=>0};Reflect.construct(class{constructor(){target.run=()=>fetch("https://invalid.example")}},[]);target.run();',
    'const target={run:()=>0};function Factory(){target.run=()=>fetch("https://invalid.example")}Reflect.construct.call(null,Factory,[]);target.run();',
    'const target={run:()=>0};function Factory(){target.run=()=>fetch("https://invalid.example")}Reflect.construct.apply(null,[Factory,[]]);target.run();',
    'const target={run:()=>0};function Factory(){target.run=()=>fetch("https://invalid.example")}Reflect.apply(Reflect.construct,null,[Factory,[]]);target.run();',
  ])('orders a mutation invoked through Reflect', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0},source={get value(){target.run=()=>fetch("https://invalid.example");return 1}};source.value;target.run();',
    'const target={run:()=>0},source={set value(next){target.run=()=>fetch("https://invalid.example")}};source.value=1;target.run();',
    'const target={run:()=>0};function tag(){target.run=()=>fetch("https://invalid.example")}tag`value`;target.run();',
    'const target={run:()=>0};const proxy=new Proxy({},{get(){target.run=()=>fetch("https://invalid.example");return 1}});proxy.value;target.run();',
    'const target={run:()=>0};function* generate(){target.run=()=>fetch("https://invalid.example")}const iterator=generate();iterator.next();target.run();',
    'const target={run:()=>0};function* generate(){target.run=()=>fetch("https://invalid.example")}const iterator=generate();for(const value of iterator){}target.run();',
    'const target={run:()=>0};class Source{value=(target.run=()=>fetch("https://invalid.example"))}new Source();target.run();',
    'const target={run:()=>0};class Source{value=(()=>{target.run=()=>fetch("https://invalid.example")})()}new Source();target.run();',
  ])('orders a mutation from a synchronous implicit invocation', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'assignment apply',
      'const handler={apply(){return 0}},proxy=new Proxy(()=>0,handler);handler.apply=()=>fetch("https://invalid.example");proxy()',
    ],
    [
      'defineProperty apply',
      'const handler={apply(){return 0}},proxy=new Proxy(()=>0,handler);Object.defineProperty(handler,"apply",{value:()=>fetch("https://invalid.example")});proxy()',
    ],
    [
      'Object.assign apply',
      'const handler={apply(){return 0}},proxy=new Proxy(()=>0,handler);Object.assign(handler,{apply:()=>fetch("https://invalid.example")});proxy()',
    ],
    [
      'Object.create apply',
      'const handler=Object.create({apply(){return fetch("https://invalid.example")}}),proxy=new Proxy(()=>0,handler);proxy()',
    ],
    [
      'literal prototype apply',
      'const handler={__proto__:{apply(){return fetch("https://invalid.example")}}},proxy=new Proxy(()=>0,handler);proxy()',
    ],
    [
      'class apply',
      'class Handler{apply(){return fetch("https://invalid.example")}}const proxy=new Proxy(()=>0,new Handler());proxy()',
    ],
    [
      'assignment get',
      'const handler={get(){return 0}},proxy=new Proxy({},handler);handler.get=()=>fetch("https://invalid.example");proxy.value',
    ],
    [
      'inherited get',
      'const handler=Object.create({get(){return fetch("https://invalid.example")}}),proxy=new Proxy({},handler);proxy.value',
    ],
    [
      'transparent static get',
      'const target={run:()=>fetch("https://invalid.example")},handler={get(target){return target.run}},proxy=new Proxy(target,handler);proxy.run()',
    ],
    [
      'transparent computed get',
      'const target={run:()=>fetch("https://invalid.example")},handler={get(target,key){return target[key]}},proxy=new Proxy(target,handler);proxy.run()',
    ],
    [
      'transparent computed get executes target getter',
      'const target={get value(){fetch("https://invalid.example");return 1}},handler={get(target,key){return target[key]}},proxy=new Proxy(target,handler);proxy.value',
    ],
    [
      'Reflect.get executes target getter',
      'const target={get value(){fetch("https://invalid.example");return 1}},handler={get(target,key,receiver){return Reflect.get(target,key,receiver)}},proxy=new Proxy(target,handler);proxy.value',
    ],
    [
      'default get forwarding',
      'const proxy=new Proxy({run:()=>fetch("https://invalid.example")},{});proxy.run()',
    ],
    [
      'default set forwarding',
      'const proxy=new Proxy({set value(next){fetch("https://invalid.example")}},{}) ;proxy.value=1',
    ],
    [
      'set trap assignment',
      'const proxy=new Proxy({}, {set(){fetch("https://invalid.example");return true}});proxy.value=1',
    ],
    [
      'replaced set trap',
      'const handler={set(){return true}},proxy=new Proxy({},handler);handler.set=()=>{fetch("https://invalid.example");return true};proxy.value=1',
    ],
    [
      'inherited set trap',
      'const handler=Object.create({set(){fetch("https://invalid.example");return true}}),proxy=new Proxy({},handler);proxy.value=1',
    ],
    [
      'set trap getter',
      'const handler={get set(){fetch("https://invalid.example");return ()=>true}},proxy=new Proxy({},handler);proxy.value=1',
    ],
    [
      'absent set trap getter',
      'const handler={get set(){fetch("https://invalid.example")}},proxy=new Proxy({},handler);proxy.value=1',
    ],
    [
      'set trap assigned value',
      'const proxy=new Proxy({}, {set(_target,_key,value){value();return true}});proxy.value=()=>fetch("https://invalid.example")',
    ],
    [
      'set trap Reflect.set',
      'const proxy=new Proxy({}, {set(){fetch("https://invalid.example");return true}});Reflect.set(proxy,"value",1)',
    ],
    [
      'set trap Reflect.set assigned value',
      'const proxy=new Proxy({}, {set(_target,_key,value){value();return true}});Reflect.set(proxy,"value",()=>fetch("https://invalid.example"))',
    ],
    [
      'set trap update',
      'const proxy=new Proxy({value:0}, {set(){fetch("https://invalid.example");return true}});proxy.value++',
    ],
    [
      'revocable get forwarding',
      'const proxy=Proxy.revocable({get value(){fetch("https://invalid.example");return 1}},{}).proxy;proxy.value',
    ],
    [
      'revocable set forwarding',
      'const proxy=Proxy.revocable({set value(next){fetch("https://invalid.example")}},{}).proxy;proxy.value=1',
    ],
    [
      'deleteProperty trap',
      'const proxy=new Proxy({value:1},{deleteProperty(){fetch("https://invalid.example");return true}});delete proxy.value',
    ],
    [
      'Reflect.deleteProperty trap',
      'const proxy=new Proxy({value:1},{deleteProperty(){fetch("https://invalid.example");return true}});Reflect.deleteProperty(proxy,"value")',
    ],
    [
      'defineProperty trap',
      'const proxy=new Proxy({},{defineProperty(){fetch("https://invalid.example");return true}});Object.defineProperty(proxy,"value",{value:1})',
    ],
    [
      'ownKeys trap',
      'const proxy=new Proxy({},{ownKeys(){fetch("https://invalid.example");return []}});Reflect.ownKeys(proxy)',
    ],
    [
      'Object.keys ownKeys trap',
      'const proxy=new Proxy({},{ownKeys(){fetch("https://invalid.example");return []}});Object.keys(proxy)',
    ],
    [
      'getOwnPropertyDescriptor trap',
      'const proxy=new Proxy({},{getOwnPropertyDescriptor(){fetch("https://invalid.example")}});Object.getOwnPropertyDescriptor(proxy,"value")',
    ],
    [
      'has trap',
      'const proxy=new Proxy({},{has(){fetch("https://invalid.example");return false}});"value" in proxy',
    ],
    [
      'Reflect.has trap',
      'const proxy=new Proxy({},{has(){fetch("https://invalid.example");return false}});Reflect.has(proxy,"value")',
    ],
    [
      'getPrototypeOf trap',
      'const proxy=new Proxy({},{getPrototypeOf(){fetch("https://invalid.example");return null}});Object.getPrototypeOf(proxy)',
    ],
    [
      'deleteProperty trap getter',
      'const proxy=new Proxy({},{get deleteProperty(){fetch("https://invalid.example");return ()=>true}});delete proxy.value',
    ],
    [
      'get trap compound assignment',
      'const proxy=new Proxy({value:0}, {get(){fetch("https://invalid.example");return 0},set(){return true}});proxy.value+=1',
    ],
    [
      'get trap logical assignment',
      'const proxy=new Proxy({value:0}, {get(){fetch("https://invalid.example");return 0},set(){return true}});proxy.value||=1',
    ],
  ])('resolves the current Proxy trap (%s)', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('fails closed for a Proxy handler with a replaced prototype', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const handler={},proxy=new Proxy(()=>0,handler);Object.setPrototypeOf(handler,{apply(){return fetch("https://invalid.example")}});proxy()'
      )
    ).toThrow('rejects opaque aggregate member mutations');
  });

  it('forwards Proxy construction when the construct trap is absent', () => {
    const source =
      'class Target{constructor(){fetch("https://invalid.example")}}const ProxyTarget=new Proxy(Target,{});new ProxyTarget()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('uses the current Proxy apply trap after a safe overwrite', () => {
    const source =
      'const handler={apply(){return fetch("https://invalid.example")}},proxy=new Proxy(()=>0,handler);handler.apply=()=>0;proxy()';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('uses the current Proxy set trap after a safe overwrite', () => {
    const source =
      'const handler={set(){fetch("https://invalid.example");return true}},proxy=new Proxy({},handler);handler.set=()=>true;proxy.value=1';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'apply trap',
      'const target=()=>fetch("https://invalid.example"),proxy=new Proxy(target,{apply(){return 1}});proxy()',
    ],
    [
      'construct trap',
      'class Target{constructor(){fetch("https://invalid.example")}}const ProxyTarget=new Proxy(Target,{construct(){return {}}});new ProxyTarget()',
    ],
    [
      'revocable apply trap',
      'const target=()=>fetch("https://invalid.example"),proxy=Proxy.revocable(target,{apply(){return 1}}).proxy;proxy()',
    ],
    [
      'Function.prototype.call through apply trap',
      'const target=()=>fetch("https://invalid.example"),proxy=new Proxy(target,{apply(){return 1}});proxy.call(null)',
    ],
    [
      'Reflect.apply through apply trap',
      'const target=()=>fetch("https://invalid.example"),proxy=new Proxy(target,{apply(){return 1}});Reflect.apply(proxy,null,[])',
    ],
    [
      'assigned safe construct trap',
      'class Target{}const handler={construct(){fetch("https://invalid.example");return {}}},ProxyTarget=new Proxy(Target,handler);handler.construct=(target,args,newTarget)=>Reflect.construct(target,args,newTarget);new ProxyTarget()',
    ],
    [
      'Reflect.set safe construct trap',
      'class Target{}const handler={construct(){fetch("https://invalid.example");return {}}},ProxyTarget=new Proxy(Target,handler);Reflect.set(handler,"construct",(target,args,newTarget)=>Reflect.construct(target,args,newTarget));new ProxyTarget()',
    ],
    [
      'own construct shadows inherited trap',
      'class Target{}const prototype={construct(){fetch("https://invalid.example");return {}}},handler=Object.create(prototype),ProxyTarget=new Proxy(Target,handler);handler.construct=(target,args,newTarget)=>Reflect.construct(target,args,newTarget);new ProxyTarget()',
    ],
  ])('does not execute a suppressed Proxy target (%s)', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'const target={run:()=>0};function* generate(){target.run=()=>fetch("https://invalid.example")}const iterator=generate();target.run();for(const value of iterator){}',
    'const target={run:()=>0};class Source{value=(target.run=()=>fetch("https://invalid.example"))}target.run();',
  ])('keeps a later or dormant implicit mutation inactive', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'const arguments_={get length(){fetch("https://invalid.example");return 0}};Reflect.construct(function(){},arguments_)',
    'const arguments_={length:1,get 0(){fetch("https://invalid.example");return 1}};Reflect.construct(function(){},arguments_)',
  ])('models Reflect.construct ArrayLike accessors', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const arguments_={get length(){fetch("https://invalid.example");return 0}};Reflect.apply(function(){},null,arguments_)',
    'const arguments_={length:1,get 0(){fetch("https://invalid.example");return 1}};(function(){}).apply(null,arguments_)',
    'const arguments_={get length(){fetch("https://invalid.example");return 0}};Function.prototype.apply.call(function(){},null,arguments_)',
    'const arguments_={length:1,get 0(){fetch("https://invalid.example");return 1}};Reflect.apply.call(null,function(){},null,arguments_)',
  ])('models intrinsic apply ArrayLike accessors', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const Reflect={apply(){}};const arguments_={get length(){fetch("https://invalid.example");return 0}};Reflect.apply(function(){},null,arguments_)',
    'const api={apply(){}};const arguments_={get length(){fetch("https://invalid.example");return 0}};api.apply(null,arguments_)',
  ])('does not model non-intrinsic apply ArrayLike accessors', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto,mutate(){}};delete api.mutate;api.mutate();target.run();',
    'const target={run:()=>0};const proto={Factory:function(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto,Factory:function(){}};Reflect.deleteProperty(api,"Factory");new api.Factory();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto,get mutate(){return()=>0}};delete api.mutate;api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto,...{mutate(){}}};delete api.mutate;api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api=Object.create(proto,{mutate:{configurable:true,value(){}}});Reflect.deleteProperty(api,"mutate");api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto,get mutate(){return()=>0}};function remove(value){delete value.mutate}remove(api);api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto};api.mutate=()=>0;delete api.mutate;api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto};Object.assign(api,{mutate(){}});Reflect.deleteProperty(api,"mutate");api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto};Object.defineProperty(api,"mutate",{configurable:true,value(){}});delete api.mutate;api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto};api.mutate=()=>0;function remove(value){delete value.mutate}remove(api);api.mutate();target.run();',
    'const target={run:()=>0};const proto={mutate(){target.run=()=>fetch("https://invalid.example")}};const api={__proto__:proto};api.mutate=()=>0;function remove(value){Reflect.deleteProperty(value,"mutate")}remove(api);api.mutate();target.run();',
  ])('resolves a callable exposed by member deletion', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const proto={run(){return 0}},api={__proto__:proto};Object.defineProperty(api,"run",{value:()=>fetch("https://invalid.example")});Reflect.deleteProperty(api,"run");api.run()',
    'const proto={run(){return 0}},api={__proto__:proto};Object.defineProperties(api,{run:{value:()=>fetch("https://invalid.example")}});Reflect.deleteProperty(api,"run");api.run()',
    'const proto={run(){return 0}},api={__proto__:proto};Object.defineProperty(api,"run",{configurable:false,value:()=>0,writable:true});api.run=()=>fetch("https://invalid.example");Reflect.deleteProperty(api,"run");api.run()',
    'const proto={run(){return 0}},api={__proto__:proto};Object.defineProperty(api,"run",{configurable:true,value:()=>0});Object.defineProperty(api,"run",{configurable:false,value:()=>fetch("https://invalid.example")});Reflect.deleteProperty(api,"run");api.run()',
  ])('retains a non-configurable own member after deletion fails', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const proto={run(){return fetch("https://invalid.example")}},api={__proto__:proto};Object.defineProperty(api,"run",{value:()=>0});Reflect.deleteProperty(api,"run");api.run()',
    'const proto={run(){return fetch("https://invalid.example")}},api={__proto__:proto};Object.defineProperties(api,{run:{value:()=>0}});Reflect.deleteProperty(api,"run");api.run()',
  ])(
    'does not expose a prototype after non-configurable deletion',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
    }
  );

  it.each([
    [
      'defineProperty retains a safe latest own value',
      'const proto={run(){return fetch("https://invalid.example")}},api=Object.create(proto);Object.defineProperty(api,"run",{value:()=>0});Reflect.deleteProperty(api,"run");api.run()',
      [],
    ],
    [
      'defineProperty retains a hazardous latest own value',
      'const proto={run(){}},api=Object.create(proto);Object.defineProperty(api,"run",{value:()=>fetch("https://invalid.example")});Reflect.deleteProperty(api,"run");api.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'defineProperties retains a safe latest own value',
      'const proto={run(){return fetch("https://invalid.example")}},api=Object.create(proto);Object.defineProperties(api,{run:{value:()=>0}});Reflect.deleteProperty(api,"run");api.run()',
      [],
    ],
    [
      'defineProperties retains a hazardous latest own value',
      'const proto={run(){}},api=Object.create(proto);Object.defineProperties(api,{run:{value:()=>fetch("https://invalid.example")}});Reflect.deleteProperty(api,"run");api.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'configurable-to-non-configurable retains the hazardous replacement',
      'const proto={run(){}},api=Object.create(proto,{run:{configurable:true,value:()=>0}});Object.defineProperty(api,"run",{configurable:false,value:()=>fetch("https://invalid.example")});Reflect.deleteProperty(api,"run");api.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'configurable-to-non-configurable retains the safe replacement',
      'const proto={run(){return fetch("https://invalid.example")}},api=Object.create(proto,{run:{configurable:true,value:()=>fetch("https://invalid.example")}});Object.defineProperty(api,"run",{configurable:false,value:()=>0});Reflect.deleteProperty(api,"run");api.run()',
      [],
    ],
    [
      'omitted configurable preserves a successful future delete',
      'const proto={run(){return fetch("https://invalid.example")}},api=Object.create(proto,{run:{configurable:true,value:()=>0}});Object.defineProperty(api,"run",{value:()=>0});Reflect.deleteProperty(api,"run");api.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'successful delete then safe redefine survives a failed delete',
      'const proto={run(){return fetch("https://invalid.example")}},api=Object.create(proto,{run:{configurable:true,value:()=>0}});Reflect.deleteProperty(api,"run");Object.defineProperty(api,"run",{value:()=>0});Reflect.deleteProperty(api,"run");api.run()',
      [],
    ],
    [
      'successful delete then hazardous redefine survives a failed delete',
      'const proto={run(){}},api=Object.create(proto,{run:{configurable:true,value:()=>0}});Reflect.deleteProperty(api,"run");Object.defineProperty(api,"run",{value:()=>fetch("https://invalid.example")});Reflect.deleteProperty(api,"run");api.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'failed delete then hazardous writable redefine is retained',
      'const proto={run(){}},api=Object.create(proto,{run:{configurable:false,writable:true,value:()=>0}});Reflect.deleteProperty(api,"run");Object.defineProperty(api,"run",{value:()=>fetch("https://invalid.example")});Reflect.deleteProperty(api,"run");api.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'failed delete then safe writable redefine is retained',
      'const proto={run(){return fetch("https://invalid.example")}},api=Object.create(proto,{run:{configurable:false,writable:true,value:()=>fetch("https://invalid.example")}});Reflect.deleteProperty(api,"run");Object.defineProperty(api,"run",{value:()=>0});Reflect.deleteProperty(api,"run");api.run()',
      [],
    ],
    [
      'class instance deletion exposes a hazardous prototype method',
      'class API{run(){return fetch("https://invalid.example")}}const api=new API();api.run=()=>0;Reflect.deleteProperty(api,"run");api.run()',
      ['fetch("https://invalid.example")'],
    ],
    [
      'class instance deletion drops a hazardous assignment before a safe prototype method',
      'class API{run(){}}const api=new API();api.run=()=>fetch("https://invalid.example");Reflect.deleteProperty(api,"run");api.run()',
      [],
    ],
  ])('folds own-property deletion state: %s', (_label, source, effects) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(effects);
  });

  it.each([
    'const target={run:()=>0};const api={call(){target.run=()=>fetch("https://invalid.example")}};api.call();target.run();',
    'const target={run:()=>0};const api={apply(){target.run=()=>fetch("https://invalid.example")}};api.apply();target.run();',
  ])(
    'does not confuse a named object method with Function.prototype invocation',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it.each([
    'const target={run:()=>0};const api={};Object.defineProperty(api,"mutate",{value(){target.run=()=>fetch("https://invalid.example")}});api.mutate();target.run();',
    'const target={run:()=>0};const api={};Object.defineProperty(api,"mutate",{value(){target.run=()=>fetch("https://invalid.example")}});const fn=api.mutate;fn();target.run();',
    'const target={run:()=>0};const api={};Object.defineProperty(api,"mutate",{value(){target.run=()=>fetch("https://invalid.example")}});const {mutate}=api;mutate();target.run();',
    'const target={run:()=>0};const api={};api.mutate=()=>{target.run=()=>fetch("https://invalid.example")};api.mutate();target.run();',
    'const target={run:()=>0};const api={};Object.assign(api,{mutate(){target.run=()=>fetch("https://invalid.example")}});api.mutate();target.run();',
  ])('orders an invoked mutation-installed local method', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0};const api={mutate(){}};api.mutate=()=>{target.run=()=>fetch("https://invalid.example")};api.mutate();target.run();',
    'const target={run:()=>0};const api={mutate(){}};{const api={mutate(){target.run=()=>fetch("https://invalid.example")}};api.mutate()}target.run();',
  ])('uses the execution-site callable owner', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};api.mutate=()=>{};api.mutate();target.run();',
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};{const api={mutate(){}};api.mutate()}target.run();',
  ])('does not invoke a shadowed or overwritten callable owner', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};if(flag)api.mutate=()=>{};api.mutate();target.run();',
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};if(false)api.mutate=()=>{};api.mutate();target.run();',
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};flag&&(api.mutate=()=>{});api.mutate();target.run();',
  ])('does not let a conditional write erase a callable owner', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const key="run";const api={[key](){fetch("https://invalid.example")}};api.run();',
    'const key="run";class API{[key](){fetch("https://invalid.example")}};new API().run();',
  ])('resolves an immutable computed callable definition', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};const key="mutate";api[key]();target.run();',
    'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const key="apply";Reflect[key](mutate,null,[]);target.run();',
  ])('resolves an immutable computed callable invocation', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('rejects an opaque computed callable invocation', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const api={mutate(){fetch("https://invalid.example")}};api[getKey()]();'
      )
    ).toContain('fetch("https://invalid.example")');
  });

  it('rejects an opaque computed Reflect invocation', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}Reflect[getKey()](mutate,null,[]);target.run();'
      )
    ).toThrow('requires statically analyzable computed callable invocations');
  });

  it.each([
    'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}Reflect.apply.bind(null,mutate,null,[])();target.run();',
    'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const invoke=Reflect.apply.bind(null,mutate,null,[]);invoke();target.run();',
  ])('orders a mutation invoked through a bound Reflect helper', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('classifies a callable parameter invoked through bound Reflect.apply', () => {
    expect(
      inspectCloudflareInvokedParameterProjectionsForTesting(
        'const transform=effect=>Reflect.apply.bind(null,effect,null,[])()',
        'transform'
      )
    ).toEqual([{ name: 'effect', path: [] }]);
  });

  it.each([
    [
      'direct bound Object.assign',
      'const target={run:()=>0};Object.assign.bind(null,target,{run:()=>fetch("https://invalid.example")})();target.run();',
    ],
    [
      'aliased bound Object.assign',
      'const target={run:()=>0};const mutate=Object.assign.bind(null,target,{run:()=>fetch("https://invalid.example")});mutate();target.run();',
    ],
    [
      'nested Function.prototype.call dispatch',
      'const target={};Function.prototype.call.call(Object.assign,null,target,{run:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'nested Object.assign.call dispatch with a source getter',
      'Object.assign.call.call(Object.assign,null,{}, {get x(){fetch("https://invalid.example");return 1}});',
    ],
    [
      'nested Reflect.apply dispatch with a source getter',
      'Reflect.apply(Reflect.apply,null,[Object.assign,null,[{}, {get x(){fetch("https://invalid.example");return 1}}]]);',
    ],
    [
      'bound Object.assign with a target setter',
      'const target={set x(value){fetch("https://invalid.example")}};Object.assign.bind(null,target,{x:1})();',
    ],
    [
      'nested Reflect.apply dispatch with a target setter',
      'const target={set x(value){fetch("https://invalid.example")}};Reflect.apply(Reflect.set,null,[target,"x",1]);',
    ],
  ])('normalizes %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('bounds local class hierarchy traversal', () => {
    const classes = [
      'class C0{run(){}}',
      ...Array.from(
        { length: 64 },
        (_unused, index) => `class C${index + 1} extends C${index}{}`
      ),
    ].join(';');
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(`${classes};new C64().run()`)
    ).toThrow('exceeded bounded factory resolution');
  });

  it.each([
    'const key="safe";{const key="run";const api={[key](){fetch("https://invalid.example")}};api.run()}',
    'const key="safe";{const key="run";class API{[key](){fetch("https://invalid.example")}};new API().run()}',
  ])('resolves a shadowed immutable computed callable definition', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const key=getKey();const api={[key](){fetch("https://invalid.example")}};api.run();',
    'const key=getKey();class API{[key](){fetch("https://invalid.example")}};new API().run();',
  ])('rejects an opaque computed callable definition', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable computed callable definitions'
    );
  });

  it.each([
    'globalThis.globalThis.fetch("https://invalid.example")',
    'globalThis.self.fetch("https://invalid.example")',
    'Reflect.get(globalThis,"globalThis").fetch("https://invalid.example")',
    'Object.getOwnPropertyDescriptor(globalThis,"globalThis").value.fetch("https://invalid.example")',
  ])('normalizes a chained global identity alias', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([source]);
  });

  it.each([
    [
      'the exact adapter factory',
      'import{custom}from"./reviewed.js";const fallback=(schema,fallback)=>custom().pipe(schema.catch(fallback));',
    ],
    [
      'a direct top-level alias chain',
      'import{custom}from"./reviewed.js";const first=custom,second=first;const fallback=(schema,value)=>second().pipe(schema.catch(value));',
    ],
    [
      'an unrelated deep call graph',
      `import{custom}from"./reviewed.js";const unrelated=${'Object.assign({},'.repeat(
        64
      )}{}${')'.repeat(
        64
      )};const fallback=(schema,value)=>custom().pipe(schema.catch(value));`,
    ],
  ])(
    'proves a reviewed imported factory root is direct: %s',
    (_label, source) => {
      expect(
        inspectCloudflareReviewedOriginDirectAliasProofForTesting(
          source,
          'fallback'
        )
      ).toBe(true);
    }
  );

  it('requires an exact reviewed result policy for a composed factory path', () => {
    const zodRecord = {
      modules: [
        {
          id: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/util.js',
          owner: 'non-app',
        },
      ],
      ownership: 'non-app',
      sha256:
        'b58b76143de945661f801945b38db191e2fbe55ecd29e98f6d30fd9d54cec758',
    };
    const call = { callResult: true };
    const branded = ['trim', call, 'min', call, 'brand', call];

    expect(
      inspectCloudflareReviewedFactoryResultPathForTesting(
        zodRecord,
        'string',
        branded,
        ['optional']
      )
    ).toBe(true);
    expect(
      inspectCloudflareReviewedFactoryResultPathForTesting(
        zodRecord,
        'string',
        branded,
        ['nullish']
      )
    ).toBe(true);
    const displayName = ['trim', call, 'max', call, 'brand', call];
    expect(
      inspectCloudflareReviewedFactoryResultPathForTesting(
        zodRecord,
        'string',
        displayName,
        ['nullish']
      )
    ).toBe(true);
    expect(
      inspectCloudflareReviewedFactoryResultPathForTesting(
        zodRecord,
        'string',
        displayName,
        ['optional']
      )
    ).toBe(false);
    for (const siblingPath of [
      ['trim', call, 'length', call, 'brand', call],
      ['trim', call, 'pipe', call, 'brand', call],
    ]) {
      expect(
        inspectCloudflareReviewedFactoryResultPathForTesting(
          zodRecord,
          'string',
          siblingPath,
          []
        )
      ).toBe(true);
    }
    for (const suffix of [
      ['optional', call],
      ['optional', call, call],
      ['parse', call],
      ['pipe', call],
      ['transform', call],
    ]) {
      expect(
        inspectCloudflareReviewedFactoryResultPathForTesting(
          zodRecord,
          'string',
          branded,
          suffix
        )
      ).toBe(false);
    }
  });

  it('pins a direct nullish string result to the exact emitted Zod closure', () => {
    const zodRecord = {
      modules: [
        {
          id: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/util.js',
          owner: 'non-app',
        },
      ],
      ownership: 'non-app',
      sha256:
        'b2e3828594675b9262c546998aa09ba14d1c0a98d9cb1c38f7eb6ebd04c8ea06',
    };

    expect(
      inspectCloudflareReviewedFactoryResultPathForTesting(
        zodRecord,
        'string',
        [],
        ['nullish']
      )
    ).toBe(true);
    expect(
      inspectCloudflareReviewedFactoryResultPathForTesting(
        { ...zodRecord, sha256: '0'.repeat(64) },
        'string',
        [],
        ['nullish']
      )
    ).toBe(false);
    expect(
      inspectCloudflareReviewedFactoryResultPathForTesting(
        zodRecord,
        'string',
        [],
        ['nullable']
      )
    ).toBe(false);
  });

  it('proves one instantiated top-level factory alias without wrapper calls', () => {
    const source =
      'import{custom}from"./reviewed.js";const branded=()=>custom().brand(),first=branded,second=branded;export{first,second};';

    expect(
      inspectCloudflareReviewedOriginDirectAliasProofForTesting(
        source,
        'branded'
      )
    ).toBe(true);
  });

  it.each([
    'custom=()=>0;',
    'custom.member=()=>0;',
    'delete custom.member;',
    'custom.member++;',
    'Object.assign(custom,{member(){}});',
    'Object.defineProperty(custom,"member",{value(){}});',
    'Object.setPrototypeOf(custom,{member(){}});',
    'Reflect.set(custom,"member",()=>0);',
    'poison(custom);',
    'holder.value=custom;',
    'const {call}=custom;',
  ])('rejects a hostile reviewed import-root use: %s', (attack) => {
    const source = `import{custom}from"./reviewed.js";${attack}const fallback=()=>custom();`;
    expect(
      inspectCloudflareReviewedOriginDirectAliasProofForTesting(
        source,
        'fallback'
      )
    ).toBe(false);
  });

  it.each([
    'alias=()=>0;',
    'alias.member=()=>0;',
    'delete alias.member;',
    'Object.assign(alias,{member(){}});',
    'Reflect.set(alias,"member",()=>0);',
    'poison(alias);',
    'holder.value=alias;',
  ])('rejects a hostile reviewed import alias use: %s', (attack) => {
    const source = `import{custom}from"./reviewed.js";let alias=custom;${attack}const fallback=()=>alias();`;
    expect(
      inspectCloudflareReviewedOriginDirectAliasProofForTesting(
        source,
        'fallback'
      )
    ).toBe(false);
  });

  it.each([
    'export{custom};const fallback=()=>custom();',
    'export{custom as publicCustom};const fallback=()=>custom();',
    'const alias=custom;export{alias};const fallback=()=>alias();',
    'const alias=custom;export{alias as publicAlias};const fallback=()=>alias();',
    'const alias=custom;export default alias;const fallback=()=>alias();',
  ])('rejects an exported reviewed import identity: %s', (body) => {
    const source = `import{custom}from"./reviewed.js";${body}`;
    expect(
      inspectCloudflareReviewedOriginDirectAliasProofForTesting(
        source,
        'fallback'
      )
    ).toBe(false);
  });

  it.each([
    'const fallback=()=>(()=>{const result=custom();result.pipe=()=>fetch("https://invalid.example");return result})()',
    'const result=custom();result.pipe=()=>fetch("https://invalid.example");const fallback=()=>result.pipe()',
    'const result=custom();Object.assign(result,{pipe:()=>fetch("https://invalid.example")});const fallback=()=>result.pipe()',
    'const result=custom();Object.defineProperty(result,"pipe",{value:()=>fetch("https://invalid.example")});const fallback=()=>result.pipe()',
    'const result=custom();Reflect.set(result,"pipe",()=>fetch("https://invalid.example"));const fallback=()=>result.pipe()',
  ])('rejects a poisoned reviewed factory result: %s', (body) => {
    const source = `import{custom}from"./reviewed.js";${body}`;
    expect(
      inspectCloudflareReviewedOriginDirectAliasProofForTesting(
        source,
        'fallback'
      )
    ).toBe(false);
  });

  it('defers a conditional reviewed-origin alias to the generic proof', () => {
    const source =
      'import{custom}from"./reviewed.js";const alias=flag?custom:custom;const fallback=()=>alias();';
    expect(
      inspectCloudflareReviewedOriginDirectAliasProofForTesting(
        source,
        'fallback'
      )
    ).toBeUndefined();
  });

  it('fails closed for a cached reviewed factory result', () => {
    const source =
      'import{custom}from"./reviewed.js";const cached=custom();const fallback=()=>cached;';
    expect(
      inspectCloudflareReviewedOriginDirectAliasProofForTesting(
        source,
        'fallback'
      )
    ).toBe(false);
  });

  it.each([
    'const custom=()=>({pipe(){return{optional(){}}}}),fallback=(schema,value)=>custom().pipe(schema.catch(value));fallback({catch(){fetch("https://method.invalid");return{}}},"").optional()',
    'const custom=()=>({pipe(){return{optional(){}}}}),fallback=(schema,value)=>custom().pipe(schema.catch(value));fallback({catch(callback){callback();return{}}},()=>fetch("https://callback.invalid")).optional()',
  ])('preserves a caller-owned fallback schema effect', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContainEqual(
      expect.stringContaining('fetch(')
    );
  });

  it('rejects unknown profiles', () => {
    expect(() => verifyRuntimeProfile('auto', fixture())).toThrow(
      'unknown profile auto'
    );
  });
});
