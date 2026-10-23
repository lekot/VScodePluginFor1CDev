export interface RollbackJournalRecord {
  readonly state?: unknown;
  readonly rollbackAppliedSteps?: unknown;
  readonly appliedSteps?: unknown;
  readonly plan?: { readonly steps?: unknown };
}

export function assertValidRollbackAppliedSteps(journal: RollbackJournalRecord): void {
  if (!Object.prototype.hasOwnProperty.call(journal, 'rollbackAppliedSteps')) {
    return;
  }

  const steps = journal.plan?.steps;
  if (
    journal.state !== 'rollback-required'
    || typeof journal.rollbackAppliedSteps !== 'number'
    || !Number.isInteger(journal.rollbackAppliedSteps)
    || journal.rollbackAppliedSteps < 0
    || !Array.isArray(steps)
    || journal.rollbackAppliedSteps > steps.length
    || journal.rollbackAppliedSteps !== journal.appliedSteps
  ) {
    throw new Error('Invalid rollbackAppliedSteps in mutation journal.');
  }
}
