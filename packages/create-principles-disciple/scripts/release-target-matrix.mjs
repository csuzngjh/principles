export const SUPPORTED_NATIVE_TARGETS = Object.freeze({
  platforms: Object.freeze({
    darwin: Object.freeze(['arm64', 'x64']),
    linux: Object.freeze(['arm64', 'x64']),
    win32: Object.freeze(['x64']),
  }),
  nodeAbis: Object.freeze({ 22: '127', 24: '137', 26: '147' }),
});

export const NATIVE_RUNTIME_DEPENDENCY = Object.freeze({
  name: 'better-sqlite3',
  version: '13.0.3',
  nodeEngine: '>=22',
});

export function assertSupportedLocalReleaseTarget(target, runtime) {
  if (!Object.hasOwn(SUPPORTED_NATIVE_TARGETS.platforms, target.platform)) {
    throw new Error(`Unsupported native release target: ${target.platform}/${target.arch}`);
  }
  const architectures = SUPPORTED_NATIVE_TARGETS.platforms[target.platform];
  if (!architectures.includes(target.arch)) {
    throw new Error(`Unsupported native release target: ${target.platform}/${target.arch}`);
  }
  if (!Object.hasOwn(SUPPORTED_NATIVE_TARGETS.nodeAbis, target.nodeMajor)) {
    throw new Error(`Unsupported Node.js major for native release assets: ${target.nodeMajor}`);
  }
  const expectedAbi = SUPPORTED_NATIVE_TARGETS.nodeAbis[target.nodeMajor];
  if (target.nodeAbi !== expectedAbi) {
    throw new Error(`Node.js ${target.nodeMajor} release assets require ABI ${expectedAbi}; requested ABI ${target.nodeAbi}`);
  }
  if (target.platform !== runtime.platform || target.arch !== runtime.arch
    || target.nodeMajor !== runtime.nodeMajor || target.nodeAbi !== runtime.nodeAbi) {
    throw new Error(`Local release builds can only target ${runtime.platform}/${runtime.arch}/Node${runtime.nodeMajor}/abi${runtime.nodeAbi}; requested ${target.platform}/${target.arch}/Node${target.nodeMajor}/abi${target.nodeAbi}`);
  }
}
