import * as path from 'path';
import { pathToFileURL } from 'url';

import { parseBslRoutines } from '../../bsl/routineRangeProvider';
import type { BslRoutineInfo } from '../../bsl/bslRoutineTypes';
import { fingerprintBslRoutineConditionalContexts } from '../bsl/bslModuleIndexer';
import type { AdapterCompareInput, ExecutableCandidateFactory } from '../adapters/mergeAdapter';
import type { CompareMessage } from '../domain/compareContracts';
import type { CompareTreeNode } from '../compareTreeTypes';
import type { LinkedFormModuleSnapshot } from '../linkedDesignerTypes';
import { captureBslRoutineSpan } from '../linkedDesignerRoutineSpan';
import { canonicalFormModuleId, mapLinkedModulesByTargetPath } from '../linkedDesignerContext';
import { captureMergePath } from '../merge/mergeSnapshot';
import { MISSING_TARGET_HASH } from '../merge/mergePreview';
import { hashText } from '../bsl/bslRoutineLogicalScanner';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';

const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

export interface ExtensionLinkedRoutineSelection {
  readonly nodeId: string;
  readonly rowId: string;
  readonly moduleId: string;
  readonly candidateFactory: ExecutableCandidateFactory;
}

export interface ExtensionFormEventProjection {
  readonly context: NonNullable<AdapterCompareInput['linkedDesignerContext']>['formEventHandlers'];
  readonly module?: LinkedFormModuleSnapshot;
  readonly routineSelections: ReadonlyMap<string, ExtensionLinkedRoutineSelection>;
  readonly routineNodes: readonly CompareTreeNode[];
  readonly diagnostics: readonly CompareMessage[];
}

export function collectExtensionEventDependencies(input: {
  readonly nodes: readonly CompareTreeNode[];
  readonly capabilities: ExtensionFormEventProjection['context'];
  readonly module: LinkedFormModuleSnapshot;
  readonly output: Map<string, import('../linkedDesignerTypes').LinkedEventDependency>;
}): void {
  const byName = new Map(input.capabilities.map((item) => [item.name.trim().toLocaleLowerCase('en-US'), item]));
  for (const node of flattenNodes(input.nodes)) {
    if (!node.mergeable || node.status === 'leftOnly' || !isEventPointer(node.payloadRef ?? '')) {continue;}
    const value = node.rightValue?.trim() ?? '';
    const handlerName = eventHandlerName(value);
    if (!handlerName) {continue;}
    const capability = byName.get(handlerName.toLocaleLowerCase('en-US'));
    if (!capability) {continue;}
    input.output.set(node.id, {
      moduleId: input.module.moduleId,
      handlerName: capability.name,
      targetHasHandler: capability.targetHasHandler,
      ...(capability.incomingRoutineNodeId ? { incomingRoutineNodeId: capability.incomingRoutineNodeId } : {}),
      ...(capability.targetWitnesses?.length ? { targetWitnesses: capability.targetWitnesses } : {}),
    });
  }
}

/** Captures only a paired Form module needed to prove changed Event handler references. */
interface ExtensionFormEventInput {
  readonly row: ExtensionTransferRow;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly targetOwner: ExtensionIndexedObject;
  readonly incomingOwner: ExtensionIndexedObject;
  readonly targetFormPath: string;
  readonly sourceFormPath: string;
  readonly targetFormXml: Buffer;
  readonly sourceFormXml: Buffer;
  readonly rightSnapshotId: string;
}

type FormModuleFile = ExtensionIndexedObject['sidecarFiles'][number];
type ParsedBslModule = ReturnType<typeof parseBslRoutines>;

interface CapturedFormModules {
  readonly targetModulePath: string;
  readonly targetFile?: FormModuleFile;
  readonly sourceFile?: FormModuleFile;
  readonly targetContent?: Buffer;
  readonly sourceContent?: Buffer;
  readonly failure?: string;
}

interface FormHandlerProjectionState {
  readonly input: ExtensionFormEventInput;
  readonly capture: CapturedFormModules;
  readonly targetText?: string;
  readonly sourceText?: string;
  readonly targetIndex?: ParsedBslModule;
  readonly sourceIndex?: ParsedBslModule;
  readonly targetHasParseErrors: boolean;
  readonly sourceHasParseErrors: boolean;
  readonly sourceRoutinesByName: Map<string, IndexedBslRoutine[]>;
  readonly sourceConditionalContexts?: readonly string[];
  readonly moduleId: string;
  readonly targetPath: string;
  readonly sourcePath?: string;
  readonly routineSelections: Map<string, ExtensionLinkedRoutineSelection>;
  readonly routineCandidateIds: Map<string, string>;
  readonly routineNodes: CompareTreeNode[];
}

interface FormHandlerCapability {
  readonly name: string;
  readonly targetHasHandler: boolean;
  readonly incomingRoutineNodeId?: string;
  readonly targetWitnesses?: NonNullable<AdapterCompareInput['linkedDesignerContext']>['formEventHandlers'][number]['targetWitnesses'];
}

export async function projectExtensionFormEventHandlers(
  input: ExtensionFormEventInput
): Promise<ExtensionFormEventProjection> {
  const capture = await captureFormModules(input);
  if (capture.failure) {
    return projectionFailure(input, capture.failure);
  }

  const state = buildFormHandlerProjectionState(input, capture);
  const context = eventHandlers(input.sourceFormXml).map((name) => projectFormHandler(name, state));
  const module = createFormModuleSnapshot(state);
  return {
    context,
    module,
    routineSelections: state.routineSelections,
    routineNodes: state.routineNodes,
    diagnostics: [],
  };
}

async function captureFormModules(input: ExtensionFormEventInput): Promise<CapturedFormModules> {
  const targetModulePath = path.posix.join(path.posix.dirname(input.targetFormPath), 'Form', 'Module.bsl');
  const sourceModulePath = path.posix.join(path.posix.dirname(input.sourceFormPath), 'Form', 'Module.bsl');
  const targetFiles = input.targetOwner.sidecarFiles.filter((file) => samePath(file.relativePath, targetModulePath));
  const sourceFiles = input.incomingOwner.sidecarFiles.filter((file) => samePath(file.relativePath, sourceModulePath));
  const result: CapturedFormModules = { targetModulePath, targetFile: targetFiles[0], sourceFile: sourceFiles[0] };
  if (targetFiles.length > 1 || sourceFiles.length > 1) {
    return { ...result, failure: 'Module формы имеет неоднозначный sidecar path.' };
  }

  const [targetContent, sourceContent] = await Promise.all([
    targetFiles[0] ? captureFile(input.targetRoot, input.targetOwner, targetFiles[0]) : Promise.resolve(undefined),
    sourceFiles[0] ? captureFile(input.incomingRoot, input.incomingOwner, sourceFiles[0]) : Promise.resolve(undefined),
  ]);
  if ((targetFiles[0] && !targetContent) || (sourceFiles[0] && !sourceContent)) {
    return { ...result, targetContent, sourceContent, failure: 'Не удалось подтвердить captured BSL module формы.' };
  }
  return { ...result, targetContent, sourceContent };
}

function buildFormHandlerProjectionState(
  input: ExtensionFormEventInput,
  capture: CapturedFormModules
): FormHandlerProjectionState {
  const targetText = capture.targetContent?.toString('utf8');
  const sourceText = capture.sourceContent?.toString('utf8');
  const targetIndex = targetText === undefined ? undefined : parseBslRoutines(targetText);
  const sourceIndex = sourceText === undefined ? undefined : parseBslRoutines(sourceText);
  const formName = path.posix.basename(path.posix.dirname(path.posix.dirname(input.targetFormPath)));
  const formType = input.row.incoming?.metadataType ?? input.row.target?.metadataType;
  const formQualifiedName = formType === 'CommonForm'
    ? input.row.qualifiedName
    : `${input.row.qualifiedName}.Form.${formName}`;
  return {
    input,
    capture,
    targetText,
    sourceText,
    targetIndex,
    sourceIndex,
    targetHasParseErrors: hasBslParseErrors(targetIndex),
    sourceHasParseErrors: hasBslParseErrors(sourceIndex),
    sourceRoutinesByName: indexRoutinesByName(sourceIndex?.routines ?? []),
    sourceConditionalContexts: sourceIndex && sourceText !== undefined
      ? fingerprintBslRoutineConditionalContexts(sourceText, sourceIndex.routines)
      : undefined,
    moduleId: canonicalFormModuleId(formQualifiedName),
    targetPath: capture.targetFile?.relativePath ?? capture.targetModulePath,
    sourcePath: capture.sourceFile?.relativePath,
    routineSelections: new Map(),
    routineCandidateIds: new Map(),
    routineNodes: [],
  };
}

function hasBslParseErrors(index: ParsedBslModule | undefined): boolean {
  return index?.diagnostics.some((item) => item.severity === 'error') ?? false;
}

function projectFormHandler(name: string, state: FormHandlerProjectionState): FormHandlerCapability {
  const normalized = name.toLocaleLowerCase('en-US');
  const targetMatches = state.targetIndex?.routines.filter((routine) => routine.normalizedName === normalized) ?? [];
  const targetHasHandler = Boolean(state.targetIndex && !state.targetHasParseErrors && targetMatches.length === 1);
  const sourceMatches = state.sourceRoutinesByName.get(normalized) ?? [];
  const sourceRoutine = findAddableSourceRoutine(sourceMatches, targetHasHandler, state);
  const incomingRoutineNodeId = sourceRoutine ? addIncomingFormRoutine(normalized, sourceRoutine, state) : undefined;
  return {
    name,
    targetHasHandler,
    ...(incomingRoutineNodeId ? { incomingRoutineNodeId } : {}),
    ...(state.capture.targetFile ? { targetWitnesses: [createTargetModuleWitness(state)] } : {}),
  };
}

function findAddableSourceRoutine(
  sourceMatches: readonly IndexedBslRoutine[],
  targetHasHandler: boolean,
  state: FormHandlerProjectionState
): IndexedBslRoutine | undefined {
  if (targetHasHandler || !state.sourceIndex || state.sourceHasParseErrors || sourceMatches.length !== 1
    || !state.sourcePath || !state.capture.sourceFile) {
    return undefined;
  }
  return sourceMatches[0];
}

function addIncomingFormRoutine(
  normalized: string,
  indexedRoutine: IndexedBslRoutine,
  state: FormHandlerProjectionState
): string | undefined {
  const { routine, index } = indexedRoutine;
  const nodeId = formRoutineNodeId(normalized, state);
  const context = state.sourceConditionalContexts?.[index];
  if (context !== '') {
    state.routineNodes.push(blockedFormEventRoutineNode({
      nodeId,
      moduleId: state.moduleId,
      routine,
      targetPath: state.targetPath,
      reason: conditionalHandlerBlockReason(context),
    }));
    return undefined;
  }

  const sourceSpan = state.sourceText === undefined ? undefined : captureBslRoutineSpan(state.sourceText, routine);
  if (!sourceSpan || !state.sourcePath || !state.capture.sourceFile) {
    return undefined;
  }
  const sourceTextForRoutine = sourceSpan.sourceText;
  const candidateFactory = createFormRoutineCandidate(nodeId, routine, sourceSpan, sourceTextForRoutine, state);
  state.routineCandidateIds.set(normalized, nodeId);
  state.routineSelections.set(nodeId, {
    nodeId,
    rowId: state.input.row.id,
    moduleId: state.moduleId,
    candidateFactory,
  });
  state.routineNodes.push(readyFormEventRoutineNode(nodeId, routine, sourceTextForRoutine, state));
  return nodeId;
}

function formRoutineNodeId(normalized: string, state: FormHandlerProjectionState): string {
  return `extension:bsl-routine:${state.input.row.id}:${encodeURIComponent(state.moduleId)}:${encodeURIComponent(normalized)}`;
}

function createFormRoutineCandidate(
  nodeId: string,
  routine: BslRoutineInfo,
  sourceSpan: NonNullable<ReturnType<typeof captureBslRoutineSpan>>,
  sourceTextForRoutine: string,
  state: FormHandlerProjectionState
): ExecutableCandidateFactory {
  return routineCandidateFactory({
    nodeId,
    row: state.input.row,
    rightSnapshotId: state.input.rightSnapshotId,
    targetPath: state.targetPath,
    sourcePath: state.sourcePath!,
    targetText: state.targetText,
    targetMissing: !state.capture.targetFile,
    targetSourceId: state.input.targetRoot.sourceId,
    sourceId: state.input.incomingRoot.sourceId,
    sourceText: sourceTextForRoutine,
    sourceHash: state.capture.sourceFile!.hash,
    routine,
    sourceTextRange: sourceSpan.sourceTextRange,
  });
}

function readyFormEventRoutineNode(
  nodeId: string,
  routine: BslRoutineInfo,
  sourceText: string,
  state: FormHandlerProjectionState
): CompareTreeNode {
  return {
    id: nodeId,
    label: `Процедура: ${routine.name}`,
    kind: 'bslRoutine',
    status: 'rightOnly',
    leftValue: '',
    rightValue: sourceText,
    mergeable: true,
    mergeState: { state: 'ready', targetFilePath: state.targetPath },
    presentation: { qualifiedName: state.moduleId },
    children: [],
  };
}

function createTargetModuleWitness(state: FormHandlerProjectionState): NonNullable<FormHandlerCapability['targetWitnesses']>[number] {
  return {
    sourceId: state.input.targetRoot.sourceId,
    relativePath: state.capture.targetFile!.relativePath,
    expectedHash: state.capture.targetFile!.hash,
    kind: 'file',
  };
}

function createFormModuleSnapshot(state: FormHandlerProjectionState): LinkedFormModuleSnapshot | undefined {
  if (!state.sourcePath || !state.capture.sourceFile) {
    return undefined;
  }
  return {
    moduleId: state.moduleId,
    targetRelativePath: state.targetPath,
    sourceRelativePath: state.sourcePath,
    targetHash: state.capture.targetFile?.hash ?? MISSING_TARGET_HASH,
    sourceHash: state.capture.sourceFile.hash,
    targetContent: state.targetText,
    sourceContent: state.sourceText,
    ...(!state.capture.targetFile ? { targetMissing: true as const } : {}),
    routineCandidateIds: state.routineCandidateIds,
  };
}

interface IndexedBslRoutine {
  readonly routine: BslRoutineInfo;
  readonly index: number;
}

function indexRoutinesByName(routines: readonly BslRoutineInfo[]): Map<string, IndexedBslRoutine[]> {
  const byName = new Map<string, IndexedBslRoutine[]>();
  routines.forEach((routine, index) => {
    const matches = byName.get(routine.normalizedName) ?? [];
    matches.push({ routine, index });
    byName.set(routine.normalizedName, matches);
  });
  return byName;
}

function conditionalHandlerBlockReason(context: string | undefined): string {
  return context === undefined
    ? 'Условный контекст обработчика формы не подтверждён; требуется ручное добавление.'
    : 'Обработчик формы расположен внутри условных директив; автоматическое добавление небезопасно.';
}

function blockedFormEventRoutineNode(input: {
  readonly nodeId: string;
  readonly moduleId: string;
  readonly routine: BslRoutineInfo;
  readonly targetPath: string;
  readonly reason: string;
}): CompareTreeNode {
  return {
    id: input.nodeId,
    label: `Процедура: ${input.routine.name}`,
    kind: 'bslRoutine',
    status: 'rightOnly',
    leftValue: '',
    rightValue: input.routine.name,
    mergeable: false,
    payloadRef: `extensionBslRoutine:${input.moduleId}:${input.routine.normalizedName}`,
    conflict: { kind: 'bslLogicalConflict', blocking: true, message: input.reason },
    mergeState: { state: 'blocked', reason: input.reason, targetFilePath: input.targetPath },
    presentation: { qualifiedName: input.moduleId },
    children: [],
  };
}

export function makeExtensionLinkedBslContext(
  input: {
    readonly targetRootPath: string;
    readonly sourceRootPath: string;
    readonly targetSourceId: string;
    readonly sourceId: string;
    readonly rightSnapshotId: string;
    readonly session: import('../domain/compareSession').CompareSession;
  },
  modules: readonly LinkedFormModuleSnapshot[],
): import('../linkedDesignerTypes').LinkedDesignerMaterializerContext {
  const targetPathMap = mapLinkedModulesByTargetPath(input.targetRootPath, modules);
  return {
    ...input,
    candidateFactories: new Map(),
    packagesByNodeId: new Map(),
    formModules: modules,
    modulesByTargetPath: targetPathMap,
  };
}

function routineCandidateFactory(input: {
  readonly nodeId: string;
  readonly row: ExtensionTransferRow;
  readonly rightSnapshotId: string;
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly targetText?: string;
  readonly targetMissing: boolean;
  readonly targetSourceId: string;
  readonly sourceId: string;
  readonly sourceText: string;
  readonly sourceHash: string;
  readonly routine: BslRoutineInfo;
  readonly sourceTextRange: import('../../bsl/bslRoutineTypes').BslTextRange;
}): ExecutableCandidateFactory {
  return async () => {
    const targetUri = pathToFileURL(path.join(input.row.targetRoot.canonicalRootPath ?? input.row.targetRoot.rootPath, input.targetPath)).toString();
    if (input.targetMissing) {
      const current = await captureMergePath(path.join(input.row.targetRoot.canonicalRootPath ?? input.row.targetRoot.rootPath, input.targetPath), { retainContent: false }).catch(() => undefined);
      if (current?.state !== 'missing') {
        return { ok: false, diagnostics: [blocked(`Целевой BSL module появился после compare: ${input.targetPath}`, input.targetSourceId, input.nodeId)] };
      }
    }
    if (!input.targetMissing && input.targetText === undefined) {
      return { ok: false, diagnostics: [blocked('Captured целевой BSL module отсутствует в compare snapshot.', input.targetSourceId, input.nodeId)] };
    }
    const expectedOldHash = input.targetMissing ? MISSING_TARGET_HASH : hashText(input.targetText!);
    const next = input.targetMissing ? input.sourceText : insertRoutine(input.targetText!, input.sourceText);
    if (!next) {return { ok: false, diagnostics: [blocked('Не удалось собрать preview процедуры формы.', input.targetSourceId, input.nodeId)] };}
    const newHash = hashText(next);
    return {
      ok: true,
      candidate: {
        kind: 'bslRoutineInsert',
        sourceId: input.row.incomingRoot.sourceId,
        snapshotId: input.rightSnapshotId,
        nodeId: input.nodeId,
        targetUri,
        expectedOldHash,
        newHash,
        sourceWitnesses: [{ sourceId: input.sourceId, relativePath: input.sourcePath, expectedHash: input.sourceHash, kind: 'file' }],
        bslRoutine: {
          kind: 'insertRoutine',
          targetPath: targetUri,
          expectedOldHash,
          newHash,
          routine: {
            name: input.routine.name,
            normalizedName: input.routine.normalizedName,
            kind: input.routine.kind,
            exported: input.routine.exported,
          },
          sourceText: input.sourceText,
          sourceRange: input.routine.range,
          sourceTextRange: input.sourceTextRange,
        },
      },
    };
  };
}

function eventHandlers(xml: Buffer): string[] {
  try {
    const root = parseXmlDocument(xml.toString('utf8')).root;
    if (root.localName !== 'Form' || namespaceUriForName(root) !== LOGFORM_NAMESPACE) {return [];}
    const events: string[] = [];
    const visit = (element: import('../xml/xmlDom').XmlElement): void => {
      if (element !== root && element.localName === 'BaseForm') {return;}
      if (namespaceUriForName(element) !== LOGFORM_NAMESPACE) {return;}
      if (element.localName === 'Event' && element.parent?.localName === 'Events'
        && namespaceUriForName(element.parent) === LOGFORM_NAMESPACE) {
        const handler = textContent(element).trim();
        if (handler) {events.push(handler);}
        return;
      }
      for (const child of elementChildren(element)) {visit(child);}
    };
    visit(root);
    return events;
  } catch {
    return [];
  }
}

function flattenNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function isEventPointer(value: string): boolean {
  return /(?:^|%2F|\/)Event(?:%5B|\[)/iu.test(value);
}

function eventHandlerName(value: string): string | undefined {
  if (!value) {return undefined;}
  if (!value.startsWith('<')) {return value.trim() || undefined;}
  try {
    const root = parseXmlDocument(value).root;
    return root.localName === 'Event' ? textContent(root).trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function insertRoutine(target: string, routine: string): string | undefined {
  const eol = /\r\n|\r|\n/u.exec(target)?.[0] ?? /\r\n|\r|\n/u.exec(routine)?.[0] ?? '\n';
  const body = routine.replace(/\r\n|\r|\n/gu, eol).replace(/[\r\n]+$/u, '');
  const existing = target.replace(/[\r\n]+$/u, '');
  if (!body) {return undefined;}
  return existing ? `${existing}${eol}${body}` : body;
}

async function captureFile(root: ExtensionMetadataIndex, _owner: ExtensionIndexedObject, file: ExtensionIndexedObject['sidecarFiles'][number]): Promise<Buffer | undefined> {
  if (file.content) {return Buffer.from(file.content);}
  const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, file.relativePath), { retainContent: true }).catch(() => undefined);
  if (snapshot?.state !== 'file' || snapshot.hash !== file.hash || snapshot.contentBase64 === undefined) {return undefined;}
  return Buffer.from(snapshot.contentBase64, 'base64');
}

function projectionFailure(
  input: { readonly row: ExtensionTransferRow; readonly incomingRoot: ExtensionMetadataIndex; readonly targetRoot: ExtensionMetadataIndex; readonly targetFormPath: string },
  message: string,
): ExtensionFormEventProjection {
  return {
    context: [],
    routineSelections: new Map(),
    routineNodes: [],
    diagnostics: [{ severity: 'error', code: 'EXTENSION_SEMANTIC_XML_UNAVAILABLE', phase: 'compare', sourceId: input.incomingRoot.sourceId, nodeId: input.row.id, path: input.targetFormPath, blocking: true, suggestedAction: message }],
  };
}

function samePath(left: string, right: string): boolean {
  const a = left.replace(/\\/gu, '/').normalize('NFC');
  const b = right.replace(/\\/gu, '/').normalize('NFC');
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

function blocked(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return { severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare', sourceId, nodeId, blocking: true, suggestedAction: message };
}
