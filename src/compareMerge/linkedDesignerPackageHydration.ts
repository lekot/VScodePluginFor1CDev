import * as fs from 'fs/promises';
import * as path from 'path';

import { assertNoSymlinkSegments, assertPathWithinRoot, validateWorkspaceRelativePath } from '../services/configurationSession/pathBoundary';
import { captureMergePath, mergeSnapshotHash } from './merge/mergeSnapshot';
import { MISSING_TARGET_HASH, type MergeFileWitness } from './merge/mergePreview';
import { blocked, hashBuffer, normalizePath, stripHash } from './linkedDesignerUtils';
import { metadataDescriptorPathKey, metadataManifestRelativePathKey } from './metadataObjectLookup';
import type { ConfigurationFileManifest, ConfigurationFileManifestObject } from './inventory/configurationFileManifest';
import type {
  LinkedDesignerMaterializerContext,
  LinkedDesignerPackageMember,
  LinkedDesignerPackageRecipe,
  LinkedDesignerPackageReference,
  LinkedOwnerDescriptorSnapshot,
} from './linkedDesignerTypes';

interface CapturedPackageTree {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

interface SelectedPackageResolution {
  readonly recipesByNodeId: ReadonlyMap<string, LinkedDesignerPackageRecipe>;
  readonly diagnostics: readonly import('./domain/compareContracts').CompareMessage[];
}

interface SelectedPackageSource {
  readonly manifest: ConfigurationFileManifest;
  readonly rootPath: string;
  readonly object: ConfigurationFileManifestObject;
}

type FileMergeSnapshot = Extract<Awaited<ReturnType<typeof captureMergePath>>, { state: 'file' }>;

interface DeleteDirectoryCapture {
  readonly snapshot?: Awaited<ReturnType<typeof captureMergePath>>;
  readonly witness?: MergeFileWitness;
}

/** Reads package bytes only after selection, checking the compare-time path manifest first. */
export async function resolveSelectedLinkedDesignerPackages(input: {
  readonly context: LinkedDesignerMaterializerContext;
  readonly references: readonly LinkedDesignerPackageReference[];
}): Promise<SelectedPackageResolution> {
  const recipesByNodeId = new Map<string, LinkedDesignerPackageRecipe>();
  const diagnostics: import('./domain/compareContracts').CompareMessage[] = [];
  const referencesByPackageId = new Map<string, LinkedDesignerPackageReference>();
  for (const reference of input.references) {
    const previous = referencesByPackageId.get(reference.packageId);
    if (previous && previous.action !== reference.action) {
      diagnostics.push(blocked('Один Designer-пакет одновременно выбран для добавления и удаления.', input.context.sourceId, reference.registrationNodeId));
      continue;
    }
    referencesByPackageId.set(reference.packageId, reference);
  }
  if (diagnostics.length > 0) {return { recipesByNodeId, diagnostics };}

  const rootConfigurationDiagnostic = await verifyFrozenRootConfiguration(input.context);
  if (rootConfigurationDiagnostic) {return { recipesByNodeId, diagnostics: [rootConfigurationDiagnostic] };}

  for (const reference of referencesByPackageId.values()) {
    try {
      const recipe = await resolveSelectedPackage(input.context, reference);
      const nodeId = reference.registrationNodeId ?? packageNodeId(reference);
      recipe.registrationNodeId = nodeId;
      recipesByNodeId.set(nodeId, recipe);
    } catch (error) {
      diagnostics.push(blocked(
        error instanceof Error ? error.message : String(error),
        reference.action === 'copy' ? input.context.sourceId : input.context.targetSourceId,
        reference.registrationNodeId ?? packageNodeId(reference),
      ));
    }
  }
  return diagnostics.length > 0 ? { recipesByNodeId: new Map(), diagnostics } : { recipesByNodeId, diagnostics };
}

async function resolveSelectedPackage(
  context: LinkedDesignerMaterializerContext,
  reference: LinkedDesignerPackageReference,
): Promise<LinkedDesignerPackageRecipe> {
  const source = await validateSelectedPackageSource(context, reference);
  const deleteDirectory = await captureDeleteDirectory(context, reference);
  const members: LinkedDesignerPackageMember[] = [];
  for (const memberReference of reference.memberReferences) {
    members.push(await resolveSelectedPackageMember({
      context,
      reference,
      source,
      memberReference,
      deleteDirectorySnapshot: deleteDirectory.snapshot,
    }));
  }
  const ownerDescriptorSnapshot = reference.ownerDescriptorReference
    ? await captureOwnerDescriptor(context, reference.ownerDescriptorReference.targetRelativePath, reference.ownerDescriptorReference.targetHash)
    : undefined;
  return {
    packageId: reference.packageId,
    action: reference.action,
    kind: reference.kind,
    qualifiedName: reference.qualifiedName,
    ...(reference.ownerQualifiedName ? { ownerQualifiedName: reference.ownerQualifiedName } : {}),
    ...(reference.ownerTargetRelativePath ? { ownerTargetRelativePath: reference.ownerTargetRelativePath } : {}),
    ...(reference.rootRegistration ? { rootRegistration: reference.rootRegistration } : {}),
    ...(deleteDirectory.witness ? { targetDirectoryWitness: deleteDirectory.witness } : {}),
    ...(ownerDescriptorSnapshot ? { ownerDescriptorSnapshot } : {}),
    members,
  };
}

async function validateSelectedPackageSource(
  context: LinkedDesignerMaterializerContext,
  reference: LinkedDesignerPackageReference
): Promise<SelectedPackageSource> {
  const manifests = context.packageManifests;
  if (!manifests) {throw new Error('Снимок путей linked Designer-пакета отсутствует; повторите сравнение.');}
  const manifest = reference.action === 'copy' ? manifests.source : manifests.target;
  const rootPath = reference.action === 'copy' ? context.sourceRootPath : context.targetRootPath;
  const object = manifest.objectsByDescriptorPath.get(metadataDescriptorPathKey(resolveRootPath(rootPath, reference.sourceDescriptorRelativePath)));
  if (!object || object.objectId !== reference.sourceObjectId) {
    throw new Error(`Дескриптор ${reference.qualifiedName} больше не соответствует compare-time manifest.`);
  }
  if (normalizeRoot(manifest.rootPath) !== normalizeRoot(rootPath)) {
    throw new Error(`Путь конфигурации ${reference.qualifiedName} изменился после сравнения.`);
  }

  const currentTree = await enumeratePackageTree(rootPath, reference.sourceContainerRelativePath);
  if (!packageTreeMatchesManifest(currentTree, manifest, reference)) {
    throwPackageTreeChanged(reference);
  }
  return { manifest, rootPath, object };
}

function packageTreeMatchesManifest(
  currentTree: CapturedPackageTree,
  manifest: ConfigurationFileManifest,
  reference: LinkedDesignerPackageReference
): boolean {
  return currentTree.files.length === reference.sourceContainerFileCount
    && currentTree.directories.length === reference.sourceContainerDirectoryCount
    && !currentTree.files.some((relativePath) => !manifest.entriesByRelativePath.has(metadataManifestRelativePathKey(relativePath)))
    && !currentTree.directories.some((relativePath) => !manifest.directoryPathsByRelativePath.has(metadataManifestRelativePathKey(relativePath)));
}

function throwPackageTreeChanged(reference: LinkedDesignerPackageReference): never {
  throw new Error(reference.action === 'delete'
    ? 'Каталог удаляемого Designer-пакета изменился после сравнения.'
    : 'Состав файлов или каталогов Designer-пакета изменился после сравнения.');
}

async function captureDeleteDirectory(
  context: LinkedDesignerMaterializerContext,
  reference: LinkedDesignerPackageReference
): Promise<DeleteDirectoryCapture> {
  if (reference.action !== 'delete') {return {};}
  const safeContainer = await boundedPath(context.targetRootPath, reference.sourceContainerRelativePath);
  const snapshot = await captureMergePath(safeContainer, { retainContent: false });
  if (snapshot.state !== 'directory') {
    throw new Error(`Каталог sidecar-пакета ${reference.qualifiedName} отсутствует или не подтверждён.`);
  }
  return {
    snapshot,
    witness: {
      sourceId: context.targetSourceId,
      relativePath: reference.sourceContainerRelativePath,
      expectedHash: mergeSnapshotHash(snapshot),
      kind: 'directory',
    },
  };
}

async function resolveSelectedPackageMember(input: {
  readonly context: LinkedDesignerMaterializerContext;
  readonly reference: LinkedDesignerPackageReference;
  readonly source: SelectedPackageSource;
  readonly memberReference: LinkedDesignerPackageReference['memberReferences'][number];
  readonly deleteDirectorySnapshot?: Awaited<ReturnType<typeof captureMergePath>>;
}): Promise<LinkedDesignerPackageMember> {
  const sourcePath = await boundedPath(input.source.rootPath, input.memberReference.relativePath);
  const targetPath = await boundedPath(input.context.targetRootPath, input.memberReference.relativePath);
  const sourceSnapshot = await captureSelectedPackageMemberSource(input, sourcePath);
  const sourceHash = validateSelectedPackageMemberSource(input.reference, input.memberReference, sourceSnapshot);
  const targetHash = await resolveSelectedPackageMemberTargetHash(input, targetPath, sourceSnapshot);
  validateSelectedPackageMemberTarget(input.reference, input.memberReference, targetHash);
  const content = createSelectedPackageMemberContent(input.reference, input.memberReference, sourceSnapshot, sourceHash);
  return {
    targetRelativePath: input.memberReference.relativePath,
    ...(input.reference.action === 'copy' ? { sourceRelativePath: input.memberReference.relativePath, sourceHash, content } : {}),
    expectedTargetHash: targetHash,
    required: input.memberReference.required,
  };
}

async function captureSelectedPackageMemberSource(
  input: Parameters<typeof resolveSelectedPackageMember>[0],
  sourcePath: string
): Promise<FileMergeSnapshot> {
  const { context, reference, memberReference, deleteDirectorySnapshot } = input;
  let sourceSnapshot = reference.action === 'copy'
    ? await captureMergePath(sourcePath, { retainContent: true })
    : deleteDirectorySnapshot
      ? snapshotForPackageMember(deleteDirectorySnapshot, context.targetRootPath, reference.sourceContainerRelativePath, memberReference.relativePath)
      : undefined;
  if (reference.action === 'delete' && !sourceSnapshot) {
    sourceSnapshot = await captureMergePath(sourcePath, { retainContent: false });
  }
  if (!sourceSnapshot || sourceSnapshot.state !== 'file') {
    throw new Error(`Файл Designer-пакета отсутствует или имеет неподдерживаемый тип: ${memberReference.relativePath}`);
  }
  return sourceSnapshot;
}

function validateSelectedPackageMemberSource(
  reference: LinkedDesignerPackageReference,
  memberReference: LinkedDesignerPackageReference['memberReferences'][number],
  sourceSnapshot: FileMergeSnapshot
): string {
  const sourceHash = stripHash(sourceSnapshot.hash);
  if (memberReference.sourceHashAtCompare && sourceHash !== stripHash(memberReference.sourceHashAtCompare)) {
    throw new Error(`Файл Designer-пакета изменился после сравнения: ${memberReference.relativePath}`);
  }
  if (memberReference.required && normalizePath(memberReference.relativePath) === normalizePath(reference.sourceDescriptorRelativePath)
    && sourceHash !== stripHash(reference.sourceDescriptorHash)) {
    throw new Error(`Дескриптор Designer-пакета изменился после сравнения: ${memberReference.relativePath}`);
  }
  return sourceHash;
}

async function resolveSelectedPackageMemberTargetHash(
  input: Parameters<typeof resolveSelectedPackageMember>[0],
  targetPath: string,
  sourceSnapshot: FileMergeSnapshot
): Promise<string> {
  const targetSnapshot = input.reference.action === 'delete'
    ? sourceSnapshot
    : await captureMergePath(targetPath, { retainContent: false });
  const targetHash = targetSnapshot.state === 'missing'
    ? MISSING_TARGET_HASH
    : targetSnapshot.state === 'file'
      ? stripHash(targetSnapshot.hash)
      : undefined;
  if (!targetHash) {
    throw new Error(`Целевой путь Designer-пакета имеет неподдерживаемый тип: ${input.memberReference.relativePath}`);
  }
  return targetHash;
}

function validateSelectedPackageMemberTarget(
  reference: LinkedDesignerPackageReference,
  memberReference: LinkedDesignerPackageReference['memberReferences'][number],
  targetHash: string
): void {
  if (reference.action !== 'copy') {return;}
  if (!memberReference.targetPresentAtCompare && targetHash !== MISSING_TARGET_HASH) {
    throw new Error(`В target появился файл Designer-пакета после сравнения: ${memberReference.relativePath}`);
  }
  if (memberReference.targetPresentAtCompare && targetHash === MISSING_TARGET_HASH) {
    throw new Error(`Целевой файл Designer-пакета исчез после сравнения: ${memberReference.relativePath}`);
  }
  if (memberReference.targetHashAtCompare && targetHash !== stripHash(memberReference.targetHashAtCompare)) {
    throw new Error(`Целевой файл Designer-пакета изменился после сравнения: ${memberReference.relativePath}`);
  }
}

function createSelectedPackageMemberContent(
  reference: LinkedDesignerPackageReference,
  memberReference: LinkedDesignerPackageReference['memberReferences'][number],
  sourceSnapshot: FileMergeSnapshot,
  sourceHash: string
): Buffer | undefined {
  const content = reference.action === 'copy' && sourceSnapshot.contentBase64 !== undefined
    ? Buffer.from(sourceSnapshot.contentBase64, 'base64')
    : undefined;
  if (reference.action === 'copy' && (!content || hashBuffer(content) !== sourceHash)) {
    throw new Error(`Не удалось сохранить проверяемые байты Designer-файла: ${memberReference.relativePath}`);
  }
  return content;
}

async function captureOwnerDescriptor(
  context: LinkedDesignerMaterializerContext,
  relativePath: string,
  expectedHash: string,
): Promise<LinkedOwnerDescriptorSnapshot> {
  const absolute = await boundedPath(context.targetRootPath, relativePath);
  const snapshot = await captureMergePath(absolute, { retainContent: true });
  if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined || stripHash(snapshot.hash) !== stripHash(expectedHash)) {
    throw new Error(`Дескриптор владельца linked Designer-пакета изменился после сравнения: ${relativePath}`);
  }
  return {
    targetRelativePath: relativePath,
    targetHash: stripHash(snapshot.hash),
    targetContent: Buffer.from(snapshot.contentBase64, 'base64').toString('utf8'),
  };
}

async function verifyFrozenRootConfiguration(
  context: LinkedDesignerMaterializerContext,
): Promise<import('./domain/compareContracts').CompareMessage | undefined> {
  const states = context.rootConfigurationStates;
  if (!states) {return blocked('Снимок состояния Configuration.xml отсутствует; повторите сравнение.', context.sourceId);}
  for (const [side, rootPath, expectedState, expectedHash] of [
    ['target', context.targetRootPath, states.target, context.rootConfiguration?.targetHash],
    ['source', context.sourceRootPath, states.source, context.rootConfiguration?.sourceHash],
  ] as const) {
    try {
      const absolute = await boundedPath(rootPath, 'Configuration.xml');
      const snapshot = await captureMergePath(absolute, { retainContent: false });
      const actualState = snapshot.state === 'file' ? 'file' : snapshot.state === 'missing' ? 'missing' : 'unavailable';
      if (actualState !== expectedState || (expectedState === 'file' && (!expectedHash || snapshot.state !== 'file' || snapshot.hash !== expectedHash))) {
        return blocked(`${side === 'target' ? 'Целевой' : 'Исходный'} Configuration.xml изменился после сравнения.`, side === 'target' ? context.targetSourceId : context.sourceId);
      }
    } catch {
      return blocked(`${side === 'target' ? 'Целевой' : 'Исходный'} Configuration.xml нельзя проверить после сравнения.`, side === 'target' ? context.targetSourceId : context.sourceId);
    }
  }
  return undefined;
}

async function enumeratePackageTree(rootPath: string, containerRelativePath: string): Promise<CapturedPackageTree> {
  const containerPath = await boundedPath(rootPath, containerRelativePath);
  const files: string[] = [];
  const directories: string[] = [];
  const pending = [containerPath];
  while (pending.length > 0) {
    const directoryPath = pending.pop()!;
    const stat = await fs.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Sidecar-путь Designer-пакета не является обычным каталогом: ${directoryPath}`);
    }
    directories.push(rootRelativePath(rootPath, directoryPath));
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const bounded = await boundedPath(rootPath, rootRelativePath(rootPath, entryPath));
      const childStat = await fs.lstat(bounded);
      if (entry.isSymbolicLink() || childStat.isSymbolicLink()) {
        throw new Error(`Sidecar-путь Designer-пакета содержит символическую ссылку: ${entryPath}`);
      }
      if (childStat.isDirectory()) {pending.push(bounded);}
      else if (childStat.isFile()) {files.push(rootRelativePath(rootPath, bounded));}
      else {throw new Error(`Sidecar-путь Designer-пакета содержит специальный файл: ${entryPath}`);}
    }
  }
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    directories: directories.sort((left, right) => left.localeCompare(right)),
  };
}

function snapshotForPackageMember(
  snapshot: Awaited<ReturnType<typeof captureMergePath>>,
  rootPath: string,
  containerRelativePath: string,
  memberRelativePath: string,
): Awaited<ReturnType<typeof captureMergePath>> | undefined {
  if (snapshot.state !== 'directory') {return undefined;}
  const relativeWithinContainer = path.relative(
    path.resolve(rootPath, ...containerRelativePath.split('/')),
    path.resolve(rootPath, ...memberRelativePath.split('/')),
  ).split(path.sep).join('/');
  const entry = findSnapshotEntry(snapshot, relativeWithinContainer);
  return entry?.type === 'file'
    ? { ...entry, state: 'file' }
    : undefined;
}

function findSnapshotEntry(
  directory: Extract<Awaited<ReturnType<typeof captureMergePath>>, { state: 'directory' }>,
  relativePath: string,
): import('./merge/mergeSnapshot').MergeSnapshotFile | import('./merge/mergeSnapshot').MergeSnapshotDirectory | undefined {
  const segments = relativePath.split('/').filter(Boolean);
  let current: import('./merge/mergeSnapshot').MergeSnapshotDirectory = directory;
  for (let index = 0; index < segments.length; index += 1) {
    const entry = current.children.find((candidate) => path.basename(candidate.relativePath) === segments[index]);
    if (!entry) {return undefined;}
    if (index === segments.length - 1) {return entry;}
    if (entry.type !== 'directory') {return undefined;}
    current = entry;
  }
  return undefined;
}

async function boundedPath(rootPath: string, relativePath: string): Promise<string> {
  const normalized = validateWorkspaceRelativePath(relativePath);
  const absolute = path.resolve(rootPath, ...normalized.split('/'));
  const bounded = await assertPathWithinRoot(rootPath, absolute);
  await assertNoSymlinkSegments(bounded.canonicalRoot, bounded.canonicalTarget);
  await assertNoLexicalSymlinkParents(rootPath, absolute);
  return absolute;
}

async function assertNoLexicalSymlinkParents(rootPath: string, absoluteTargetPath: string): Promise<void> {
  const relativeParent = path.relative(path.resolve(rootPath), path.dirname(absoluteTargetPath));
  let cursor = path.resolve(rootPath);
  for (const segment of relativeParent === '' ? [] : relativeParent.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {break;}
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Sidecar-путь linked Designer-пакета содержит символическую ссылку или недиректорию: ${cursor}`);
    }
  }
}

function rootRelativePath(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join('/');
}

function resolveRootPath(rootPath: string, relativePath: string): string {
  return path.resolve(rootPath, ...validateWorkspaceRelativePath(relativePath).split('/'));
}

function normalizeRoot(rootPath: string): string {
  return path.resolve(rootPath).replace(/\\/gu, '/').toLocaleLowerCase('en-US');
}

function packageNodeId(reference: LinkedDesignerPackageReference): string {
  const status = reference.action === 'copy' ? 'rightOnly' : 'leftOnly';
  return `fileObject:${status}:${encodeURIComponent(reference.qualifiedName)}`;
}
