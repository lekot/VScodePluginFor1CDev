import type { BslRoutineInfo } from '../../bsl/bslRoutineTypes';
import type {
  BslModuleDiagnostic,
  BslModuleIndexEntry,
  BslModuleIdentity,
} from './bslModuleIndexer';

export type BslRoutineDiffStatus = 'added' | 'changed' | 'deleted' | 'reordered' | 'unchanged';

export interface BslRoutineDiffItem {
  name: string;
  normalizedName: string;
  status: BslRoutineDiffStatus;
  left?: BslRoutineInfo;
  right?: BslRoutineInfo;
  leftIndex?: number;
  rightIndex?: number;
}

export interface BslRoutineDiffSummary {
  added: number;
  changed: number;
  deleted: number;
  reordered: number;
  unchanged: number;
}

export interface BslRoutineDiffResult {
  moduleId: string;
  leftIdentity: BslModuleIdentity;
  rightIdentity: BslModuleIdentity;
  routines: BslRoutineDiffItem[];
  diagnostics: BslModuleDiagnostic[];
  canAutoMatch: boolean;
  summary: BslRoutineDiffSummary;
}

export interface BslRoutineDiffInput {
  left: BslModuleIndexEntry;
  right: BslModuleIndexEntry;
}

export function diffBslModules(input: BslRoutineDiffInput): BslRoutineDiffResult {
  const diagnostics = [...input.left.diagnostics, ...input.right.diagnostics];
  const identityDiagnostic = validateIdentity(input.left.identity, input.right.identity);
  if (identityDiagnostic) {
    diagnostics.push(identityDiagnostic);
  }

  const blocksAutoMatch =
    Boolean(identityDiagnostic) ||
    diagnostics.some(
      (diagnostic) =>
        diagnostic.blocking ||
        diagnostic.code === 'BSL_MODULE_DUPLICATE_ROUTINE' ||
        diagnostic.code === 'BSL_MODULE_PARSE_ERROR'
    );

  if (blocksAutoMatch) {
    return createResult(input, [], diagnostics, false);
  }

  const routines = diffRoutines(input.left.routines, input.right.routines);
  return createResult(input, routines, diagnostics, true);
}

function diffRoutines(
  leftRoutines: readonly BslRoutineInfo[],
  rightRoutines: readonly BslRoutineInfo[]
): BslRoutineDiffItem[] {
  const rightByName = indexByRoutineName(rightRoutines);
  const leftByName = indexByRoutineName(leftRoutines);
  const leftCommonRoutines = leftRoutines.filter((routine) =>
    rightByName.has(routine.normalizedName)
  );
  const rightCommonRoutines = rightRoutines.filter((routine) =>
    leftByName.has(routine.normalizedName)
  );
  const leftCommonIndexByName = indexCommonRoutineOrder(leftCommonRoutines);
  const rightCommonIndexByName = indexCommonRoutineOrder(rightCommonRoutines);
  const orderChanged = leftCommonRoutines.some(
    (routine, index) => rightCommonRoutines[index]?.normalizedName !== routine.normalizedName
  );
  const items: BslRoutineDiffItem[] = [];

  leftRoutines.forEach((left, leftIndex) => {
    const right = rightByName.get(left.normalizedName);
    if (!right) {
      items.push({
        name: left.name,
        normalizedName: left.normalizedName,
        status: 'deleted',
        left,
        leftIndex,
      });
      return;
    }

    const rightIndex = rightRoutines.indexOf(right);
    const leftCommonIndex = leftCommonIndexByName.get(left.normalizedName);
    const rightCommonIndex = rightCommonIndexByName.get(left.normalizedName);
    const status = routineChanged(left, right)
      ? 'changed'
      : orderChanged && leftCommonIndex !== rightCommonIndex
        ? 'reordered'
        : 'unchanged';
    items.push({
      name: left.name,
      normalizedName: left.normalizedName,
      status,
      left,
      right,
      leftIndex,
      rightIndex,
    });
  });

  rightRoutines.forEach((right, rightIndex) => {
    if (leftByName.has(right.normalizedName)) {
      return;
    }

    items.push({
      name: right.name,
      normalizedName: right.normalizedName,
      status: 'added',
      right,
      rightIndex,
    });
  });

  return items;
}

function routineChanged(left: BslRoutineInfo, right: BslRoutineInfo): boolean {
  return (
    left.kind !== right.kind ||
    left.bodyHash !== right.bodyHash ||
    normalizeText(left.parameterText) !== normalizeText(right.parameterText) ||
    left.exported !== right.exported ||
    left.directives.join('\n') !== right.directives.join('\n')
  );
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function indexByRoutineName(routines: readonly BslRoutineInfo[]): Map<string, BslRoutineInfo> {
  const index = new Map<string, BslRoutineInfo>();
  for (const routine of routines) {
    index.set(routine.normalizedName, routine);
  }

  return index;
}

function indexCommonRoutineOrder(routines: readonly BslRoutineInfo[]): Map<string, number> {
  const index = new Map<string, number>();
  routines.forEach((routine, routineIndex) => {
    index.set(routine.normalizedName, routineIndex);
  });

  return index;
}

function validateIdentity(
  left: BslModuleIdentity,
  right: BslModuleIdentity
): BslModuleDiagnostic | undefined {
  if (left.moduleId === right.moduleId) {
    return undefined;
  }

  return {
    severity: 'error',
    code: 'BSL_MODULE_IDENTITY_MISMATCH',
    blocking: true,
    message: `Cannot compare different BSL modules: "${left.moduleId}" vs "${right.moduleId}".`,
    sourceId: left.sourceId,
    side: left.side,
    filePath: left.filePath,
    moduleId: left.moduleId,
  };
}

function createResult(
  input: BslRoutineDiffInput,
  routines: BslRoutineDiffItem[],
  diagnostics: BslModuleDiagnostic[],
  canAutoMatch: boolean
): BslRoutineDiffResult {
  return {
    moduleId: input.left.identity.moduleId,
    leftIdentity: input.left.identity,
    rightIdentity: input.right.identity,
    routines,
    diagnostics,
    canAutoMatch,
    summary: summarize(routines),
  };
}

function summarize(routines: readonly BslRoutineDiffItem[]): BslRoutineDiffSummary {
  const summary: BslRoutineDiffSummary = {
    added: 0,
    changed: 0,
    deleted: 0,
    reordered: 0,
    unchanged: 0,
  };

  for (const routine of routines) {
    summary[routine.status] += 1;
  }

  return summary;
}
