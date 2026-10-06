/**
 * Shared pure reference reconciliation for simple-reference composition objects
 * (FunctionalOption, FilterCriterion).
 *
 * Keeps reference reconciliation logic unified while preserving distinct XML schemas.
 */

export interface SimpleReferenceReconcileResult {
  refs: string[];
  rejected: Array<{ ref: string; reason: string }>;
}

/**
 * Reconciles simple references against add/remove diff.
 * Trims names, validates non-empty identifiers, prevents duplicate additions,
 * and maintains item order.
 */
export function reconcileSimpleReferenceRefs(
  current: string[],
  diff: { add?: string[]; remove?: string[] },
  validateRef?: (ref: string) => string | null,
): SimpleReferenceReconcileResult {
  const rejected: Array<{ ref: string; reason: string }> = [];
  const normalized = current
    .map((r) => (typeof r === 'string' ? r.trim() : ''))
    .filter(Boolean);
  const seen = new Set(normalized);
  const out = [...normalized];

  const validator =
    validateRef ??
    ((ref: string) => {
      const t = typeof ref === 'string' ? ref.trim() : '';
      return t ? null : 'empty reference';
    });

  for (const raw of diff.add ?? []) {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    const err = validator(ref);
    if (err) {
      rejected.push({ ref: String(raw), reason: err });
      continue;
    }
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    out.push(ref);
  }

  const removeSet = new Set(
    (diff.remove ?? [])
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter(Boolean),
  );
  const refs = out.filter((r) => !removeSet.has(r));

  return { refs, rejected };
}
