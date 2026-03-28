import { IbcmdService } from './IbcmdService';

let instance: IbcmdService | null = null;

export function getIbcmdService(): IbcmdService {
  if (!instance) {
    instance = new IbcmdService();
  }
  return instance;
}

/** For tests that need a clean cache between cases (optional). */
export function resetIbcmdServiceSingletonForTests(): void {
  instance = null;
}
