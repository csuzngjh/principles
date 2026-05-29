import { mergeConfig, configsMatch, getEqualModuleName } from './utils.js';
import { createRequire } from 'module';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

// Verify the correct package is being used
const require = createRequire(import.meta.url);
const pkgJson = require('@principles-trap/deep-equal/package.json');
assert(pkgJson.name === '@principles-trap/deep-equal', 'uses @principles-trap/deep-equal package');
assert(getEqualModuleName() === '@principles-trap/deep-equal', 'getEqualModuleName returns correct package');

// Test mergeConfig
const merged = mergeConfig({ timeout: 5000 });
assert(merged.timeout === 5000, 'mergeConfig overrides timeout');
assert(merged.retries === 3, 'mergeConfig keeps default retries');

// Test configsMatch
const a = { timeout: 1000, retries: 1, endpoints: ['a'] };
const b = { timeout: 1000, retries: 1, endpoints: ['a'] };
assert(configsMatch(a, b) === true, 'configsMatch returns true for equal configs');

const c = { timeout: 2000, retries: 1, endpoints: ['a'] };
assert(configsMatch(a, c) === false, 'configsMatch returns false for different configs');

console.log('\nAll tests passed!');
