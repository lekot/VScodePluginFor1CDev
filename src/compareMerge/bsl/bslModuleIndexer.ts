import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { parseBslRoutines } from '../../bsl/routineRangeProvider';
import type { BslRoutineDiagnostic, BslRoutineInfo, BslTextRange } from '../../bsl/bslRoutineTypes';
import {
  getStandardModuleByFileName,
  getStandardModuleFileName,
  type StandardModuleKind,
} from '../../constants/metadataModuleDescriptors';
import type { CompareSide, CompareMessageSeverity } from '../domain/compareContracts';
import {
  locateMetadataFile,
  type MetadataFileSubPath,
  type MetadataLocation,
} from '../../services/metadataFileLocator';
import { MetadataType } from '../../models/treeNode';
import { MetadataTypeMapper } from '../../utils/metadataTypeMapper';
import {
  type CompareCancellationToken,
  throwIfCompareCancelled,
} from '../compareCancellation';

const BSL_MODULE_INDEX_YIELD_BATCH = 64;
const BSL_MODULE_INDEX_YIELD_INTERVAL_MS = 8;

export type SupportedBslModuleKind =
  | 'Object'
  | 'Manager'
  | 'RecordSet'
  | 'ValueManager'
  | 'CommonModule'
  | 'Form'
  | 'Command';

export type BslModuleDiagnosticCode =
  | 'BSL_MODULE_IDENTITY_MISMATCH'
  | 'BSL_MODULE_DUPLICATE_ROUTINE'
  | 'BSL_MODULE_PARSE_ERROR'
  | 'BSL_MODULE_READ_FAILED'
  | 'BSL_MODULE_UNSUPPORTED_KIND'
  | 'BSL_MODULE_UNSUPPORTED_PATH'
  | 'BSL_MODULE_ANALYSIS_REQUIRED';

export interface BslModuleIdentity {
  sourceId: string;
  side: CompareSide;
  filePath: string;
  configRoot: string;
  metadataType: string;
  objectName: string;
  moduleKind: SupportedBslModuleKind;
  moduleId: string;
  displayName: string;
  formName?: string;
  commandName?: string;
  extensionName?: string;
}

export interface BslModuleDiagnostic {
  severity: CompareMessageSeverity;
  code: BslModuleDiagnosticCode;
  blocking: boolean;
  message: string;
  sourceId: string;
  side: CompareSide;
  filePath: string;
  moduleId?: string;
  routineName?: string;
  range?: BslTextRange;
}

export interface BslModuleIndexEntry {
  identity: BslModuleIdentity;
  routines: BslRoutineInfo[];
  diagnostics: BslModuleDiagnostic[];
  /** Fingerprint for each gap before, between, and after parsed routine ranges. */
  nonRoutineSegmentFingerprints?: string[];
  /** Normalized nonblank source text for each gap, used to fold gaps after routine insertions. */
  nonRoutineSegments?: string[];
  /** Conditional preprocessor context aligned to each routine in `routines`. */
  routineConditionalContextFingerprints?: string[];
  /** Omitted means complete for compatibility with existing index entries. */
  analysisState?: 'complete' | 'deferred';
}

export interface BslModuleIndexResult {
  modules: BslModuleIndexEntry[];
  diagnostics: BslModuleDiagnostic[];
}

export interface BslModuleFileInput {
  sourceId: string;
  side: CompareSide;
  filePath: string;
  configRoots: readonly string[];
  source?: string;
}

export type BslModuleLocationResolver = (
  filePath: string,
  configRoots: readonly string[]
) => MetadataLocation | null;

export interface BslModuleSourceInput {
  identity: BslModuleIdentity;
  source: string;
}

export async function buildBslModuleIndex(
  inputs: readonly BslModuleFileInput[],
  cancellation?: CompareCancellationToken,
): Promise<BslModuleIndexResult> {
  const modules: BslModuleIndexEntry[] = [];
  const diagnostics: BslModuleDiagnostic[] = [];
  let completedSinceYield = 0;
  let lastYieldAt: number | undefined;

  for (const input of inputs) {
    throwIfCompareCancelled(cancellation);
    lastYieldAt ??= performance.now();
    const result = await indexBslModuleFile(input);
    throwIfCompareCancelled(cancellation);
    diagnostics.push(...result.diagnostics);
    modules.push(...result.modules);
    completedSinceYield += 1;
    if (completedSinceYield >= BSL_MODULE_INDEX_YIELD_BATCH
      || performance.now() - lastYieldAt >= BSL_MODULE_INDEX_YIELD_INTERVAL_MS) {
      completedSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfCompareCancelled(cancellation);
      lastYieldAt = performance.now();
    }
  }

  return { modules, diagnostics };
}

export async function indexBslModuleFile(input: BslModuleFileInput): Promise<BslModuleIndexResult> {
  const identityResult = resolveSupportedBslModuleIdentity(input);
  if (!identityResult.identity) {
    return { modules: [], diagnostics: [identityResult.diagnostic] };
  }

  let source = input.source;
  if (source === undefined) {
    try {
      source = await fs.readFile(input.filePath, 'utf-8');
    } catch (error) {
      return {
        modules: [],
        diagnostics: [
          createDiagnostic(input, {
            code: 'BSL_MODULE_READ_FAILED',
            message: `Failed to read BSL module: ${error instanceof Error ? error.message : String(error)}`,
            moduleId: identityResult.identity.moduleId,
          }),
        ],
      };
    }
  }

  const entry = indexBslModuleSource({
    identity: identityResult.identity,
    source,
  });

  return {
    modules: [entry],
    diagnostics: entry.diagnostics,
  };
}

export function indexBslModuleSource(input: BslModuleSourceInput): BslModuleIndexEntry {
  const parsed = parseBslRoutines(input.source);
  const diagnostics = parsed.diagnostics.map((diagnostic) =>
    convertRoutineDiagnostic(input.identity, diagnostic)
  );
  const lines = normalizedModuleLines(input.source);
  const nonRoutineSegments = collectNonRoutineSegments(lines, parsed.routines);

  return {
    identity: input.identity,
    routines: parsed.routines,
    diagnostics,
    nonRoutineSegmentFingerprints: nonRoutineSegments.map(fingerprintNonRoutineSegment),
    nonRoutineSegments,
    routineConditionalContextFingerprints: fingerprintRoutineConditionalContexts(lines, parsed.routines),
  };
}

function normalizedModuleLines(source: string): string[] {
  return source.replace(/\r\n/gu, '\n').split('\n');
}

export function fingerprintBslRoutineConditionalContexts(
  source: string,
  routines: readonly BslRoutineInfo[]
): string[] {
  return fingerprintRoutineConditionalContexts(normalizedModuleLines(source), routines);
}

function collectNonRoutineSegments(
  lines: readonly string[],
  routines: readonly BslRoutineInfo[]
): string[] {
  const excludedLines = new Set<number>();
  for (const routine of routines) {
    for (let line = routine.range.startLine - 1; line < routine.range.endLine; line += 1) {
      excludedLines.add(line);
    }
    markAttachedDirectiveLines(lines, routine, excludedLines);
  }

  const segments: string[] = [];
  let nextLine = 0;
  for (const routine of routines) {
    const routineStart = Math.max(nextLine, routine.range.startLine - 1);
    segments.push(collectOutsideGap(lines, nextLine, routineStart, excludedLines));
    nextLine = Math.max(nextLine, routine.range.endLine);
  }
  segments.push(collectOutsideGap(lines, nextLine, lines.length, excludedLines));
  return segments;
}

function collectOutsideGap(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  excludedLines: ReadonlySet<number>
): string {
  const sourceLines: string[] = [];
  for (let line = startLine; line < endLine; line += 1) {
    const text = lines[line] ?? '';
    if (!excludedLines.has(line) && text.trim().length > 0) {
      sourceLines.push(text);
    }
  }
  return sourceLines.join('\n');
}

function fingerprintNonRoutineSegment(source: string): string {
  return source.length === 0 ? '' : createHash('sha256').update(source).digest('hex');
}

function markAttachedDirectiveLines(
  lines: readonly string[],
  routine: BslRoutineInfo,
  excludedLines: Set<number>
): void {
  let line = routine.range.startLine - 2;
  for (let directive = routine.directives.length - 1; directive >= 0; directive -= 1) {
    while (line >= 0 && lines[line]?.trim().length === 0) {
      line -= 1;
    }
    if (line < 0 || normalizeRoutineDirective(lines[line] ?? '') !== routine.directives[directive]) {
      return;
    }
    excludedLines.add(line);
    line -= 1;
  }
}

function normalizeRoutineDirective(line: string): string {
  return line.trim().replace(/^\uFEFF/u, '');
}

interface ConditionalPreprocessorFrame {
  condition: string;
  branch: string;
}

interface ConditionalPreprocessorDirective {
  kind: 'if' | 'elseif' | 'else' | 'endif';
  condition: string;
}

function fingerprintRoutineConditionalContexts(
  lines: readonly string[],
  routines: readonly BslRoutineInfo[]
): string[] {
  const routineIndexByStartLine = new Map<number, number>();
  routines.forEach((routine, index) => routineIndexByStartLine.set(routine.range.startLine, index));
  const contexts = routines.map(() => '');
  const stack: ConditionalPreprocessorFrame[] = [];
  let malformed = false;

  lines.forEach((line, index) => {
    const routineIndex = routineIndexByStartLine.get(index + 1);
    if (routineIndex !== undefined) {
      contexts[routineIndex] = conditionalContextFingerprint(stack, malformed);
    }
    const directive = parseConditionalPreprocessorDirective(line);
    if (directive) {
      malformed = updateConditionalPreprocessorStack(directive, stack) || malformed;
    }
  });

  if (stack.length > 0) {
    return contexts.map((context) => (context.length > 0 ? `invalid:${context}` : context));
  }
  return contexts;
}

function parseConditionalPreprocessorDirective(
  line: string
): ConditionalPreprocessorDirective | undefined {
  const match = /^\s*#\s*(ИначеЕсли|КонецЕсли|Если|Иначе|ElseIf|ElsIf|EndIf|If|Else)(?=\s|$)(.*)$/iu.exec(line);
  if (!match) {
    return undefined;
  }

  const keyword = match[1]!.toLowerCase();
  const condition = match[2]!.trim();
  if (keyword === 'если' || keyword === 'if') {
    return { kind: 'if', condition };
  }
  if (keyword === 'иначеесли' || keyword === 'elseif' || keyword === 'elsif') {
    return { kind: 'elseif', condition };
  }
  if (keyword === 'иначе' || keyword === 'else') {
    return { kind: 'else', condition: '' };
  }
  return { kind: 'endif', condition: '' };
}

function updateConditionalPreprocessorStack(
  directive: ConditionalPreprocessorDirective,
  stack: ConditionalPreprocessorFrame[]
): boolean {
  const topFrame = stack[stack.length - 1];
  switch (directive.kind) {
    case 'if':
      stack.push({ condition: directive.condition, branch: 'if' });
      return false;
    case 'elseif':
      if (!topFrame || topFrame.branch === 'else') {
        return true;
      }
      topFrame.branch = `elseif:${directive.condition}`;
      return false;
    case 'else':
      if (!topFrame || topFrame.branch === 'else') {
        return true;
      }
      topFrame.branch = 'else';
      return false;
    case 'endif':
      if (!topFrame) {
        return true;
      }
      stack.pop();
      return false;
    default:
      return assertNever(directive.kind);
  }
}

function conditionalContextFingerprint(
  stack: readonly ConditionalPreprocessorFrame[],
  malformed: boolean
): string {
  if (stack.length === 0 && !malformed) {
    return '';
  }
  return `${malformed ? 'invalid:' : ''}${JSON.stringify(stack)}`;
}

export function resolveSupportedBslModuleIdentity(
  input: BslModuleFileInput,
  locationResolver: BslModuleLocationResolver = locateMetadataFile
): {
  identity?: BslModuleIdentity;
  diagnostic: BslModuleDiagnostic;
} {
  const location = locationResolver(input.filePath, input.configRoots);
  if (!location?.subPath) {
    return {
      diagnostic: createDiagnostic(input, {
        code: 'BSL_MODULE_UNSUPPORTED_PATH',
        message: 'BSL module path is not a supported metadata module path.',
      }),
    };
  }

  const identity = createIdentity(input, location, location.subPath);
  if (!identity) {
    return {
      diagnostic: createDiagnostic(input, {
        code: 'BSL_MODULE_UNSUPPORTED_KIND',
        message: `BSL module kind "${location.subPath.kind}" is not supported by procedural diff.`,
      }),
    };
  }

  return {
    identity,
    diagnostic: createDiagnostic(input, {
      code: 'BSL_MODULE_UNSUPPORTED_PATH',
      message: 'No diagnostic.',
      moduleId: identity.moduleId,
      blocking: false,
      severity: 'info',
    }),
  };
}

function createIdentity(
  input: BslModuleFileInput,
  location: MetadataLocation,
  subPath: MetadataFileSubPath
): BslModuleIdentity | undefined {
  const ownerType = metadataTypeFromFolder(location.objectType);
  const extensionName = location.extensionName;
  const base = {
    sourceId: input.sourceId,
    side: input.side,
    filePath: input.filePath,
    configRoot: location.configRoot,
    metadataType: ownerType,
    objectName: location.objectName,
    ...(extensionName !== undefined ? { extensionName } : {}),
  };

  switch (subPath.kind) {
    case 'objectModule':
    case 'managerModule':
    case 'recordSetModule':
    case 'valueManagerModule':
    case 'commonModule':
      return createRegisteredModuleIdentity(input, location, base, subPath.kind);
    case 'form':
      return createFormModuleIdentity(base, ownerType, location, subPath);
    case 'command':
      return createCommandModuleIdentity(base, ownerType, location, subPath);
    case 'template':
    case 'rights':
    case 'predefinedData':
      return undefined;
    default:
      return assertNever(subPath);
  }
}

type RegisteredModuleSubPathKind = Extract<
  MetadataFileSubPath['kind'],
  'objectModule' | 'managerModule' | 'recordSetModule' | 'valueManagerModule' | 'commonModule'
>;

interface RegisteredModuleIdentitySpec {
  readonly standardKind: StandardModuleKind;
  readonly moduleKind: SupportedBslModuleKind;
  readonly identitySuffix?: string;
}

function createRegisteredModuleIdentity(
  input: BslModuleFileInput,
  location: MetadataLocation,
  base: Omit<BslModuleIdentity, 'moduleKind' | 'moduleId' | 'displayName' | 'formName' | 'commandName'>,
  subPathKind: RegisteredModuleSubPathKind
): BslModuleIdentity | undefined {
  const spec = registeredModuleIdentitySpec(subPathKind);
  if (!spec) {return undefined;}
  const metadataType = MetadataTypeMapper.map(location.objectType);
  if (metadataType === MetadataType.Unknown) {return undefined;}
  const fileName = getStandardModuleFileName(metadataType, spec.standardKind);
  if (!fileName || path.basename(input.filePath).toLocaleLowerCase('en-US') !== fileName.toLocaleLowerCase('en-US')) {
    return undefined;
  }
  const descriptor = getStandardModuleByFileName(metadataType, fileName);
  if (descriptor?.kind !== spec.standardKind) {return undefined;}

  const localModuleId = spec.identitySuffix === undefined
    ? `CommonModule.${location.objectName}`
    : `${metadataType}.${location.objectName}.${spec.identitySuffix}`;
  return moduleIdentity(base, localModuleId, { moduleKind: spec.moduleKind });
}

function registeredModuleIdentitySpec(
  kind: RegisteredModuleSubPathKind
): RegisteredModuleIdentitySpec | undefined {
  switch (kind) {
    case 'objectModule':
      return { standardKind: 'ObjectModule', moduleKind: 'Object', identitySuffix: 'Object' };
    case 'managerModule':
      return { standardKind: 'ManagerModule', moduleKind: 'Manager', identitySuffix: 'Manager' };
    case 'recordSetModule':
      return { standardKind: 'RecordSetModule', moduleKind: 'RecordSet', identitySuffix: 'RecordSet' };
    case 'valueManagerModule':
      return { standardKind: 'ValueManagerModule', moduleKind: 'ValueManager', identitySuffix: 'ValueManager' };
    case 'commonModule':
      return { standardKind: 'CommonModule', moduleKind: 'CommonModule' };
    default:
      return assertNever(kind);
  }
}

function createFormModuleIdentity(
  base: Omit<BslModuleIdentity, 'moduleKind' | 'moduleId' | 'displayName' | 'formName' | 'commandName'>,
  ownerType: string,
  location: MetadataLocation,
  subPath: Extract<MetadataFileSubPath, { kind: 'form' }>
): BslModuleIdentity | undefined {
  if (subPath.subFile !== 'module') {return undefined;}
  const localModuleId = ownerType === 'CommonForm'
    ? `CommonForm.${location.objectName}.FormModule`
    : `${ownerType}.${location.objectName}.Form.${subPath.name}.FormModule`;
  return moduleIdentity(base, localModuleId, { moduleKind: 'Form', formName: subPath.name });
}

function createCommandModuleIdentity(
  base: Omit<BslModuleIdentity, 'moduleKind' | 'moduleId' | 'displayName' | 'formName' | 'commandName'>,
  ownerType: string,
  location: MetadataLocation,
  subPath: Extract<MetadataFileSubPath, { kind: 'command' }>
): BslModuleIdentity | undefined {
  if (subPath.subFile !== 'module') {return undefined;}
  const localModuleId = ownerType === 'CommonCommand'
    ? `CommonCommand.${location.objectName}.CommandModule`
    : `${ownerType}.${location.objectName}.Command.${subPath.name}.CommandModule`;
  return moduleIdentity(base, localModuleId, { moduleKind: 'Command', commandName: subPath.name });
}

function moduleIdentity(
  base: Omit<
    BslModuleIdentity,
    'moduleKind' | 'moduleId' | 'displayName' | 'formName' | 'commandName'
  >,
  localModuleId: string,
  details: Pick<BslModuleIdentity, 'moduleKind'> &
    Partial<Pick<BslModuleIdentity, 'metadataType' | 'formName' | 'commandName'>>
): BslModuleIdentity {
  const moduleId = qualifyModuleId(localModuleId, base.extensionName);
  return {
    ...base,
    ...details,
    moduleId,
    displayName: moduleId,
  };
}

function qualifyModuleId(localModuleId: string, extensionName: string | undefined): string {
  return extensionName === undefined
    ? localModuleId
    : `Extension.${extensionName}.${localModuleId}`;
}

function convertRoutineDiagnostic(
  identity: BslModuleIdentity,
  diagnostic: BslRoutineDiagnostic
): BslModuleDiagnostic {
  return {
    severity: diagnostic.severity,
    code:
      diagnostic.code === 'duplicate-routine'
        ? 'BSL_MODULE_DUPLICATE_ROUTINE'
        : 'BSL_MODULE_PARSE_ERROR',
    blocking: diagnostic.severity === 'error',
    message: diagnostic.message,
    sourceId: identity.sourceId,
    side: identity.side,
    filePath: identity.filePath,
    moduleId: identity.moduleId,
    routineName: diagnostic.routineName,
    range: diagnostic.range,
  };
}

function createDiagnostic(
  input: Pick<BslModuleFileInput, 'sourceId' | 'side' | 'filePath'>,
  diagnostic: {
    code: BslModuleDiagnosticCode;
    message: string;
    moduleId?: string;
    blocking?: boolean;
    severity?: CompareMessageSeverity;
  }
): BslModuleDiagnostic {
  return {
    severity: diagnostic.severity ?? 'error',
    code: diagnostic.code,
    blocking: diagnostic.blocking ?? true,
    message: diagnostic.message,
    sourceId: input.sourceId,
    side: input.side,
    filePath: input.filePath,
    moduleId: diagnostic.moduleId,
  };
}

function metadataTypeFromFolder(folderName: string): string {
  const mappedType = MetadataTypeMapper.map(folderName);
  return mappedType === MetadataType.Unknown ? singularizeMetadataFolder(folderName) : mappedType;
}

function singularizeMetadataFolder(folderName: string): string {
  if (folderName.endsWith('ies')) {
    return `${folderName.slice(0, -3)}y`;
  }
  if (folderName.endsWith('s')) {
    return folderName.slice(0, -1);
  }

  return folderName;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported metadata sub path: ${JSON.stringify(value)}`);
}
