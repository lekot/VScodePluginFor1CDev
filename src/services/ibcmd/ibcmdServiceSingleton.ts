import { IbcmdService } from './IbcmdService';

let instance: IbcmdService | null = null;

export function getIbcmdService(): IbcmdService {
  if (!instance) {
    instance = new IbcmdService();
  }
  return instance;
}

/** Reset the singleton — called on extension deactivation and in tests. */
export function resetIbcmdService(): void {
  instance = null;
}

/** @deprecated Use resetIbcmdService() */
export const resetIbcmdServiceSingletonForTests = resetIbcmdService;
