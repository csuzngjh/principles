/**
 * Node VM Polyfill — Thin wrapper around node:vm module
 *
 * PURPOSE: Provide a single import point for vm compilation functionality
 * used by the Rule Host. Isolates the node:vm dependency so it can be
 * easily mocked in tests.
 */

import * as vm from 'node:vm';

export const nodeVm = vm;
