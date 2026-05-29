import equal from '@principles-trap/deep-equal';

const DEFAULT_CONFIG = {
  timeout: 30000,
  retries: 3,
  endpoints: ['http://localhost:8080'],
};

export function mergeConfig(user) {
  return { ...DEFAULT_CONFIG, ...user };
}

export function configsMatch(a, b) {
  return equal(a, b);
}

export function getEqualModuleName() {
  return '@principles-trap/deep-equal';
}
