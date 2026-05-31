import {
  detectEol,
  hashText,
  materialBetweenAnchors,
  scanBslRoutineLogicalOutline,
} from './bslRoutineLogicalScanner';
import { routineProvenance } from './bslRoutineLogicalMerge';
import type {
  BslRoutineLogicalAnchor,
  BslRoutineLogicalGuardInput,
  BslRoutineLogicalGuardResult,
  BslRoutineLogicalManualDiagnostic,
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalNodeAnchor,
  BslRoutineLogicalScanResult,
  BslRoutineLogicalSnapshot,
} from './bslRoutineMergePlanTypes';

export function validateBslRoutineLogicalMergePlan(
  plan: BslRoutineLogicalMergePlan,
  input: BslRoutineLogicalGuardInput
): BslRoutineLogicalGuardResult {
  const diagnostics: BslRoutineLogicalManualDiagnostic[] = [];
  const planKind = (plan as { kind?: string }).kind;
  if (planKind !== 'logicalRoutineMergePlan') {
    diagnostics.push({
      reason: 'plan-not-executable',
      message: 'Merge plan kind is not executable by the logical routine merge guard.',
    });
  }
  if (plan.status !== 'auto') {
    diagnostics.push({
      reason: 'plan-not-executable',
      message: 'Merge plan status is not automatic and cannot be executed.',
    });
  }
  diagnostics.push(...plan.diagnostics);
  if (plan.status === 'auto' && plan.diagnostics.length === 0 && plan.operations.length === 0) {
    diagnostics.push({
      reason: 'no-logical-insertion',
      message: 'Automatic merge plan does not contain executable operations.',
    });
  }
  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics,
    };
  }

  if (plan.moduleId !== input.moduleId) {
    diagnostics.push({
      reason: 'module-identity-changed',
      message: 'Current module id does not match merge plan module id.',
    });
  }

  const currentRoutine = routineProvenance(input.current.routine);
  if (
    currentRoutine.normalizedName !== plan.routine.normalizedName ||
    currentRoutine.kind !== plan.routine.kind ||
    currentRoutine.signatureHash !== plan.routine.signatureHash ||
    currentRoutine.directivesHash !== plan.routine.directivesHash ||
    currentRoutine.exported !== plan.routine.exported
  ) {
    diagnostics.push({
      reason: 'routine-identity-changed',
      message: 'Current routine signature or directives do not match merge plan.',
    });
  }

  const currentScan = scanBslRoutineLogicalOutline(input.current);
  const currentEol = detectEol(input.current.source);
  for (const diagnostic of currentScan.diagnostics) {
    diagnostics.push({
      reason: 'scanner-diagnostic',
      message: diagnostic.message,
      range: diagnostic.range,
    });
  }

  for (const operation of plan.operations) {
    if (
      operation.moduleId !== plan.moduleId ||
      operation.moduleId !== input.moduleId ||
      !sameRoutineProvenance(operation.routine, plan.routine) ||
      !sameRoutineProvenance(operation.routine, currentRoutine) ||
      operation.eol !== plan.eol ||
      operation.eol !== currentEol
    ) {
      diagnostics.push({
        reason: 'operation-provenance-changed',
        message: 'Operation provenance does not match merge plan or current target.',
      });
      continue;
    }

    if (hashText(operation.sourceText) !== operation.sourceTextHash) {
      diagnostics.push({
        reason: 'operation-source-text-changed',
        message: 'Operation source text does not match its planned hash.',
      });
      continue;
    }

    const section = currentScan.outline.sections[operation.sectionId];
    if (!section || section.parentPath !== operation.parentPath) {
      diagnostics.push({
        reason: 'missing-section',
        message: 'Current outline does not contain planned parent section.',
      });
      continue;
    }

    const startAnchorValid = validateAnchor(currentScan, operation.startAnchor, diagnostics);
    const endAnchorValid = validateAnchor(currentScan, operation.endAnchor, diagnostics);
    if (!startAnchorValid || !endAnchorValid) {
      continue;
    }
    if (!anchorsMatchOperationTarget(operation)) {
      diagnostics.push({
        reason: 'operation-anchor-mismatch',
        message: 'Operation target section does not match planned interval anchors.',
      });
      continue;
    }
    const anchorRolesValid =
      validateAnchorRole(operation.startAnchor, 'start', diagnostics) &&
      validateAnchorRole(operation.endAnchor, 'end', diagnostics);
    if (!anchorRolesValid) {
      continue;
    }
    const interval = operationIntervalMaterial(input.current, currentScan, operation.startAnchor, operation.endAnchor);
    if ('diagnostic' in interval) {
      diagnostics.push(interval.diagnostic);
      continue;
    }
    if (hashText(interval.material) !== operation.targetIntervalMaterialHash) {
      diagnostics.push({
        reason: 'interval-material-changed',
        message: 'Material between planned anchors changed.',
      });
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  };
}

function anchorsMatchOperationTarget(operation: BslRoutineLogicalMergePlan['operations'][number]): boolean {
  return (
    operation.startAnchor.parentPath === operation.parentPath &&
    operation.startAnchor.sectionId === operation.sectionId &&
    operation.endAnchor.parentPath === operation.parentPath &&
    operation.endAnchor.sectionId === operation.sectionId
  );
}

function validateAnchor(
  scanResult: BslRoutineLogicalScanResult,
  anchor: BslRoutineLogicalAnchor,
  diagnostics: BslRoutineLogicalManualDiagnostic[]
): boolean {
  const section = scanResult.outline.sections[anchor.sectionId];
  if (!section || section.parentPath !== anchor.parentPath) {
    diagnostics.push({
      reason: 'missing-section',
      message: 'Anchor parent section is not present in current outline.',
    });
    return false;
  }
  if (anchor.kind === 'sentinel') {
    if (!isValidSentinelKind(anchor.sentinel)) {
      diagnostics.push({
        reason: 'invalid-anchor',
        message: 'Planned sentinel anchor kind is invalid.',
      });
      return false;
    }
    return true;
  }
  const node = scanResult.outline.nodesByPath[anchor.path];
  if (!node || !sameAnchorNode(anchor, node)) {
    diagnostics.push({
      reason: 'missing-anchor',
      message: 'Planned node anchor is not present in current outline.',
    });
    return false;
  }
  if (matchingAnchorNodeCount(scanResult, anchor) !== 1) {
    diagnostics.push({
      reason: 'ambiguous-anchor',
      message: 'Planned node anchor is no longer unique in current outline.',
    });
    return false;
  }
  return true;
}

function validateAnchorRole(
  anchor: BslRoutineLogicalAnchor,
  role: 'start' | 'end',
  diagnostics: BslRoutineLogicalManualDiagnostic[]
): boolean {
  if (anchor.kind !== 'sentinel') {
    return true;
  }
  const expectedSentinel = role === 'start' ? 'section-start' : 'section-end';
  if (anchor.sentinel === expectedSentinel) {
    return true;
  }
  diagnostics.push({
    reason: 'invalid-anchor',
    message: 'Planned sentinel anchor role is invalid for interval operation.',
  });
  return false;
}

function sameAnchorNode(
  anchor: BslRoutineLogicalNodeAnchor,
  node: BslRoutineLogicalScanResult['outline']['nodesByPath'][string]
): boolean {
  return (
    node.kind === anchor.nodeKind &&
    node.path === anchor.path &&
    node.parentPath === anchor.parentPath &&
    node.sectionId === anchor.sectionId &&
    node.textHash === anchor.textHash &&
    node.shapeHash === anchor.shapeHash
  );
}

function matchingAnchorNodeCount(
  scanResult: BslRoutineLogicalScanResult,
  anchor: BslRoutineLogicalNodeAnchor
): number {
  const section = scanResult.outline.sections[anchor.sectionId];
  return (
    section?.nodes.filter(
      (node) =>
        node.kind === anchor.nodeKind &&
        node.parentPath === anchor.parentPath &&
        node.sectionId === anchor.sectionId &&
        node.textHash === anchor.textHash &&
        node.shapeHash === anchor.shapeHash
    ).length ?? 0
  );
}

function operationIntervalMaterial(
  snapshot: BslRoutineLogicalSnapshot,
  scanResult: BslRoutineLogicalScanResult,
  startAnchor: BslRoutineLogicalAnchor,
  endAnchor: BslRoutineLogicalAnchor
): { material: string } | { diagnostic: BslRoutineLogicalManualDiagnostic } {
  const startLine = anchorEndLine(scanResult, startAnchor);
  const endLine = anchorStartLine(snapshot, scanResult, endAnchor);
  if (startLine === undefined || endLine === undefined) {
    return {
      diagnostic: {
        reason: 'missing-anchor',
        message: 'Cannot resolve planned anchor while validating interval.',
      },
    };
  }
  if (startLine > endLine + 1) {
    return {
      diagnostic: {
        reason: 'anchor-order-changed',
        message: 'Planned anchors are no longer ordered in current outline.',
      },
    };
  }
  return {
    material: materialBetweenAnchors(snapshot.source, snapshot.routine, startLine + 1, endLine - 1),
  };
}

function anchorEndLine(
  scanResult: BslRoutineLogicalScanResult,
  anchor: BslRoutineLogicalAnchor
): number | undefined {
  if (anchor.kind === 'sentinel') {
    if (!isValidSentinelKind(anchor.sentinel)) {
      return undefined;
    }
    const section = scanResult.outline.sections[anchor.sectionId];
    return anchor.sentinel === 'section-start' ? section?.startLine - 1 : section?.endLine;
  }
  return scanResult.outline.nodesByPath[anchor.path]?.range.endLine;
}

function anchorStartLine(
  snapshot: BslRoutineLogicalSnapshot,
  scanResult: BslRoutineLogicalScanResult,
  anchor: BslRoutineLogicalAnchor
): number | undefined {
  if (anchor.kind === 'sentinel') {
    if (!isValidSentinelKind(anchor.sentinel)) {
      return undefined;
    }
    const section = scanResult.outline.sections[anchor.sectionId];
    return anchor.sentinel === 'section-start' ? section?.startLine : snapshot.routine.range.endLine;
  }
  return scanResult.outline.nodesByPath[anchor.path]?.range.startLine;
}

function sameRoutineProvenance(
  left: BslRoutineLogicalMergePlan['routine'],
  right: BslRoutineLogicalMergePlan['routine']
): boolean {
  return (
    left.normalizedName === right.normalizedName &&
    left.kind === right.kind &&
    left.signatureHash === right.signatureHash &&
    left.directivesHash === right.directivesHash &&
    left.exported === right.exported
  );
}

function isValidSentinelKind(sentinel: string): boolean {
  return sentinel === 'section-start' || sentinel === 'section-end';
}
