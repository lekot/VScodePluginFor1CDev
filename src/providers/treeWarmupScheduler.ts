import { Logger } from '../utils/logger';
import { TreeNode } from '../models/treeNode';
import { getTypeIndexFolders, isTypeIndexLoaded } from './typeFolderSelector';

const TYPE_CONTENTS_WARMUP_PRIORITY = new Map<string, number>([
  ['Catalogs', 0],
  ['Documents', 1],
  ['Enums', 2],
  ['CommonModules', 3],
  ['InformationRegisters', 4],
  ['Reports', 5],
  ['DataProcessors', 6],
  ['Roles', 7],
  ['Constants', 8],
  ['CommonPictures', 9],
]);

const TYPE_CONTENTS_WARMUP_DEFAULT_BUDGET_MS = 100;

export interface TypeContentsWarmupOptions {
  delayMs?: number;
  budgetMs?: number;
  rootIds?: readonly string[];
  preferredRootId?: string;
  slicePauseMs?: number;
}

export interface TreeWarmupSchedulerPorts {
  getRoots(): readonly TreeNode[];
  loadTypeFolderIndex(node: TreeNode): Promise<TreeNode[]>;
}

/** Owns only the background warmup timer, generation, and scheduling policy. */
export class TreeWarmupScheduler {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly ports: TreeWarmupSchedulerPorts) {}

  start(options: number | TypeContentsWarmupOptions = 1000): void {
    if (this.disposed) {
      return;
    }
    const normalizedOptions: TypeContentsWarmupOptions = typeof options === 'number'
      ? { delayMs: options }
      : options;
    this.clearScheduledWarmup();
    const generation = ++this.generation;
    const selectedRootIds = normalizedOptions.rootIds
      ? new Set(normalizedOptions.rootIds)
      : undefined;
    const roots = this.ports.getRoots().filter((root) => !selectedRootIds || selectedRootIds.has(root.id));
    if (roots.length === 0) {
      return;
    }
    if (normalizedOptions.preferredRootId) {
      const idx = roots.findIndex((root) => root.id === normalizedOptions.preferredRootId);
      if (idx > 0) {
        const [preferred] = roots.splice(idx, 1);
        roots.unshift(preferred);
      }
    }
    const budgetMs = normalizedOptions.budgetMs ?? TYPE_CONTENTS_WARMUP_DEFAULT_BUDGET_MS;
    const slicePauseMs = normalizedOptions.slicePauseMs ?? 50;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.warmUpTypeContentsCache(roots, generation, budgetMs, slicePauseMs).catch((error) => {
        Logger.warn('Type contents cache warmup failed', error);
      });
    }, normalizedOptions.delayMs ?? 1000);
  }

  cancel(): void {
    this.generation++;
    this.clearScheduledWarmup();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private clearScheduledWarmup(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  private collectWarmupTypeFolders(root: TreeNode): TreeNode[] {
    const folders = getTypeIndexFolders(root).filter((folder) => !isTypeIndexLoaded(folder));
    return folders.sort((a, b) => {
      const priorityA = TYPE_CONTENTS_WARMUP_PRIORITY.get(a.id) ?? 1000;
      const priorityB = TYPE_CONTENTS_WARMUP_PRIORITY.get(b.id) ?? 1000;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      return a.id.localeCompare(b.id);
    });
  }

  private async warmUpTypeContentsCache(
    roots: TreeNode[],
    generation: number,
    budgetMs: number,
    slicePauseMs = 50,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      const root = roots[rootIndex];
      if (generation !== this.generation) {
        return;
      }
      if (Date.now() >= deadline) {
        this.scheduleWarmupContinuation(roots.slice(rootIndex), generation, budgetMs, slicePauseMs);
        return;
      }
      for (const typeFolder of this.collectWarmupTypeFolders(root)) {
        if (generation !== this.generation) {
          return;
        }
        if (Date.now() >= deadline) {
          this.scheduleWarmupContinuation(roots.slice(rootIndex), generation, budgetMs, slicePauseMs);
          return;
        }
        if (isTypeIndexLoaded(typeFolder)) {
          continue;
        }
        const startedAt = Date.now();
        await this.ports.loadTypeFolderIndex(typeFolder);
        if (generation !== this.generation) {
          return;
        }
        const durationMs = Date.now() - startedAt;
        if (durationMs >= 1000) {
          Logger.info('Type contents cache warmup item completed', { typeName: typeFolder.id, durationMs });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  private scheduleWarmupContinuation(
    roots: TreeNode[],
    generation: number,
    budgetMs: number,
    slicePauseMs: number,
  ): void {
    if (generation !== this.generation) {
      return;
    }
    this.clearScheduledWarmup();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.warmUpTypeContentsCache(roots, generation, budgetMs, slicePauseMs).catch((error) => {
        Logger.warn('Type contents cache warmup continuation failed', error);
      });
    }, slicePauseMs);
  }
}
