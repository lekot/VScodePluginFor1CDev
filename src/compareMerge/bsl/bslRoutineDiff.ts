import { createHash } from 'crypto';

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
  mergeBlockReason?: string;
}

export interface BslRoutineDiffSummary {
  added: number;
  changed: number;
  deleted: number;
  reordered: number;
  unchanged: number;
}

export interface BslNonRoutineChange {
  message: string;
}

export interface BslRoutineDiffResult {
  moduleId: string;
  leftIdentity: BslModuleIdentity;
  rightIdentity: BslModuleIdentity;
  routines: BslRoutineDiffItem[];
  diagnostics: BslModuleDiagnostic[];
  nonRoutineChange?: BslNonRoutineChange;
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
  if (input.left.analysisState === 'deferred') {
    diagnostics.push(analysisRequiredDiagnostic(input.left.identity));
  }
  if (input.right.analysisState === 'deferred') {
    diagnostics.push(analysisRequiredDiagnostic(input.right.identity));
  }

  const blocksAutoMatch =
    Boolean(identityDiagnostic) ||
    input.left.analysisState === 'deferred' ||
    input.right.analysisState === 'deferred' ||
    diagnostics.some(
      (diagnostic) =>
        diagnostic.blocking ||
        diagnostic.code === 'BSL_MODULE_DUPLICATE_ROUTINE' ||
        diagnostic.code === 'BSL_MODULE_PARSE_ERROR'
    );
  const nonRoutineChange = compareNonRoutineContent(input.left, input.right);

  if (blocksAutoMatch) {
    return createResult(input, [], diagnostics, false, nonRoutineChange);
  }

  const routines = blockUnsafeAddedRoutines(
    diffRoutines(input.left.routines, input.right.routines),
    input.right
  );
  return createResult(input, routines, diagnostics, true, nonRoutineChange);
}

function analysisRequiredDiagnostic(identity: BslModuleIdentity): BslModuleDiagnostic {
  return {
    severity: 'error',
    code: 'BSL_MODULE_ANALYSIS_REQUIRED',
    blocking: true,
    message: `Полный анализ процедур модуля ${identity.moduleId} не выполнен; автоматическое сравнение заблокировано.`,
    sourceId: identity.sourceId,
    side: identity.side,
    filePath: identity.filePath,
    moduleId: identity.moduleId,
  };
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
    const rightMatch = rightByName.get(left.normalizedName);
    if (!rightMatch) {
      items.push({
        name: left.name,
        normalizedName: left.normalizedName,
        status: 'deleted',
        left,
        leftIndex,
      });
      return;
    }

    const right = rightMatch.routine;
    const rightIndex = rightMatch.index;
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

interface IndexedRoutine {
  routine: BslRoutineInfo;
  index: number;
}

function indexByRoutineName(routines: readonly BslRoutineInfo[]): Map<string, IndexedRoutine> {
  const index = new Map<string, IndexedRoutine>();
  routines.forEach((routine, routineIndex) => {
    index.set(routine.normalizedName, { routine, index: routineIndex });
  });

  return index;
}

function compareNonRoutineContent(
  left: BslModuleIndexEntry,
  right: BslModuleIndexEntry
): BslNonRoutineChange | undefined {
  if (!left.nonRoutineSegmentFingerprints || !right.nonRoutineSegmentFingerprints) {
    return undefined;
  }
  const commonRoutineNames = commonRoutinesByName(left.routines, right.routines);
  const hasNormalizedSegments = Boolean(left.nonRoutineSegments && right.nonRoutineSegments);
  const outsideSegmentsChanged = !sameOutsideAnchors(
    outsideSegmentsByCommonAnchors(left, commonRoutineNames, hasNormalizedSegments),
    outsideSegmentsByCommonAnchors(right, commonRoutineNames, hasNormalizedSegments)
  );
  const conditionalContextChanged = haveCommonRoutineContextsChanged(left, right, commonRoutineNames);
  if (!outsideSegmentsChanged && !conditionalContextChanged) {
    return undefined;
  }

  return {
    message: 'Обнаружены изменения вне процедур; требуется ручное сравнение всего модуля.',
  };
}

function commonRoutinesByName(
  leftRoutines: readonly BslRoutineInfo[],
  rightRoutines: readonly BslRoutineInfo[]
): Set<string> {
  const rightNames = new Set(rightRoutines.map((routine) => routine.normalizedName));
  return new Set(
    leftRoutines
      .filter((routine) => rightNames.has(routine.normalizedName))
      .map((routine) => routine.normalizedName)
  );
}

function outsideSegmentsByCommonAnchors(
  entry: BslModuleIndexEntry,
  commonRoutineNames: ReadonlySet<string>,
  useNormalizedSegments: boolean
): Map<string, string> {
  const segments = useNormalizedSegments
    ? entry.nonRoutineSegments ?? []
    : entry.nonRoutineSegmentFingerprints ?? [];
  const anchored = new Map<string, string>();
  const expectedSegmentCount = entry.routines.length + 1;
  if (segments.length !== expectedSegmentCount) {
    anchored.set('invalid-layout', 'invalid-layout');
  }

  let previousCommonName: string | undefined;
  let pendingSegments: string[] = [];
  for (let index = 0; index < entry.routines.length; index += 1) {
    appendOutsideSegment(pendingSegments, segments[index]);
    const routine = entry.routines[index];
    if (!routine || !commonRoutineNames.has(routine.normalizedName)) {
      continue;
    }
    const anchor = previousCommonName
      ? `between:${previousCommonName}:${routine.normalizedName}`
      : 'prefix';
    saveAnchoredSegment(anchored, anchor, pendingSegments, useNormalizedSegments);
    pendingSegments = [];
    previousCommonName = routine.normalizedName;
  }

  appendOutsideSegment(pendingSegments, segments[entry.routines.length]);
  saveAnchoredSegment(
    anchored,
    previousCommonName ? 'suffix' : 'module',
    pendingSegments,
    useNormalizedSegments
  );
  return anchored;
}

function appendOutsideSegment(segments: string[], fingerprint: string | undefined): void {
  if (fingerprint) {
    segments.push(fingerprint);
  }
}

function saveAnchoredSegment(
  target: Map<string, string>,
  anchor: string,
  segments: readonly string[],
  useNormalizedSegments: boolean
): void {
  if (segments.length > 0) {
    const joined = segments.join(useNormalizedSegments ? '\n' : ':');
    target.set(
      anchor,
      useNormalizedSegments ? hashNonRoutineSegment(joined) : joined
    );
  }
}

function hashNonRoutineSegment(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function sameOutsideAnchors(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [anchor, fingerprint] of left) {
    if (right.get(anchor) !== fingerprint) {
      return false;
    }
  }
  return true;
}

function haveCommonRoutineContextsChanged(
  left: BslModuleIndexEntry,
  right: BslModuleIndexEntry,
  commonRoutineNames: ReadonlySet<string>
): boolean {
  const leftContexts = left.routineConditionalContextFingerprints;
  const rightContexts = right.routineConditionalContextFingerprints;
  if (!leftContexts || !rightContexts) {
    return false;
  }

  const rightByName = indexByRoutineName(right.routines);
  for (const [leftIndex, routine] of left.routines.entries()) {
    if (!commonRoutineNames.has(routine.normalizedName)) {
      continue;
    }
    const rightMatch = rightByName.get(routine.normalizedName);
    const leftContext = leftContexts[leftIndex];
    const rightContext = rightMatch ? rightContexts[rightMatch.index] : undefined;
    if (leftContext === undefined || rightContext === undefined || leftContext !== rightContext) {
      return true;
    }
  }
  return false;
}

function blockUnsafeAddedRoutines(
  routines: BslRoutineDiffItem[],
  right: BslModuleIndexEntry
): BslRoutineDiffItem[] {
  return routines.map((routine) => {
    if (routine.status !== 'added' || routine.rightIndex === undefined) {
      return routine;
    }
    const context = right.routineConditionalContextFingerprints?.[routine.rightIndex];
    if (context === '') {
      return routine;
    }
    return {
      ...routine,
      mergeBlockReason: context === undefined
        ? 'Условный контекст новой рутины не подтверждён; требуется ручное добавление.'
        : 'Новая рутина расположена внутри условных директив; автоматическое добавление небезопасно.',
    };
  });
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
  canAutoMatch: boolean,
  nonRoutineChange?: BslNonRoutineChange
): BslRoutineDiffResult {
  return {
    moduleId: input.left.identity.moduleId,
    leftIdentity: input.left.identity,
    rightIdentity: input.right.identity,
    routines,
    diagnostics,
    ...(nonRoutineChange ? { nonRoutineChange } : {}),
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
