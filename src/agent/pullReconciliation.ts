import type { AgentResult } from './types';

/** True only when the pull result confirms at least one exported object. */
export function hasSuccessfulAgentPullWrite(result: AgentResult<unknown>): boolean {
  if (!result.data || typeof result.data !== 'object' || !('summary' in result.data)) {
    return false;
  }
  const summary = result.data.summary;
  return Boolean(
    summary
    && typeof summary === 'object'
    && 'success' in summary
    && typeof summary.success === 'number'
    && summary.success > 0,
  );
}
