import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/logger';
import { assertJournalNamespace, isPathInside, isSamePath } from './pathBoundary';

export interface RootLeaseCleanupFailure {
  readonly stage: string;
  readonly fsCode?: string;
  readonly remainingRootEntryCount?: number;
}

type JournalEntryType = 'file' | 'directory' | 'symlink' | 'other';

interface JournalEntryDiagnostic {
  readonly name: string;
  readonly type: JournalEntryType;
}

interface DirectoryDiagnostic {
  readonly name: string;
  readonly type?: JournalEntryType;
  readonly entries?: readonly JournalEntryDiagnostic[];
  readonly inspectionError?: { readonly fsCode?: string; readonly errorType: string };
}

export async function logCleanupFailure(
  rootPath: string,
  journalRoot: string,
  stage: string,
  error: unknown,
  targetPath?: string,
  leaseLifecycle?: Readonly<Record<string, string | number | boolean | undefined>>,
): Promise<RootLeaseCleanupFailure> {
  const fsCode = filesystemErrorCode(error);
  let remainingEntries: Awaited<ReturnType<typeof inspectRemainingJournalEntries>> = { journalRoot: [] };
  try {
    remainingEntries = await inspectRemainingJournalEntries(rootPath, journalRoot, targetPath);
  } catch (inspectionError) {
    remainingEntries = {
      journalRoot: [],
      journalRootInspectionError: cleanupErrorSummary(inspectionError),
    };
  }
  const diagnostic: {
    stage: string;
    fsCode?: string;
    errorType: string;
    targetName?: string;
    remainingEntries: {
      journalRoot: readonly JournalEntryDiagnostic[];
      journalRootInspectionError?: { readonly fsCode?: string; readonly errorType: string };
      target?: DirectoryDiagnostic;
    };
    leaseLifecycle?: Readonly<Record<string, string | number | boolean | undefined>>;
  } = {
    stage,
    fsCode,
    errorType: errorTypeName(error),
    targetName: targetPath ? path.basename(targetPath) : undefined,
    remainingEntries,
    leaseLifecycle,
  };
  try {
    Logger.warn('Mutation plan cleanup failure', diagnostic);
  } catch {
    // The cleanup failure remains available to the caller even if the logger fails.
  }
  return {
    stage,
    fsCode,
    remainingRootEntryCount: remainingEntries.journalRootInspectionError
      ? undefined
      : remainingEntries.journalRoot.length,
  };
}

async function inspectRemainingJournalEntries(
  rootPath: string,
  journalRoot: string,
  targetPath?: string,
): Promise<{
  journalRoot: readonly JournalEntryDiagnostic[];
  journalRootInspectionError?: { readonly fsCode?: string; readonly errorType: string };
  target?: DirectoryDiagnostic;
}> {
  const empty: JournalEntryDiagnostic[] = [];
  const snapshot: {
    journalRoot: readonly JournalEntryDiagnostic[];
    journalRootInspectionError?: { readonly fsCode?: string; readonly errorType: string };
    target?: DirectoryDiagnostic;
  } = { journalRoot: empty };

  let canonicalJournalRoot: string;
  try {
    canonicalJournalRoot = (await assertJournalNamespace(rootPath)).canonicalJournalRoot;
  } catch (error) {
    snapshot.journalRootInspectionError = cleanupErrorSummary(error);
    return snapshot;
  }

  try {
    const rootStat = await fs.promises.lstat(canonicalJournalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      snapshot.journalRootInspectionError = { errorType: 'UnsafeJournalRoot' };
      return snapshot;
    }
    snapshot.journalRoot = await readDirectoryEntryDiagnostics(canonicalJournalRoot);
  } catch (error) {
    if (!isMissingError(error)) {
      snapshot.journalRootInspectionError = cleanupErrorSummary(error);
    }
    return snapshot;
  }

  if (!targetPath || isSamePath(path.resolve(targetPath), path.resolve(journalRoot))) {
    return snapshot;
  }

  const targetName = path.basename(targetPath);
  const canonicalTarget = path.join(canonicalJournalRoot, targetName);
  if (targetName === '' || targetName === '.' || targetName === '..'
    || !isPathInside(canonicalJournalRoot, canonicalTarget)) {
    snapshot.target = { name: targetName, inspectionError: { errorType: 'UnsafeTargetName' } };
    return snapshot;
  }

  try {
    const targetStat = await fs.promises.lstat(canonicalTarget);
    const targetType = diagnosticEntryType(targetStat);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      snapshot.target = { name: targetName, type: targetType };
      return snapshot;
    }
    const realTarget = await fs.promises.realpath(canonicalTarget);
    if (!isPathInside(canonicalJournalRoot, realTarget) || !isSamePath(realTarget, canonicalTarget)) {
      snapshot.target = { name: targetName, type: 'symlink', inspectionError: { errorType: 'UnsafeTargetPath' } };
      return snapshot;
    }
    snapshot.target = {
      name: targetName,
      type: 'directory',
      entries: await readDirectoryEntryDiagnostics(realTarget),
    };
  } catch (error) {
    if (!isMissingError(error)) {
      snapshot.target = { name: targetName, inspectionError: cleanupErrorSummary(error) };
    }
  }
  return snapshot;
}

async function readDirectoryEntryDiagnostics(directoryPath: string): Promise<readonly JournalEntryDiagnostic[]> {
  const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  return entries.map((entry) => ({ name: entry.name, type: diagnosticDirentType(entry) }));
}

function diagnosticDirentType(entry: fs.Dirent): JournalEntryType {
  if (entry.isSymbolicLink()) { return 'symlink'; }
  if (entry.isDirectory()) { return 'directory'; }
  if (entry.isFile()) { return 'file'; }
  return 'other';
}

function diagnosticEntryType(stat: fs.Stats): JournalEntryType {
  if (stat.isSymbolicLink()) { return 'symlink'; }
  if (stat.isDirectory()) { return 'directory'; }
  if (stat.isFile()) { return 'file'; }
  return 'other';
}

function cleanupErrorSummary(error: unknown): { fsCode?: string; errorType: string } {
  return { fsCode: filesystemErrorCode(error), errorType: errorTypeName(error) };
}

export function filesystemErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code)) {
      return code;
    }
  }
  if (error instanceof Error) {
    return /\b(E[A-Z0-9_]+)\b/.exec(error.message)?.[1];
  }
  return undefined;
}

function errorTypeName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
