/**
 * WOW design §8.1 — ibcmd CLI facade (implementation split under `./ibcmd/`).
 */

export { IbcmdService } from './ibcmd/IbcmdService';
export {
  createDefaultPathResolverDeps,
  resolveIbcmdPath,
  type IbcmdPathResolveResult,
  type IbcmdPathResolverDeps,
} from './ibcmd/IbcmdPathResolver';
export {
  IBCMD_EXEC_MAX_BUFFER,
  resolveIbcmdTimeoutMs,
  runIbcmdExecutable,
  type ExecFileFn,
} from './ibcmd/IbcmdProcessRunner';
export { getIbcmdService, resetIbcmdServiceSingletonForTests } from './ibcmd/ibcmdServiceSingleton';
export { registerIbcmdInfobaseHooks, IBCMD_SETUP_COMMAND } from './ibcmd/registerIbcmdInfobaseHooks';
export { showIbcmdNotFoundDialog } from './ibcmd/showIbcmdNotFoundDialog';
