import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { logCleanupFailure } from './journalCleanupDiagnostics';
import { assertJournalNamespace, isPathInside, isSamePath } from './pathBoundary';
import { Logger } from '../../utils/logger';

export const ROOT_LEASE_FILE = '.root-lease.json';
export const ROOT_LEASE_QUARANTINE_PREFIX = `${ROOT_LEASE_FILE}.claim-`;
export const LEASE_TTL_MS = 15000;
export const LEASE_HEARTBEAT_INTERVAL_MS = 2000;

export interface RootLeaseRecord {
  leaseId: string;
  pid: number;
  createdAt: number;
  heartbeatAt: number;
  operationId: string;
}

export interface RootLeaseHeartbeatRecord {
  leaseId: string;
  heartbeatAt: number;
}

export class MutationPlanError extends Error {
  constructor(
    readonly code: 'PLAN_CONFLICT' | 'PLAN_FAILED' | 'RECOVERY_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'MutationPlanError';
  }
}

export class RootLeaseOwnershipError extends MutationPlanError {
  constructor(message: string, readonly reason: 'lost' | 'unverified' = 'unverified') {
    super('PLAN_CONFLICT', message);
    this.name = 'RootLeaseOwnershipError';
  }
}

export function rootLeaseHeartbeatPath(journalRoot: string, leaseId: string): string {
  const leaseKey = createHash('sha256').update(leaseId, 'utf8').digest('hex');
  return path.join(journalRoot, `${ROOT_LEASE_FILE}.${leaseKey}.heartbeat`);
}

function parseRootLeaseClaimTimestamp(name: string): number | undefined {
  const suffix = name.slice(ROOT_LEASE_QUARANTINE_PREFIX.length);
  if (!suffix.startsWith('v2-')) { return undefined; }
  const match = /^v2-(\d+)-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(suffix);
  if (!match) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease claim name is malformed.');
  }
  const claimedAt = Number(match[1]);
  const claimantPid = Number(match[2]);
  if (!Number.isSafeInteger(claimedAt) || claimedAt < 0
    || !Number.isSafeInteger(claimantPid) || claimantPid <= 0) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease claim metadata is invalid.');
  }
  return claimedAt;
}

export function parseRootLeaseRecord(raw: string): RootLeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease contains malformed JSON: ${errorMessage(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease record must be an object.');
  }
  const record = parsed as Partial<RootLeaseRecord>;
  const now = Date.now();
  if (
    typeof record.leaseId !== 'string'
    || record.leaseId.trim().length === 0
    || record.leaseId.length > 256
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.createdAt !== 'number'
    || !Number.isFinite(record.createdAt)
    || record.createdAt < 0
    || record.createdAt > now + LEASE_TTL_MS
    || typeof record.heartbeatAt !== 'number'
    || !Number.isFinite(record.heartbeatAt)
    || record.heartbeatAt < 0
    || record.heartbeatAt > now + LEASE_TTL_MS
    || typeof record.operationId !== 'string'
    || record.operationId.trim().length === 0
  ) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease record has invalid fields.');
  }
  return record as RootLeaseRecord;
}

function parseRootLeaseHeartbeat(raw: string, leaseId: string): RootLeaseHeartbeatRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease heartbeat is malformed: ${errorMessage(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease heartbeat must be an object.');
  }
  const heartbeat = parsed as Partial<RootLeaseHeartbeatRecord>;
  if (
    heartbeat.leaseId !== leaseId
    || typeof heartbeat.heartbeatAt !== 'number'
    || !Number.isFinite(heartbeat.heartbeatAt)
    || heartbeat.heartbeatAt < 0
    || heartbeat.heartbeatAt > Date.now() + LEASE_TTL_MS
  ) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease heartbeat has invalid fields.');
  }
  return heartbeat as RootLeaseHeartbeatRecord;
}

export async function readRootLeaseHeartbeat(
  heartbeatPath: string,
  lease: RootLeaseRecord,
): Promise<number> {
  try {
    const raw = await fs.promises.readFile(heartbeatPath, 'utf8');
    return parseRootLeaseHeartbeat(raw, lease.leaseId).heartbeatAt;
  } catch (error) {
    if (isMissingError(error)) {
      return lease.heartbeatAt;
    }
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Cannot inspect configuration root lease heartbeat: ${errorMessage(error)}`,
    );
  }
}

export async function writeRootLeaseHeartbeat(
  heartbeatPath: string,
  leaseId: string,
  heartbeatAt: number,
): Promise<void> {
  const tempPath = `${heartbeatPath}.${randomUUID()}.tmp`;
  try {
    const heartbeat: RootLeaseHeartbeatRecord = { leaseId, heartbeatAt };
    await fs.promises.writeFile(tempPath, JSON.stringify(heartbeat), { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(tempPath, heartbeatPath);
  } catch (error) {
    try {
      await fs.promises.rm(tempPath, { force: true });
    } catch (cleanupError) {
      try {
        const journalRoot = path.dirname(heartbeatPath);
        await logCleanupFailure(
          path.dirname(journalRoot),
          journalRoot,
          'root-lease-heartbeat-temp-remove',
          cleanupError,
          tempPath,
          { leaseId, processId: process.pid, state: 'active', heartbeatInFlight: true },
        );
      } catch {
        // Preserve the heartbeat write error even if diagnostics cannot be collected.
      }
    }
    throw error;
  }
}

export async function ensureRootLeaseQuarantineClear(journalRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(journalRoot);
  } catch (error) {
    if (isMissingError(error)) { return; }
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Cannot inspect configuration root lease state: ${errorMessage(error)}`,
    );
  }
  for (const name of entries.filter((entryName) => entryName.startsWith(ROOT_LEASE_QUARANTINE_PREFIX))) {
    const claimPath = path.join(journalRoot, name);
    let claim: RootLeaseRecord;
    try {
      claim = parseRootLeaseRecord(await fs.promises.readFile(claimPath, 'utf8'));
    } catch (error) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        `Configuration root lease claim cannot be validated: ${errorMessage(error)}`,
      );
    }
    const claimedAt = parseRootLeaseClaimTimestamp(name);
    if (claimedAt !== undefined && Date.now() - claimedAt < LEASE_TTL_MS) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'Configuration root lease is being fenced by an active process.',
      );
    }
    const heartbeatPath = rootLeaseHeartbeatPath(journalRoot, claim.leaseId);
    const lastHeartbeat = await readRootLeaseHeartbeat(heartbeatPath, claim);
    if (isProcessAlive(claim.pid) && Date.now() - lastHeartbeat <= LEASE_TTL_MS) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'Configuration root lease is being fenced by an active process.',
      );
    }
    try {
      await fs.promises.rm(claimPath, { force: true });
      await fs.promises.rm(heartbeatPath, { force: true });
    } catch (error) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        `Cannot recover stale configuration root lease claim: ${errorMessage(error)}`,
      );
    }
  }
}

export async function assertRootLeaseOwned(
  leasePath: string,
  journalRoot: string,
  expectedLeaseId: string,
): Promise<void> {
  try {
    await ensureRootLeaseQuarantineClear(journalRoot);
  } catch (error) {
    if (error instanceof RootLeaseOwnershipError) { throw error; }
    throw new RootLeaseOwnershipError(
      `Configuration root lease ownership could not be verified: ${errorMessage(error)}`,
    );
  }
  let raw: string;
  try {
    raw = await fs.promises.readFile(leasePath, 'utf8');
  } catch (error) {
    if (isMissingError(error)) {
      throw new RootLeaseOwnershipError('Configuration root lease is no longer present.', 'lost');
    }
    throw new RootLeaseOwnershipError(
      `Configuration root lease ownership could not be verified: ${errorMessage(error)}`,
    );
  }
  let current: RootLeaseRecord;
  try {
    current = parseRootLeaseRecord(raw);
  } catch (error) {
    throw new RootLeaseOwnershipError(
      `Configuration root lease ownership could not be verified: ${errorMessage(error)}`,
    );
  }
  if (current.leaseId !== expectedLeaseId) {
    throw new RootLeaseOwnershipError('Configuration root lease ownership was lost.', 'lost');
  }
}

async function restoreRootLeaseClaim(claimPath: string, leasePath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.promises.link(claimPath, leasePath);
      break;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        if (attempt === 9) { return false; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        `Cannot restore a replaced configuration root lease: ${errorMessage(error)}`,
      );
    }
  }
  try {
    await fs.promises.rm(claimPath, { force: true });
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease was restored but its claim marker remains: ${errorMessage(error)}`,
    );
  }
  return true;
}

/** Removes a lease only after atomically moving and validating the exact file at the path. */
export async function removeRootLeaseIfUnchanged(leasePath: string, expectedLeaseId: string): Promise<boolean> {
  const claimPath = path.join(
    path.dirname(leasePath),
    `${ROOT_LEASE_QUARANTINE_PREFIX}v2-${Date.now()}-${process.pid}-${randomUUID()}`,
  );
  try {
    await fs.promises.rename(leasePath, claimPath);
  } catch (error) {
    if (isMissingError(error)) { return false; }
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Cannot fence configuration root lease: ${errorMessage(error)}`,
    );
  }

  let movedLease: RootLeaseRecord;
  try {
    movedLease = parseRootLeaseRecord(await fs.promises.readFile(claimPath, 'utf8'));
  } catch (error) {
    const restored = await restoreRootLeaseClaim(claimPath, leasePath).catch(() => false);
    if (!restored) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'Configuration root lease could not be validated or restored; the claim marker was preserved.',
      );
    }
    throw error instanceof MutationPlanError
      ? error
      : new MutationPlanError('PLAN_CONFLICT', `Cannot validate moved root lease: ${errorMessage(error)}`);
  }

  if (movedLease.leaseId !== expectedLeaseId) {
    const restored = await restoreRootLeaseClaim(claimPath, leasePath);
    if (!restored) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'A replacement root lease appeared during fencing; its predecessor was preserved in a claim marker.',
      );
    }
    return false;
  }

  try {
    await fs.promises.rm(claimPath, { force: true });
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease was fenced but its claim marker could not be removed: ${errorMessage(error)}`,
    );
  }
  return true;
}

export async function cleanupStaleRootLeaseHeartbeats(
  rootPath: string,
  journalRoot: string,
  currentLeaseId: string,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const heartbeatPrefix = `${ROOT_LEASE_FILE}.`;
  const { canonicalJournalRoot } = await assertJournalNamespace(rootPath);
  const entries = await fs.promises.readdir(journalRoot, { withFileTypes: true });
  for (const entry of entries) {
    const normalizedName = entry.name.toLowerCase();
    if (!normalizedName.startsWith(heartbeatPrefix.toLowerCase()) || !normalizedName.includes('heartbeat')) {
      continue;
    }
    const pathPattern = /^\.root-lease\.json\.([0-9a-f]{64})\.heartbeat$/;
    const match = pathPattern.exec(entry.name);
    const heartbeatPath = path.join(journalRoot, entry.name);
    if (!match) {
      return await failStaleHeartbeatCleanup(
        rootPath,
        journalRoot,
        heartbeatPath,
        new Error('Unrecognized root lease heartbeat entry name.'),
      );
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return await failStaleHeartbeatCleanup(
        rootPath,
        journalRoot,
        heartbeatPath,
        new Error('Root lease heartbeat entry is not a regular file.'),
      );
    }
    try {
      const expectedPath = path.join(canonicalJournalRoot, entry.name);
      const canonicalPath = await fs.promises.realpath(heartbeatPath);
      if (!isPathInside(canonicalJournalRoot, canonicalPath)
        || !isSamePath(canonicalPath, expectedPath)) {
        throw new Error('Root lease heartbeat path is not canonical within the journal root.');
      }
      const raw = await fs.promises.readFile(canonicalPath, 'utf8');
      const parsed = JSON.parse(raw) as { leaseId?: unknown };
      if (typeof parsed.leaseId !== 'string') {
        throw new Error('Root lease heartbeat has no lease identifier.');
      }
      const heartbeat = parseRootLeaseHeartbeat(raw, parsed.leaseId);
      const expectedHash = createHash('sha256').update(heartbeat.leaseId, 'utf8').digest('hex');
      if (expectedHash !== match[1]) {
        throw new Error('Root lease heartbeat filename does not match its record.');
      }
      if (heartbeat.leaseId === currentLeaseId) {
        continue;
      }
      await assertOwned();
      await fs.promises.rm(canonicalPath, { force: true });
      Logger.info('Removed validated stale root lease heartbeat', entry.name);
    } catch (error) {
      await failStaleHeartbeatCleanup(rootPath, journalRoot, heartbeatPath, error);
    }
  }
}

async function failStaleHeartbeatCleanup(
  rootPath: string,
  journalRoot: string,
  heartbeatPath: string,
  error: unknown,
): Promise<never> {
  await logCleanupFailure(
    rootPath,
    journalRoot,
    'stale-root-lease-heartbeat-cleanup',
    error,
    heartbeatPath,
    { state: 'recovery', heartbeatStopped: true, ownershipVerified: false },
  );
  throw new MutationPlanError(
    'RECOVERY_REQUIRED',
    `Cannot safely clean root lease heartbeat "${path.basename(heartbeatPath)}": ${errorMessage(error)}`,
  );
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EPERM');
  }
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
