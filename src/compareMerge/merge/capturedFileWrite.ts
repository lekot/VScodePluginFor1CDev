import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

import type { CompareSession } from '../domain/compareSession';
import type { CompareMessage } from '../domain/compareContracts';
import type { CapturedFileWritePayload, MergeCandidate, MergeFileWitness, MergeOperation } from './mergePreview';
import type { BackupPlan } from './mergePlanner';
import {
  assertJournalNamespace,
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  canonicalizePathWithMissingSuffix,
  isPathInside,
  isSamePath,
  PathBoundaryError,
} from '../../services/configurationSession/pathBoundary';
import type { MutationStep } from '../../services/configurationSession/mutationPlan';
import { captureMergePath, mergeSnapshotHash, mutationFingerprint, type MergePathSnapshot } from './mergeSnapshot';
import { compareMessage, MISSING_TARGET_HASH } from './mergePreview';

export interface CapturedFileWriteResolution {
  readonly targetPath: string;
  readonly backupPath: string;
  readonly before: MergePathSnapshot;
  readonly contentBase64: string;
}

export interface CapturedFileCopyResolution {
  readonly sourcePath: string;
  readonly sourceRootUri: string;
  readonly targetPath: string;
  readonly backupPath: string;
  readonly expectedOldHash: string;
  readonly sourceHash: string;
  readonly sourceContentBase64: string;
  readonly before: MergePathSnapshot;
}

export interface FileWriteResolutionFailure {
  readonly code: string;
  readonly message: string;
}

export type FileWriteResolution<T> =
  | { readonly resolved: T }
  | { readonly failure: FileWriteResolutionFailure };

export interface MergeFileWitnessFailure extends FileWriteResolutionFailure {
  readonly operation: MergeOperation;
}

export interface MergeFileWitnessCheckResult {
  readonly failures: readonly MergeFileWitnessFailure[];
  readonly targetAssertions: readonly MergeWitnessAssertion[];
}

type MergeWitnessAssertion = Extract<MutationStep, { readonly type: 'assertFile' | 'assertDirectory' }>;

/** Returns a SHA-256 digest for canonical captured base64, or undefined for invalid input. */
export function capturedFileWriteHash(contentBase64: string): string | undefined {
  if (typeof contentBase64 !== 'string') {
    return undefined;
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.toString('base64') !== contentBase64) {
    return undefined;
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/** Checks the shape and path constraints before captured bytes enter a preview. */
export function validateCapturedFileWritePayload(
  payload: unknown,
  sourceIds?: ReadonlySet<string>,
): string[] {
  if (!isRecord(payload) || typeof payload.contentBase64 !== 'string' || !Array.isArray(payload.witnesses)) {
    return ['Captured file-write payload is missing captured bytes or witnesses.'];
  }
  if (capturedFileWriteHash(payload.contentBase64) === undefined) {
    return ['Captured file-write content is not canonical base64.'];
  }

  return validateMergeFileWitnesses(payload.witnesses, sourceIds);
}

/** Checks witness shape, source membership, hashes, and canonical source-relative paths. */
export function validateMergeFileWitnesses(
  witnesses: unknown,
  sourceIds?: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(witnesses)) {
    return ['File witnesses are missing or malformed.'];
  }

  const failures: string[] = [];
  const capturedByPath = new Map<string, MergeFileWitness>();
  for (const value of witnesses) {
    if (!isRecord(value)) {
      failures.push('Captured file-write witness is malformed.');
      continue;
    }
    const witness = value as unknown as MergeFileWitness;
    if (
      typeof witness.sourceId !== 'string' || witness.sourceId.length === 0 ||
      typeof witness.relativePath !== 'string' ||
      typeof witness.expectedHash !== 'string' ||
      (witness.kind !== undefined && witness.kind !== 'file' && witness.kind !== 'directory')
    ) {
      failures.push('Captured file-write witness is malformed.');
      continue;
    }
    if (sourceIds && !sourceIds.has(witness.sourceId)) {
      failures.push('Captured file-write witness references a source outside the current compare session.');
    }
    if (!isCanonicalWitnessRelativePath(witness.relativePath, witness.kind ?? 'file')) {
      failures.push('Captured file-write witness path is not a canonical source-relative path.');
    }
    if (witness.expectedHash !== MISSING_TARGET_HASH && !isSha256(witness.expectedHash)) {
      failures.push('Captured file-write witness hash is malformed.');
    }
    const normalizedPath = path.normalize(witness.relativePath).replace(/\\/g, '/');
    const key = `${witness.sourceId}\0${process.platform === 'win32' ? normalizedPath.toLocaleLowerCase() : normalizedPath}`;
    const previous = capturedByPath.get(key);
    if (previous && (previous.expectedHash !== witness.expectedHash || (previous.kind ?? 'file') !== (witness.kind ?? 'file'))) {
      failures.push('Captured witnesses contain contradictory hashes or kinds for the same source path.');
    } else if (!previous) {
      capturedByPath.set(key, witness);
    }
  }
  return failures;
}

/** Validates the captured bytes, guards, target path, and declared file effect for preview admission. */
export function validateCapturedFileWriteContract(
  candidate: Pick<MergeCandidate, 'fileWrite' | 'targetUri' | 'expectedOldHash' | 'newHash' | 'previewPath' | 'previewEffect'>,
  sourceIds?: ReadonlySet<string>,
): string[] {
  const failures: string[] = [];
  if (
    typeof candidate.targetUri !== 'string' || candidate.targetUri.length === 0 ||
    typeof candidate.expectedOldHash !== 'string' || candidate.expectedOldHash.length === 0 ||
    typeof candidate.newHash !== 'string' || candidate.newHash.length === 0
  ) {
    failures.push('File-write operation must include target uri, expected old hash, and new hash.');
  }
  if (
    typeof candidate.expectedOldHash === 'string' &&
    candidate.expectedOldHash !== MISSING_TARGET_HASH &&
    !/^[a-f0-9]{64}$/.test(candidate.expectedOldHash)
  ) {
    failures.push('File-write expected old hash is malformed.');
  }
  const payload = candidate.fileWrite as CapturedFileWritePayload | undefined;
  failures.push(...validateCapturedFileWritePayload(payload, sourceIds));
  const payloadHash = payload && typeof payload.contentBase64 === 'string'
    ? capturedFileWriteHash(payload.contentBase64)
    : undefined;
  if (!payloadHash || payloadHash !== candidate.newHash) {
    failures.push('File-write new hash must match the SHA-256 hash of captured bytes.');
  }
  if (
    candidate.previewPath !== undefined &&
    (typeof candidate.previewPath !== 'string' || !isCanonicalWitnessRelativePath(candidate.previewPath, 'file'))
  ) {
    failures.push('File-write preview path must be a canonical relative target path.');
  }
  if (
    candidate.previewEffect !== undefined &&
    candidate.previewEffect !== 'create' && candidate.previewEffect !== 'replace' && candidate.previewEffect !== 'delete'
  ) {
    failures.push('Merge preview effect is invalid.');
  }
  if (candidate.previewEffect === 'delete') {
    failures.push('Captured file-write operations cannot delete target files.');
  }
  if (candidate.previewEffect === 'create' && candidate.expectedOldHash !== MISSING_TARGET_HASH) {
    failures.push('A create effect requires a missing target guard.');
  }
  if (candidate.previewEffect === 'replace' && candidate.expectedOldHash === MISSING_TARGET_HASH) {
    failures.push('A replace effect requires an existing target guard.');
  }
  return failures;
}

/** Converts file-write contract failures into the same redacted diagnostics used by preview validation. */
export function validateCapturedFileWriteOperation(
  candidate: Pick<MergeCandidate, 'fileWrite' | 'targetUri' | 'expectedOldHash' | 'newHash' | 'previewPath' | 'previewEffect' | 'sourceId' | 'nodeId'>,
  session?: CompareSession,
): CompareMessage[] {
  const sourceIds = session
    ? new Set(session.state.sources.map((source) => source.sourceId))
    : undefined;
  return validateCapturedFileWriteContract(candidate, sourceIds).map((message) => compareMessage({
    severity: 'error',
    code: 'MERGE_FILE_WRITE_PAYLOAD_INVALID',
    sourceId: candidate.sourceId,
    nodeId: candidate.nodeId,
    path: candidate.targetUri,
    suggestedAction: message,
  }));
}

/** Rechecks all file-write source witnesses and builds journaled target CAS steps. */
export async function verifyCapturedFileWriteWitnesses(
  operations: readonly MergeOperation[],
  session: CompareSession,
  targetSourceId: string,
): Promise<MergeFileWitnessCheckResult> {
  const sourceIds = new Set(session.state.sources.map((source) => source.sourceId));
  const failures: MergeFileWitnessFailure[] = [];
  const targetAssertions = new Map<string, MergeWitnessAssertion>();

  for (const operation of operations) {
    const witnesses: MergeFileWitness[] = [];
    if (operation.sourceWitnesses !== undefined) {
      const failuresForOperation = validateMergeFileWitnesses(operation.sourceWitnesses, sourceIds);
      if (failuresForOperation.length > 0) {
        failures.push({
          operation,
          code: 'MERGE_SOURCE_WITNESS_INVALID',
          message: failuresForOperation[0]!,
        });
        continue;
      }
      witnesses.push(...operation.sourceWitnesses);
    }
    if (operation.kind === 'fileWrite') {
      const payloadFailures = validateCapturedFileWritePayload(operation.fileWrite, sourceIds);
      if (payloadFailures.length > 0) {
        failures.push({
          operation,
          code: 'MERGE_FILE_WRITE_PAYLOAD_INVALID',
          message: payloadFailures[0]!,
        });
        continue;
      }
      witnesses.push(...operation.fileWrite!.witnesses);
    } else if (isXmlOperation(operation.kind) && operation.xmlPatch?.sourceWitnesses) {
      const witnessFailures = validateMergeFileWitnesses(operation.xmlPatch.sourceWitnesses, sourceIds);
      if (witnessFailures.length > 0) {
        failures.push({
          operation,
          code: 'MERGE_XML_SOURCE_WITNESS_INVALID',
          message: witnessFailures[0]!,
        });
        continue;
      }
      witnesses.push(...operation.xmlPatch.sourceWitnesses);
    }
    if (witnesses.length === 0) {
      continue;
    }

    const combinedFailures = validateMergeFileWitnesses(witnesses, sourceIds);
    if (combinedFailures.length > 0) {
      failures.push({ operation, code: 'MERGE_SOURCE_WITNESS_INVALID', message: combinedFailures[0]! });
      continue;
    }

    const uniqueWitnesses = new Map<string, MergeFileWitness>();
    for (const witness of witnesses) {
      const normalizedPath = path.normalize(witness.relativePath).replace(/\\/g, '/');
      const key = `${witness.sourceId}\0${process.platform === 'win32' ? normalizedPath.toLocaleLowerCase() : normalizedPath}`;
      uniqueWitnesses.set(key, witness);
    }
    for (const witness of uniqueWitnesses.values()) {
      const checked = await checkWitness(session, witness);
      if ('failure' in checked) {
        failures.push({ operation, ...checked.failure });
        continue;
      }
      if (witness.sourceId !== targetSourceId) {
        continue;
      }

      const assertion = assertionForWitness(witness, checked.targetPath, checked.snapshot);
      const resolvedTargetPath = path.resolve(checked.targetPath);
      const key = process.platform === 'win32' ? resolvedTargetPath.toLocaleLowerCase() : resolvedTargetPath;
      const existing = targetAssertions.get(key);
      if (existing && !sameAssertion(existing, assertion)) {
        failures.push({
          operation,
          code: 'MERGE_WITNESS_CONFLICT',
          message: 'Approved file writes contain conflicting guards for the same target path.',
        });
        continue;
      }
      targetAssertions.set(key, assertion);
    }
  }

  return { failures, targetAssertions: [...targetAssertions.values()] };
}

function isXmlOperation(kind: MergeOperation['kind']): boolean {
  return kind === 'xmlNodeReplace' || kind === 'xmlNodeInsert' || kind === 'xmlNodeDelete' || kind === 'xmlNodeMove';
}

export async function resolveCapturedFileWriteOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  targetPath: string | undefined,
): Promise<FileWriteResolution<CapturedFileWriteResolution>> {
  const payload = operation.fileWrite;
  if (!payload || !operation.targetUri || !operation.expectedOldHash || !operation.newHash || !targetPath) {
    return { failure: { code: 'MERGE_TARGET_GUARD_MISSING', message: 'Captured file-write operation is incomplete.' } };
  }
  const contentHash = capturedFileWriteHash(payload.contentBase64);
  if (contentHash === undefined || contentHash !== operation.newHash) {
    return { failure: { code: 'MERGE_FILE_WRITE_HASH_MISMATCH', message: 'Captured bytes do not match the approved file-write hash.' } };
  }
  const backupPath = backupPathFor(operation, backupPlan);
  if (!backupPath) {
    return { failure: { code: 'MERGE_BACKUP_PLAN_INCOMPLETE', message: 'Backup plan is missing for captured file write.' } };
  }
  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, targetPath);
  if (boundaryFailure) {
    return { failure: boundaryFailure };
  }

  let before: MergePathSnapshot;
  try {
    before = await captureMergePath(targetPath);
  } catch (error) {
    return { failure: { code: 'MERGE_TARGET_READ_FAILED', message: `Failed to capture file-write target: ${errorMessage(error)}` } };
  }
  const currentHash = before.state === 'missing'
    ? MISSING_TARGET_HASH
    : before.type === 'file' ? before.hash : undefined;
  if (currentHash !== operation.expectedOldHash) {
    return { failure: { code: 'MERGE_STALE_TARGET_HASH', message: 'Captured file-write target changed before execution.' } };
  }
  return { resolved: { targetPath, backupPath, before, contentBase64: payload.contentBase64 } };
}

export async function resolveCapturedFileCopyOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  sourceRootUri: string | undefined,
  canonicalTargetPath: string | undefined,
): Promise<FileWriteResolution<CapturedFileCopyResolution>> {
  const payload = operation.fileOperation;
  if (
    !payload?.sourcePath || !payload.sourceHash || !operation.targetUri ||
    !operation.expectedOldHash || !operation.newHash
  ) {
    return { failure: { code: 'MERGE_TARGET_GUARD_MISSING', message: 'File copy operation is incomplete.' } };
  }
  const backupPath = backupPathFor(operation, backupPlan);
  if (!backupPath) {
    return { failure: { code: 'MERGE_BACKUP_PLAN_INCOMPLETE', message: 'Backup plan is missing for operation.' } };
  }

  const sourcePath = uriToPath(payload.sourcePath) ?? payload.sourcePath;
  const targetPath = canonicalTargetPath ?? uriToPath(operation.targetUri);
  if (!targetPath) {
    return { failure: { code: 'MERGE_TARGET_GUARD_MISSING', message: 'Target uri is not a file uri.' } };
  }
  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, targetPath);
  if (boundaryFailure) {
    return { failure: boundaryFailure };
  }
  const sourceBoundaryFailure = await ensureSourceInsideRoot(sourceRootUri, sourcePath, rootUri);
  if (sourceBoundaryFailure) {
    return { failure: sourceBoundaryFailure };
  }

  let sourceSnapshot: MergePathSnapshot;
  try {
    sourceSnapshot = await captureMergePath(sourcePath);
  } catch (error) {
    return { failure: { code: 'MERGE_TARGET_READ_FAILED', message: `Failed to read source file: ${errorMessage(error)}` } };
  }
  if (sourceSnapshot.state === 'missing' || sourceSnapshot.type !== 'file' || sourceSnapshot.contentBase64 === undefined) {
    return { failure: { code: 'MERGE_SOURCE_HASH_MISMATCH', message: 'Source file snapshot is unavailable.' } };
  }
  const sourceHash = mergeSnapshotHash(sourceSnapshot);
  if (sourceHash !== payload.sourceHash || sourceHash !== operation.newHash) {
    return { failure: { code: 'MERGE_SOURCE_HASH_MISMATCH', message: 'Source file hash does not match merge preview.' } };
  }

  let before: MergePathSnapshot;
  try {
    before = await captureMergePath(targetPath);
  } catch (error) {
    return { failure: { code: 'MERGE_TARGET_READ_FAILED', message: `Failed to read target file: ${errorMessage(error)}` } };
  }
  const currentHash = before.state === 'missing' ? MISSING_TARGET_HASH : before.type === 'file' ? before.hash : undefined;
  if (currentHash !== operation.expectedOldHash) {
    return { failure: { code: 'MERGE_STALE_TARGET_HASH', message: 'Target file hash changed before execution.' } };
  }

  return {
    resolved: {
      sourcePath,
      sourceRootUri: sourceRootUri!,
      targetPath,
      backupPath,
      expectedOldHash: operation.expectedOldHash,
      sourceHash,
      sourceContentBase64: sourceSnapshot.contentBase64,
      before,
    },
  };
}

async function checkWitness(
  session: CompareSession,
  witness: MergeFileWitness,
): Promise<{ targetPath: string; snapshot: MergePathSnapshot } | { failure: FileWriteResolutionFailure }> {
  const state = session.state;
  const source = state.sources.find((item) => item.sourceId === witness.sourceId);
  if (!source) {
    return { failure: { code: 'MERGE_WITNESS_SOURCE_MISSING', message: 'A file-write witness source is not part of the current compare session.' } };
  }
  const rootPath = uriToPath(source.rootUri);
  if (!rootPath) {
    return { failure: { code: 'MERGE_WITNESS_SOURCE_ROOT_MISSING', message: 'A file-write witness source root is unavailable.' } };
  }

  try {
    const absoluteWitnessPath = path.resolve(rootPath, ...witness.relativePath.split(/[\\/]/));
    await assertNoRawSymlinkSegments(absoluteWitnessPath);
    const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(rootPath, absoluteWitnessPath);
    const journal = await assertJournalNamespace(canonicalRoot);
    if (
      isPathInside(journal.canonicalJournalRoot, canonicalTarget) ||
      isPathInside(canonicalTarget, journal.canonicalJournalRoot)
    ) {
      return { failure: { code: 'MERGE_WITNESS_JOURNAL_FORBIDDEN', message: 'File-write witness overlaps the mutation journal namespace.' } };
    }
    await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
    const snapshot = await captureMergePath(canonicalTarget, { retainContent: false });
    const actualHash = snapshot.state === 'missing' ? MISSING_TARGET_HASH : mergeSnapshotHash(snapshot);
    if (actualHash !== witness.expectedHash) {
      return { failure: { code: 'MERGE_WITNESS_MISMATCH', message: 'A captured source or target witness changed after preview creation.' } };
    }
    if (
      snapshot.state !== 'missing' &&
      ((witness.kind ?? 'file') === 'file' ? snapshot.type !== 'file' : snapshot.type !== 'directory')
    ) {
      return { failure: { code: 'MERGE_WITNESS_KIND_MISMATCH', message: 'A captured source or target witness has an unexpected filesystem type.' } };
    }
    return { targetPath: canonicalTarget, snapshot };
  } catch {
    return { failure: { code: 'MERGE_WITNESS_READ_FAILED', message: 'A captured source or target witness could not be safely read.' } };
  }
}

function assertionForWitness(
  witness: MergeFileWitness,
  targetPath: string,
  snapshot: MergePathSnapshot,
): MergeWitnessAssertion {
  if (witness.expectedHash === MISSING_TARGET_HASH) {
    return { type: 'assertDirectory', targetPath, expected: { state: 'missing' } };
  }
  if ((witness.kind ?? 'file') === 'file') {
    return { type: 'assertFile', targetPath, expected: { state: 'file', hash: witness.expectedHash } };
  }
  return {
    type: 'assertDirectory',
    targetPath,
    expected: { state: 'directory', fingerprint: mutationFingerprint(snapshot) },
  };
}

function sameAssertion(left: MergeWitnessAssertion, right: MergeWitnessAssertion): boolean {
  if (left.type !== right.type || !('targetPath' in left) || !('targetPath' in right) || !isSamePath(left.targetPath, right.targetPath)) {
    return false;
  }
  if (left.type === 'assertFile' && right.type === 'assertFile') {
    return left.expected.hash === right.expected.hash;
  }
  if (left.type === 'assertDirectory' && right.type === 'assertDirectory') {
    if (left.expected.state !== right.expected.state) {
      return false;
    }
    return left.expected.state === 'missing' || (
      right.expected.state === 'directory' && left.expected.fingerprint === right.expected.fingerprint
    );
  }
  return false;
}

export function isCanonicalWitnessRelativePath(relativePath: string, _kind: 'file' | 'directory'): boolean {
  if (relativePath === '') {
    return false;
  }
  if (
    relativePath.trim() !== relativePath || relativePath.includes('\0') || relativePath.includes(':') ||
    path.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    return false;
  }
  const hasPosixSeparators = relativePath.includes('/');
  const hasWindowsSeparators = relativePath.includes('\\');
  if (hasPosixSeparators && hasWindowsSeparators) {
    return false;
  }
  const segments = relativePath.split(hasWindowsSeparators ? '\\' : '/');
  return segments.every((segment) =>
    segment.length > 0 && segment !== '.' && segment !== '..' && segment.toLocaleLowerCase() !== '.cdt-journal'
  );
}

function backupPathFor(operation: MergeOperation, backupPlan: BackupPlan): string | undefined {
  const backup = backupPlan.items.find((item) => item.operationId === operation.operationId);
  const backupPath = backup ? uriToPath(backup.backupUri) : undefined;
  if (
    !backup || !backupPath || backup.targetUri !== operation.targetUri ||
    backup.expectedOldHash !== operation.expectedOldHash
  ) {
    return undefined;
  }
  return backupPath;
}

export async function ensureSourceInsideRoot(
  sourceRootUri: string | undefined,
  sourcePath: string,
  targetRootUri?: string,
): Promise<FileWriteResolutionFailure | undefined> {
  const candidateRootUris = [sourceRootUri, targetRootUri].filter((rootUri): rootUri is string => rootUri !== undefined);
  if (candidateRootUris.length === 0) {
    return { code: 'MERGE_SOURCE_ROOT_MISSING', message: 'Source root uri is not available for copy operation.' };
  }
  let lastMessage = 'Merge source path is outside all captured roots.';
  for (const rootUri of candidateRootUris) {
    const rootPath = uriToPath(rootUri);
    if (!rootPath) {
      continue;
    }
    const boundaryFailure = await validatePathBoundary(rootPath, sourcePath, true);
    if (!boundaryFailure) {
      return undefined;
    }
    lastMessage = boundaryFailure.message;
  }
  return { code: 'MERGE_SOURCE_OUTSIDE_ROOT', message: lastMessage };
}

export async function ensureTargetInsideRootAllowMissing(
  rootUri: string,
  targetPath: string,
): Promise<FileWriteResolutionFailure | undefined> {
  const rootPath = uriToPath(rootUri);
  if (!rootPath) {
    return { code: 'MERGE_TARGET_ROOT_MISSING', message: 'Left configuration root uri is not a file uri.' };
  }
  return validatePathBoundary(rootPath, targetPath, false);
}

async function validatePathBoundary(
  rootPath: string,
  targetPath: string,
  allowRootTarget: boolean,
): Promise<FileWriteResolutionFailure | undefined> {
  const resolved = await resolvePathBoundary(rootPath, targetPath, allowRootTarget);
  return 'failure' in resolved ? resolved.failure : undefined;
}

export async function resolveMergePathBoundary(
  rootPath: string,
  targetPath: string,
  allowRootTarget: boolean,
): Promise<
  | { canonicalRoot: string; canonicalTarget: string }
  | { failure: FileWriteResolutionFailure }
> {
  try {
    const canonicalRoot = await fs.realpath(rootPath);
    await assertNoRawSymlinkSegments(targetPath);
    const candidatePath = await canonicalizePathWithMissingSuffix(targetPath);
    const { canonicalRoot: assertedRoot, canonicalTarget } = await assertPathWithinRoot(canonicalRoot, candidatePath);
    if (!isSamePath(canonicalRoot, assertedRoot)) {
      throw new Error('Configuration root changed while resolving merge target.');
    }
    if (!allowRootTarget && isSamePath(canonicalRoot, canonicalTarget)) {
      return { failure: { code: 'MERGE_TARGET_ROOT_FORBIDDEN', message: 'Merge target cannot be the configuration root.' } };
    }
    const journal = await assertJournalNamespace(canonicalRoot);
    if (
      isPathInside(journal.canonicalJournalRoot, canonicalTarget) ||
      isPathInside(canonicalTarget, journal.canonicalJournalRoot)
    ) {
      return { failure: { code: 'MERGE_JOURNAL_NAMESPACE_FORBIDDEN', message: 'Merge path overlaps the configuration journal namespace.' } };
    }
    await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
    try {
      const targetStat = await fs.lstat(canonicalTarget);
      if (targetStat.isSymbolicLink()) {
        return { failure: { code: 'MERGE_LINK_UNSUPPORTED', message: 'Merge does not accept symbolic link targets or sources.' } };
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
    return { canonicalRoot, canonicalTarget };
  } catch (error) {
    if (error instanceof PathBoundaryError && error.code === 'PATH_OUTSIDE_ROOT') {
      return { failure: { code: 'MERGE_TARGET_OUTSIDE_ROOT', message: error.message } };
    }
    return { failure: { code: 'MERGE_PATH_BOUNDARY_FAILED', message: `Merge path boundary check failed: ${errorMessage(error)}` } };
  }
}

async function resolvePathBoundary(
  rootPath: string,
  targetPath: string,
  allowRootTarget: boolean,
): Promise<
  | { canonicalRoot: string; canonicalTarget: string }
  | { failure: FileWriteResolutionFailure }
> {
  return resolveMergePathBoundary(rootPath, targetPath, allowRootTarget);
}

export async function assertNoRawSymlinkSegments(targetPath: string): Promise<void> {
  const absolutePath = path.resolve(targetPath);
  const parsed = path.parse(absolutePath);
  const segments = path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]!);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Merge path contains a symbolic link: ${cursor}`);
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error(`Merge path contains a non-directory parent: ${cursor}`);
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }
}

function uriToPath(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
