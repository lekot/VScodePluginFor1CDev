import * as path from 'path';
import { pathToFileURL } from 'url';

import { parseBslRoutines } from '../../bsl/routineRangeProvider';
import type { BslRoutineInfo } from '../../bsl/bslRoutineTypes';
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
export async function projectExtensionFormEventHandlers(input: {
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
}): Promise<ExtensionFormEventProjection> {
  const targetModulePath = path.posix.join(path.posix.dirname(input.targetFormPath), 'Form', 'Module.bsl');
  const sourceModulePath = path.posix.join(path.posix.dirname(input.sourceFormPath), 'Form', 'Module.bsl');
  const targetFile = input.targetOwner.sidecarFiles.filter((file) => samePath(file.relativePath, targetModulePath));
  const sourceFile = input.incomingOwner.sidecarFiles.filter((file) => samePath(file.relativePath, sourceModulePath));
  const diagnostics: CompareMessage[] = [];
  if (targetFile.length > 1 || sourceFile.length > 1) {
    return projectionFailure(input, 'Module формы имеет неоднозначный sidecar path.');
  }
  const [targetContent, sourceContent] = await Promise.all([
    targetFile[0] ? captureFile(input.targetRoot, input.targetOwner, targetFile[0]!) : Promise.resolve(undefined),
    sourceFile[0] ? captureFile(input.incomingRoot, input.incomingOwner, sourceFile[0]!) : Promise.resolve(undefined),
  ]);
  if ((targetFile[0] && !targetContent) || (sourceFile[0] && !sourceContent)) {
    return projectionFailure(input, 'Не удалось подтвердить captured BSL module формы.');
  }

  const targetText = targetContent?.toString('utf8');
  const sourceText = sourceContent?.toString('utf8');
  const targetIndex = targetText === undefined ? undefined : parseBslRoutines(targetText);
  const sourceIndex = sourceText === undefined ? undefined : parseBslRoutines(sourceText);
  const targetHasParseErrors = targetIndex?.diagnostics.some((item) => item.severity === 'error') ?? false;
  const sourceHasParseErrors = sourceIndex?.diagnostics.some((item) => item.severity === 'error') ?? false;
  const handlerNames = eventHandlers(input.sourceFormXml);
  const targetPath = targetFile[0]?.relativePath ?? targetModulePath;
  const sourcePath = sourceFile[0]?.relativePath;
  const formName = path.posix.basename(path.posix.dirname(path.posix.dirname(input.targetFormPath)));
  const formType = input.row.incoming?.metadataType ?? input.row.target?.metadataType;
  const formQualifiedName = formType === 'CommonForm'
    ? input.row.qualifiedName
    : `${input.row.qualifiedName}.Form.${formName}`;
  const moduleId = canonicalFormModuleId(formQualifiedName);
  const routineSelections = new Map<string, ExtensionLinkedRoutineSelection>();
  const routineCandidateIds = new Map<string, string>();
  const routineNodes: CompareTreeNode[] = [];
  const capabilities: Array<NonNullable<AdapterCompareInput['linkedDesignerContext']>['formEventHandlers'][number]> = [];

  for (const name of handlerNames) {
    const normalized = name.toLocaleLowerCase('en-US');
    const targetMatches = targetIndex?.routines.filter((routine) => routine.normalizedName === normalized) ?? [];
    const sourceMatches = sourceIndex?.routines.filter((routine) => routine.normalizedName === normalized) ?? [];
    const targetHasHandler = Boolean(targetIndex && !targetHasParseErrors && targetMatches.length === 1);
    let incomingRoutineNodeId: string | undefined;
    if (!targetHasHandler && sourceIndex && !sourceHasParseErrors && sourceMatches.length === 1 && targetPath && sourcePath && sourceFile[0]) {
      const routine = sourceMatches[0]!;
      const sourceSpan = captureBslRoutineSpan(sourceText!, routine);
      if (sourceSpan) {
        const sourceTextForRoutine = sourceSpan.sourceText;
        incomingRoutineNodeId = `extension:bsl-routine:${input.row.id}:${encodeURIComponent(moduleId)}:${encodeURIComponent(normalized)}`;
        const factory = routineCandidateFactory({
          nodeId: incomingRoutineNodeId,
          row: input.row,
          rightSnapshotId: input.rightSnapshotId,
          targetPath,
          sourcePath,
          targetText,
          targetMissing: !targetFile[0],
          targetSourceId: input.targetRoot.sourceId,
          sourceId: input.incomingRoot.sourceId,
          sourceText: sourceTextForRoutine,
          sourceHash: sourceFile[0].hash,
          routine,
          sourceTextRange: sourceSpan.sourceTextRange,
        });
        routineCandidateIds.set(normalized, incomingRoutineNodeId);
        routineSelections.set(incomingRoutineNodeId, { nodeId: incomingRoutineNodeId, rowId: input.row.id, moduleId, candidateFactory: factory });
        routineNodes.push({
          id: incomingRoutineNodeId,
          label: `Процедура: ${routine.name}`,
          kind: 'bslRoutine',
          status: 'rightOnly',
          leftValue: '',
          rightValue: sourceTextForRoutine,
          mergeable: true,
          mergeState: { state: 'ready', targetFilePath: targetPath },
          children: [],
        });
      }
    }
    capabilities.push({
      name,
      targetHasHandler,
      ...(incomingRoutineNodeId ? { incomingRoutineNodeId } : {}),
      ...(targetFile[0] ? { targetWitnesses: [{
        sourceId: input.targetRoot.sourceId,
        relativePath: targetFile[0].relativePath,
        expectedHash: targetFile[0].hash,
        kind: 'file' as const,
      }] } : {}),
    });
  }

  const module = targetPath && sourcePath && sourceFile[0]
    ? {
      moduleId,
      targetRelativePath: targetPath,
      sourceRelativePath: sourcePath,
      targetHash: targetFile[0]?.hash ?? MISSING_TARGET_HASH,
      sourceHash: sourceFile[0].hash,
      targetContent: targetText,
      sourceContent: sourceText,
      ...(!targetFile[0] ? { targetMissing: true as const } : {}),
      routineCandidateIds,
    }
    : undefined;
  return { context: capabilities, module, routineSelections, routineNodes, diagnostics };
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
