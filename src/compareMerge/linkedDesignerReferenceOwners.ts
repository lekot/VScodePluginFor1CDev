import * as fs from 'fs/promises';
import * as path from 'path';
import { assertNoSymlinkSegments, validateWorkspaceRelativePath } from '../services/configurationSession/pathBoundary';

import { METADATA_TYPE_DESCRIPTORS } from '../constants/metadataTypeDescriptors';
import { rulesRegistry } from '../rules';
import { captureMergePath } from './merge/mergeSnapshot';
import { MISSING_TARGET_HASH, type MergeFileWitness } from './merge/mergePreview';
import { blocked, LINKED_FORM_REFERENCE_PROPERTIES, normalizeAbsolutePath, stripHash } from './linkedDesignerUtils';
import { parseLinkedFormReferenceOwnerState } from './linkedDesignerValidation';
import type {
  LinkedDesignerMaterializerContext,
  LinkedDesignerPackageRecipe,
  LinkedFormReferenceOwnerReference,
  LinkedFormReferenceOwnerState,
  LinkedOwnerDescriptorSnapshot,
} from './linkedDesignerTypes';

export interface SelectedFormReferenceOwnerCapture {
  readonly states: readonly LinkedFormReferenceOwnerState[];
  readonly witnesses: readonly MergeFileWitness[];
  readonly diagnostics: readonly import('./domain/compareContracts').CompareMessage[];
}

/** Captures only owners touched by the selection, or all owners for a Form deletion. */
export async function captureSelectedFormReferenceOwnerStates(
  input: LinkedDesignerMaterializerContext,
  selectedPackages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  selectedXmlPaths: ReadonlySet<string>,
): Promise<SelectedFormReferenceOwnerCapture> {
  const references = input.formReferenceOwnerReferences;
  const deleteNodeId = selectedFormDeleteNodeId(selectedPackages);
  const verifyAll = deleteNodeId !== undefined;
  if (references === undefined) {return captureLegacyOwnerWitnesses(input, verifyAll, deleteNodeId);}
  if (!verifyAll && references.length === 0) {return emptyOwnerCapture();}
  if (verifyAll && (input.formReferenceOwnerReferenceIssues?.length ?? 0) > 0) {
    return failedCapture(input, ownerCaptureIssue(input.formReferenceOwnerReferenceIssues![0]), deleteNodeId);
  }
  const canonicalRoot = await resolveOwnerRoot(input, deleteNodeId);
  if (typeof canonicalRoot !== 'string') {return canonicalRoot;}
  const selectedReferences = selectOwnerReferences(references, selectedPackages, selectedXmlPaths, canonicalRoot, verifyAll);
  if (!verifyAll && selectedReferences.length === 0) {return emptyOwnerCapture();}
  if (verifyAll) {
    const pathSetFailure = await verifyFrozenOwnerPathSet(canonicalRoot, references);
    if (pathSetFailure) {return failedCapture(input, pathSetFailure, deleteNodeId);}
  }
  const captured = await captureOwnerBatch(input, selectedPackages, canonicalRoot, selectedReferences);
  if (captured.diagnostics.length > 0) {return captured;}
  return addRootConfigurationWitness(input, captured, verifyAll, deleteNodeId);
}

function selectedFormDeleteNodeId(packages: ReadonlyMap<string, LinkedDesignerPackageRecipe>): string | undefined {
  const recipe = [...packages.values()].find((item) => item.kind === 'Form' && item.action === 'delete');
  return recipe?.registrationNodeId ?? recipe?.packageId;
}

function emptyOwnerCapture(): SelectedFormReferenceOwnerCapture {
  return { states: [], witnesses: [], diagnostics: [] };
}

function ownerCaptureIssue(pathValue: string): string {
  return `Нельзя проверить ссылки владельцев на удаляемые формы: не удалось зафиксировать descriptor (${pathValue}).`;
}

async function resolveOwnerRoot(
  input: LinkedDesignerMaterializerContext,
  nodeId?: string,
): Promise<string | SelectedFormReferenceOwnerCapture> {
  try {return await fs.realpath(input.targetRootPath);}
  catch {return failedCapture(input, 'Не удалось проверить корень целевой конфигурации для ссылок на формы.', nodeId);}
}

function selectOwnerReferences(
  references: readonly LinkedFormReferenceOwnerReference[],
  packages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  selectedXmlPaths: ReadonlySet<string>,
  canonicalRoot: string,
  verifyAll: boolean,
): LinkedFormReferenceOwnerReference[] {
  const selectedOwnerPaths = new Set([...packages.values()]
    .map((recipe) => recipe.ownerTargetRelativePath)
    .filter((relativePath): relativePath is string => Boolean(relativePath))
    .map((relativePath) => ownerPathKey(canonicalRoot, relativePath)));
  return references.filter((reference) => verifyAll
    || selectedXmlPaths.has(ownerPathKey(canonicalRoot, reference.targetRelativePath))
    || selectedOwnerPaths.has(ownerPathKey(canonicalRoot, reference.targetRelativePath)));
}

async function captureOwnerBatch(
  input: LinkedDesignerMaterializerContext,
  packages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  canonicalRoot: string,
  references: readonly LinkedFormReferenceOwnerReference[],
): Promise<SelectedFormReferenceOwnerCapture> {
  const preCapturedOwners = indexPreCapturedOwners(packages, canonicalRoot);
  const states: LinkedFormReferenceOwnerState[] = [];
  const witnesses: MergeFileWitness[] = [];
  for (const reference of references) {
    const pathKey = ownerPathKey(canonicalRoot, reference.targetRelativePath);
    const captured = await captureOwnerState(input, canonicalRoot, reference, preCapturedOwners.get(pathKey));
    if ('diagnostic' in captured) {return { states: [], witnesses: [], diagnostics: [captured.diagnostic] };}
    states.push(captured.state);
    witnesses.push(captured.witness);
  }
  return { states, witnesses, diagnostics: [] };
}

function addRootConfigurationWitness(
  input: LinkedDesignerMaterializerContext,
  captured: SelectedFormReferenceOwnerCapture,
  verifyAll: boolean,
  nodeId?: string,
): SelectedFormReferenceOwnerCapture {
  if (!verifyAll) {return captured;}
  const witness = targetConfigurationWitness(input);
  if (!witness) {return failedCapture(input, 'Целевое состояние Configuration.xml нельзя защитить при удалении формы.', nodeId);}
  return { ...captured, witnesses: [...captured.witnesses, witness] };
}

async function verifyFrozenOwnerPathSet(
  rootPath: string,
  references: readonly LinkedFormReferenceOwnerReference[],
): Promise<string | undefined> {
  const expected = new Set(references.map((reference) => ownerPathKey(rootPath, reference.targetRelativePath)));
  const actual = new Set<string>();
  try {
    for (const folder of formReferenceOwnerFolders()) {
      for (const filePath of await enumerateRootDescriptors(rootPath, folder)) {actual.add(normalizeAbsolutePath(filePath));}
    }
  } catch {
    return 'Не удалось пере-энумерировать набор metadata owner descriptors перед удалением формы.';
  }
  if (!sameStringSet(expected, actual)) {
    return 'Набор metadata owner descriptors изменился после сравнения; повторите сравнение.';
  }
  return undefined;
}

function formReferenceOwnerFolders(): string[] {
  const folders = new Set<string>();
  for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
    const rules = rulesRegistry.get(descriptor.type);
    const supportsReferences = rules && Object.values(rules.properties).some((property) =>
      property.xml && LINKED_FORM_REFERENCE_PROPERTIES.includes(property.xml as typeof LINKED_FORM_REFERENCE_PROPERTIES[number])
    );
    if (supportsReferences) {folders.add(descriptor.designerFolder);}
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

async function enumerateRootDescriptors(rootPath: string, folder: string): Promise<string[]> {
  const folderPath = path.join(rootPath, folder);
  let folderStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {folderStat = await fs.lstat(folderPath);}
  catch (error) {
    if (isMissing(error)) {return [];}
    throw error;
  }
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) {throw new Error('Owner metadata folder is not a regular directory.');}
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {throw new Error('Owner metadata path contains a symbolic link.');}
    if (path.extname(entry.name).toLowerCase() !== '.xml') {continue;}
    if (entry.isFile()) {result.push(path.join(folderPath, entry.name));}
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {result.push(...await enumerateHierarchicalOwnerDescriptor(folderPath, entry.name));}
  }
  return result;
}

async function enumerateHierarchicalOwnerDescriptor(folderPath: string, objectFolderName: string): Promise<string[]> {
  const objectFolderPath = path.join(folderPath, objectFolderName);
  const entries = await fs.readdir(objectFolderPath, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {throw new Error('Owner metadata path contains a symbolic link.');}
    if (path.extname(entry.name).toLowerCase() !== '.xml') {continue;}
    if (entry.isFile()) {result.push(path.join(objectFolderPath, entry.name));}
  }
  return result;
}

async function captureOwnerState(
  input: LinkedDesignerMaterializerContext,
  canonicalRoot: string,
  reference: LinkedFormReferenceOwnerReference,
  preCaptured: LinkedOwnerDescriptorSnapshot | undefined,
): Promise<{ readonly state: LinkedFormReferenceOwnerState; readonly witness: MergeFileWitness } | { readonly diagnostic: import('./domain/compareContracts').CompareMessage }> {
  const targetHash = stripHash(reference.targetHash);
  if (!/^[a-f0-9]{64}$/iu.test(targetHash)) {
    return { diagnostic: blocked(`Начальный hash descriptor владельца некорректен: ${reference.targetRelativePath}`, input.targetSourceId) };
  }
  let targetPath: string;
  try {
    const relativePath = validateWorkspaceRelativePath(reference.targetRelativePath);
    targetPath = path.resolve(canonicalRoot, ...relativePath.split('/'));
    await assertNoSymlinkSegments(canonicalRoot, targetPath);
  } catch {
    return { diagnostic: blocked(`Путь descriptor владельца не прошёл проверку границ: ${reference.targetRelativePath}`, input.targetSourceId) };
  }
  const snapshot = preCaptured
    ? { state: 'file' as const, hash: stripHash(preCaptured.targetHash), contentBase64: Buffer.from(preCaptured.targetContent, 'utf8').toString('base64') }
    : await captureMergePath(targetPath, { retainContent: true }).catch(() => undefined);
  if (!snapshot || snapshot.state !== 'file' || snapshot.contentBase64 === undefined || stripHash(snapshot.hash) !== targetHash) {
    return { diagnostic: blocked(`Дескриптор владельца изменился после сравнения: ${reference.targetRelativePath}`, input.targetSourceId) };
  }
  const content = Buffer.from(snapshot.contentBase64, 'base64').toString('utf8');
  const state = parseLinkedFormReferenceOwnerState(reference, content);
  if (!state) {
    return { diagnostic: blocked(`Дескриптор владельца ${reference.qualifiedName} нельзя разобрать для проверки ссылок на формы.`, input.targetSourceId) };
  }
  return {
    state,
    witness: {
      sourceId: input.targetSourceId,
      relativePath: reference.targetRelativePath,
      expectedHash: targetHash,
      kind: 'file',
    },
  };
}

function indexPreCapturedOwners(
  packages: ReadonlyMap<string, LinkedDesignerPackageRecipe>,
  rootPath: string,
): Map<string, LinkedOwnerDescriptorSnapshot> {
  const result = new Map<string, LinkedOwnerDescriptorSnapshot>();
  for (const recipe of packages.values()) {
    const snapshot = recipe.ownerDescriptorSnapshot;
    if (snapshot) {result.set(ownerPathKey(rootPath, snapshot.targetRelativePath), snapshot);}
  }
  return result;
}

function targetConfigurationWitness(input: LinkedDesignerMaterializerContext): MergeFileWitness | undefined {
  const state = input.rootConfigurationStates?.target;
  const hash = state === 'missing' ? MISSING_TARGET_HASH : input.rootConfiguration?.targetHash;
  if ((state !== 'file' && state !== 'missing') || !hash) {return undefined;}
  return { sourceId: input.targetSourceId, relativePath: 'Configuration.xml', expectedHash: hash, kind: 'file' };
}

function captureLegacyOwnerWitnesses(
  input: LinkedDesignerMaterializerContext,
  verifyAll: boolean,
  nodeId?: string,
): SelectedFormReferenceOwnerCapture {
  if (!verifyAll) {return { states: [], witnesses: [], diagnostics: [] };}
  if ((input.formReferenceOwnerSnapshotIssues?.length ?? 0) > 0) {
    return failedCapture(input, `Нельзя проверить ссылки владельцев на удаляемые формы: не удалось захватить descriptor (${input.formReferenceOwnerSnapshotIssues![0]}).`, nodeId);
  }
  const configurationWitness = targetConfigurationWitness(input);
  if (!configurationWitness) {
    return failedCapture(input, 'Целевое состояние Configuration.xml нельзя защитить при удалении формы.', nodeId);
  }
  const witnesses: MergeFileWitness[] = (input.formReferenceOwnerSnapshots ?? []).map((snapshot) => ({
    sourceId: input.targetSourceId,
    relativePath: snapshot.targetRelativePath,
    expectedHash: stripHash(snapshot.targetHash),
    kind: 'file' as const,
  }));
  witnesses.push(configurationWitness);
  return { states: [], witnesses, diagnostics: [] };
}

function failedCapture(
  input: LinkedDesignerMaterializerContext,
  message: string,
  nodeId?: string,
): SelectedFormReferenceOwnerCapture {
  return { states: [], witnesses: [], diagnostics: [blocked(message, input.targetSourceId, nodeId)] };
}

function ownerPathKey(rootPath: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/gu, '/');
  return normalizeAbsolutePath(path.resolve(rootPath, ...normalized.split('/')));
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}
