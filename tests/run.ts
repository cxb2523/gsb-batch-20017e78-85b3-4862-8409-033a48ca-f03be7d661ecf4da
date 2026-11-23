// ==============================================
// 本地验证统一入口：
// node --experimental-transform-types --import ./tests/register-stubs.ts tests/run.ts
// ==============================================
import './gpu-cache-upload-queue.test';
import './recycle-data-validator.test';
import './splat-gpu-cache.test';
import './upload-chain-integration.test';
import { runTests } from './harness';

runTests();
