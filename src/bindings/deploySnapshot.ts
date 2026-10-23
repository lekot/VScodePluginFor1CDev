import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

const DEPLOY_SNAPSHOT_COPY_CONCURRENCY = 8;

export class DeploySnapshotCancelledError extends Error {
  readonly code = 'DEPLOY_SNAPSHOT_CANCELLED';

  constructor() {
    super('Deploy snapshot creation cancelled');
    this.name = 'DeploySnapshotCancelledError';
  }
}

export interface DeploySnapshotOptions {
  readonly concurrency?: number;
  /** Test seam; production uses fs.promises.copyFile. */
  readonly copyFile?: (source: string, destination: string) => Promise<void>;
}

interface DeploySnapshotPlan {
  readonly directories: Array<{ source: string; relativePath: string }>;
  readonly files: Array<{ source: string; relativePath: string }>;
  readonly symlinks: Array<{ source: string; relativePath: string }>;
}

function throwIfSnapshotCancelled(token: Pick<vscode.CancellationToken, 'isCancellationRequested'>): void {
  if (token.isCancellationRequested) {
    throw new DeploySnapshotCancelledError();
  }
}

async function buildDeploySnapshotPlan(
  sourceDir: string,
  token: Pick<vscode.CancellationToken, 'isCancellationRequested'>,
): Promise<DeploySnapshotPlan> {
  const directories: DeploySnapshotPlan['directories'] = [];
  const files: DeploySnapshotPlan['files'] = [];
  const symlinks: DeploySnapshotPlan['symlinks'] = [];
  const pending = [{ source: sourceDir, relativePath: '' }];

  while (pending.length > 0) {
    throwIfSnapshotCancelled(token);
    const current = pending.pop()!;
    const stat = await fs.promises.lstat(current.source);
    if (stat.isSymbolicLink()) {
      symlinks.push(current);
      continue;
    }
    if (stat.isDirectory()) {
      directories.push(current);
      const entries = await fs.promises.readdir(current.source, { withFileTypes: true });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        pending.push({
          source: path.join(current.source, entry.name),
          relativePath: path.join(current.relativePath, entry.name),
        });
      }
      continue;
    }
    if (stat.isFile()) {
      files.push(current);
    }
  }

  return { directories, files, symlinks };
}

async function mapDeploySnapshotLimit<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  async function run(): Promise<void> {
    while (nextIndex < items.length && !failed) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(items[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  if (failed) {
    throw firstError;
  }
}

/** Async, bounded and cancellation-aware deploy snapshot. */
export async function createConfigurationSnapshot(
  sourceDir: string,
  token: Pick<vscode.CancellationToken, 'isCancellationRequested'>,
  options: DeploySnapshotOptions = {},
): Promise<string> {
  const plan = await buildDeploySnapshotPlan(sourceDir, token);
  throwIfSnapshotCancelled(token);

  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cv-deploy-snap-'));
  const destination = path.join(parent, 'cfg');
  try {
    for (const directory of plan.directories) {
      throwIfSnapshotCancelled(token);
      await fs.promises.mkdir(path.join(destination, directory.relativePath), { recursive: true });
    }
    for (const link of plan.symlinks) {
      throwIfSnapshotCancelled(token);
      const target = await fs.promises.readlink(link.source);
      await fs.promises.symlink(target, path.join(destination, link.relativePath));
    }
    const copyFile = options.copyFile ?? fs.promises.copyFile.bind(fs.promises);
    await mapDeploySnapshotLimit(
      plan.files,
      options.concurrency ?? DEPLOY_SNAPSHOT_COPY_CONCURRENCY,
      async (file) => {
        throwIfSnapshotCancelled(token);
        await copyFile(file.source, path.join(destination, file.relativePath));
        throwIfSnapshotCancelled(token);
      },
    );
    return destination;
  } catch (error) {
    await fs.promises.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Best-effort removal of the temporary parent directory for a completed snapshot. */
export async function cleanupConfigurationSnapshot(snapshotDir: string): Promise<void> {
  const parent = path.dirname(snapshotDir);
  try {
    await fs.promises.rm(parent, { recursive: true, force: true });
  } catch {
    /* Temporary snapshot cleanup must not change the deploy outcome. */
  }
}
