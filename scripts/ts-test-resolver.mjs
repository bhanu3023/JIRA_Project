// Module resolution hook for running .ts tests under `node --test`.
//
// Node's ESM resolver knows neither tsconfig's "@/*" -> "./src/*" path alias nor TypeScript's
// extensionless relative imports; webpack handles both for us during `next build`, but the test
// runner has no webpack. This teaches the resolver those two rules and nothing else, so source
// files keep the repo's normal import style instead of being bent to suit the tests.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./ts-test-resolver-hooks.mjs', import.meta.url), pathToFileURL('./'));
