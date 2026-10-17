// src/infobases/infobaseCatalogMutationService.ts
// Application-level Infobase Catalog Mutation Service (Architecture Roadmap #267, Issue #254).
// Manages aggregate consistency across InfobaseStorageService (globalState),
// SecretStorage, and BindingManager (.vscode/infobase-bindings.json).

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { InfobaseEntry } from './models/infobaseEntry';
import type { ConfigurationBinding } from '../bindings/models/configurationBinding';
import { InfobaseStorageService } from './infobaseStorageService';
import { BindingManager } from '../bindings/bindingManager';
import { infobasePasswordSecretKey } from './constants';
import { validateInfobaseEntry } from './infobaseValidator';
import {
  readBindingsForFolderDiagnostic,
  writeBindingsForFolder,
} from '../bindings/bindingStorage';
import { Logger } from '../utils/logger';

export const INFOBASE_MUTATION_JOURNAL_KEY = '1cMetadataTree.infobaseMutationJournal';

// ─── Types & Contracts ────────────────────────────────────────────────────────

export interface PasswordChange {
  readonly kind: 'set' | 'clear' | 'keep';
  readonly password?: string;
}

export interface SaveInfobaseParams {
  readonly entry: InfobaseEntry;
  readonly passwordChange?: PasswordChange;
}

export type SaveInfobaseErrorCode =
  | 'VALIDATION_FAILED'
  | 'SECRET_STORAGE_FAILED'
  | 'GLOBAL_STATE_FAILED'
  | 'CONCURRENCY_CONFLICT';

export type SaveInfobaseOutcome =
  | { readonly success: true; readonly entry: InfobaseEntry }
  | {
      readonly success: false;
      readonly code: SaveInfobaseErrorCode;
      readonly message: string;
      readonly rolledBack: boolean;
      readonly recoveryRequired?: boolean;
    };

export interface RemoveInfobaseParams {
  readonly infobaseId: string;
  readonly removeBindings?: boolean;
}

export type RemoveInfobaseErrorCode =
  | 'NOT_FOUND'
  | 'BINDINGS_CORRUPTED'
  | 'BINDINGS_WRITE_FAILED'
  | 'GLOBAL_STATE_FAILED'
  | 'SECRET_STORAGE_FAILED';

export type RemoveInfobaseOutcome =
  | {
      readonly success: true;
      readonly infobaseId: string;
      readonly removedFromBindingsCount: number;
    }
  | {
      readonly success: false;
      readonly code: RemoveInfobaseErrorCode;
      readonly message: string;
      readonly rolledBack: boolean;
      readonly recoveryRequired?: boolean;
      readonly affectedBindingsFiles?: readonly string[];
    };

export interface RecoveryOutcome {
  readonly recoveredCount: number;
  readonly errors: readonly string[];
}

export type MutationPhase = 'intent' | 'secrets_mutated' | 'bindings_mutated';

export interface ModifiedBindingFolderCompensation {
  readonly folderFsPath: string;
  readonly folderName: string;
  readonly originalBindings: ConfigurationBinding[];
}

export interface PendingJournalRecord {
  readonly operationId: string;
  readonly type: 'save' | 'remove';
  readonly infobaseId: string;
  readonly timestamp: number;
  readonly phase?: MutationPhase;
  readonly hadPasswordBefore: boolean;
  readonly passwordChangeKind?: 'set' | 'clear' | 'keep';
  readonly targetEntry?: InfobaseEntry;
  readonly targetFolderPaths?: readonly string[];
  readonly modifiedBindings?: readonly ModifiedBindingFolderCompensation[];
}

export interface InfobaseCatalogMutationServiceDeps {
  readonly storage: InfobaseStorageService;
  readonly secretStorage: vscode.SecretStorage;
  readonly bindingManager: BindingManager;
  readonly memento?: vscode.Memento;
  readonly fileSystem?: vscode.FileSystem;
  readonly getWorkspaceFolders?: () => readonly vscode.WorkspaceFolder[] | undefined;
}

// ─── Service Implementation ──────────────────────────────────────────────────

export class InfobaseCatalogMutationService {
  private readonly fsApi: vscode.FileSystem;
  private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: InfobaseCatalogMutationServiceDeps) {
    this.fsApi = deps.fileSystem ?? vscode.workspace.fs;
    this.getWorkspaceFolders = deps.getWorkspaceFolders ?? (() => vscode.workspace.workspaceFolders);
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async recordJournal(record: PendingJournalRecord): Promise<void> {
    if (this.deps.memento) {
      await this.deps.memento.update(INFOBASE_MUTATION_JOURNAL_KEY, record);
    }
  }

  private async clearJournal(): Promise<void> {
    if (this.deps.memento) {
      try {
        await this.deps.memento.update(INFOBASE_MUTATION_JOURNAL_KEY, undefined);
      } catch (err) {
        Logger.warn('InfobaseCatalogMutationService: failed to clear pending journal record', err);
      }
    }
  }

  private readJournal(): PendingJournalRecord | undefined {
    if (!this.deps.memento) {
      return undefined;
    }
    return this.deps.memento.get<PendingJournalRecord>(INFOBASE_MUTATION_JOURNAL_KEY);
  }

  // ─── Save Infobase ─────────────────────────────────────────────────────────

  async saveInfobase(params: SaveInfobaseParams): Promise<SaveInfobaseOutcome> {
    return this.runExclusive(async () => {
      const { entry, passwordChange } = params;

      // 1. Validation
      try {
        validateInfobaseEntry(entry);
      } catch (err) {
        return {
          success: false,
          code: 'VALIDATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          rolledBack: true,
        };
      }

      // 2. Validate password consistency
      if (entry.hasStoredPassword && passwordChange?.kind === 'clear') {
        return {
          success: false,
          code: 'VALIDATION_FAILED',
          message: 'Contradiction: entry.hasStoredPassword=true but passwordChange.kind=clear',
          rolledBack: true,
        };
      }

      if (!entry.hasStoredPassword && passwordChange?.kind === 'set') {
        return {
          success: false,
          code: 'VALIDATION_FAILED',
          message: 'Contradiction: entry.hasStoredPassword=false but passwordChange.kind=set',
          rolledBack: true,
        };
      }

      if (passwordChange?.kind === 'set' && (!passwordChange.password || typeof passwordChange.password !== 'string')) {
        return {
          success: false,
          code: 'VALIDATION_FAILED',
          message: 'Password string is required when passwordChange.kind is "set"',
          rolledBack: true,
        };
      }

      const existing = await this.deps.storage.getById(entry.id);
      if (!existing && entry.hasStoredPassword && passwordChange?.kind === 'keep') {
        return {
          success: false,
          code: 'VALIDATION_FAILED',
          message: 'Cannot keep password for a newly created infobase',
          rolledBack: true,
        };
      }

      // 3. Capture pre-state
      const secretKey = infobasePasswordSecretKey(entry.id);
      const existingPassword = existing?.hasStoredPassword
        ? await this.deps.storage.readPasswordSecret(entry.id)
        : undefined;

      // 4. Record intent in journal
      const operationId = randomUUID();
      try {
        await this.recordJournal({
          operationId,
          type: 'save',
          phase: 'intent',
          infobaseId: entry.id,
          timestamp: Date.now(),
          hadPasswordBefore: !!existingPassword,
          passwordChangeKind: passwordChange?.kind,
          targetEntry: entry,
        });
      } catch (err) {
        return {
          success: false,
          code: 'GLOBAL_STATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          rolledBack: true,
        };
      }

      // 5. Apply SecretStorage mutation
      if (passwordChange?.kind === 'set') {
        try {
          await this.deps.secretStorage.store(secretKey, passwordChange.password!);
        } catch (err) {
          await this.clearJournal();
          return {
            success: false,
            code: 'SECRET_STORAGE_FAILED',
            message: err instanceof Error ? err.message : String(err),
            rolledBack: true,
          };
        }
        try {
          await this.recordJournal({
            operationId,
            type: 'save',
            phase: 'secrets_mutated',
            infobaseId: entry.id,
            timestamp: Date.now(),
            hadPasswordBefore: !!existingPassword,
            passwordChangeKind: 'set',
            targetEntry: entry,
          });
        } catch (err) {
          if (existingPassword !== undefined) {
            try {
              await this.deps.secretStorage.store(secretKey, existingPassword);
            } catch (rbErr) {
              Logger.error('InfobaseCatalogMutationService: rollback failed after journal failure', rbErr);
            }
          } else {
            try {
              await this.deps.secretStorage.delete(secretKey);
            } catch (rbErr) {
              Logger.error('InfobaseCatalogMutationService: rollback failed after journal failure', rbErr);
            }
          }
          await this.clearJournal();
          return {
            success: false,
            code: 'GLOBAL_STATE_FAILED',
            message: err instanceof Error ? err.message : String(err),
            rolledBack: true,
          };
        }
      } else if (passwordChange?.kind === 'clear' || !entry.hasStoredPassword) {
        try {
          await this.deps.secretStorage.delete(secretKey);
        } catch (err) {
          await this.clearJournal();
          return {
            success: false,
            code: 'SECRET_STORAGE_FAILED',
            message: err instanceof Error ? err.message : String(err),
            rolledBack: true,
          };
        }
        try {
          await this.recordJournal({
            operationId,
            type: 'save',
            phase: 'secrets_mutated',
            infobaseId: entry.id,
            timestamp: Date.now(),
            hadPasswordBefore: !!existingPassword,
            passwordChangeKind: passwordChange?.kind ?? 'clear',
            targetEntry: entry,
          });
        } catch (err) {
          if (existingPassword !== undefined) {
            try {
              await this.deps.secretStorage.store(secretKey, existingPassword);
            } catch (rbErr) {
              Logger.error('InfobaseCatalogMutationService: rollback failed after journal failure', rbErr);
            }
          }
          await this.clearJournal();
          return {
            success: false,
            code: 'GLOBAL_STATE_FAILED',
            message: err instanceof Error ? err.message : String(err),
            rolledBack: true,
          };
        }
      }

      // 6. Apply catalog mutation
      try {
        await this.deps.storage.upsert(entry);
      } catch (err) {
        // Rollback SecretStorage
        let rolledBack = false;
        try {
          if (existingPassword !== undefined) {
            await this.deps.secretStorage.store(secretKey, existingPassword);
          } else {
            await this.deps.secretStorage.delete(secretKey);
          }
          rolledBack = true;
          await this.clearJournal();
        } catch (rollbackErr) {
          Logger.error('InfobaseCatalogMutationService: rollback failed after globalState update failure', rollbackErr);
          rolledBack = false;
        }

        return {
          success: false,
          code: 'GLOBAL_STATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          rolledBack,
          recoveryRequired: !rolledBack,
        };
      }

      // 7. Success
      await this.clearJournal();
      return { success: true, entry };
    });
  }

  // ─── Remove Infobase ───────────────────────────────────────────────────────

  async removeInfobase(params: RemoveInfobaseParams): Promise<RemoveInfobaseOutcome> {
    return this.runExclusive(async () => {
      const id = params.infobaseId.trim();
      const existing = await this.deps.storage.getById(id);
      if (!existing) {
        return {
          success: false,
          code: 'NOT_FOUND',
          message: `Infobase '${id}' not found in catalog`,
          rolledBack: true,
        };
      }

      const hadPassword = existing.hasStoredPassword;
      const secretKey = infobasePasswordSecretKey(id);
      const existingPassword = hadPassword ? await this.deps.storage.readPasswordSecret(id) : undefined;
      const removeBindings = params.removeBindings !== false;
      const folders = this.getWorkspaceFolders() ?? [];

      // 1. Preflight validation of bindings files (Fault prevention)
      const targetFolderPaths: string[] = [];
      if (removeBindings) {
        for (const folder of folders) {
          const diag = await readBindingsForFolderDiagnostic(this.fsApi, folder);
          if (diag.kind === 'invalid') {
            return {
              success: false,
              code: 'BINDINGS_CORRUPTED',
              message: `Cannot delete infobase because bindings file is corrupted: ${diag.uri.fsPath}`,
              rolledBack: true,
              affectedBindingsFiles: [diag.uri.fsPath],
            };
          }
          if (diag.kind === 'valid' && diag.bindings.some((b) => b.infobaseIds.includes(id))) {
            targetFolderPaths.push(folder.uri.fsPath);
          }
        }
      }

      // 2. Record intent
      const operationId = randomUUID();
      try {
        await this.recordJournal({
          operationId,
          type: 'remove',
          phase: 'intent',
          infobaseId: id,
          timestamp: Date.now(),
          hadPasswordBefore: hadPassword,
          targetEntry: existing,
          targetFolderPaths,
        });
      } catch (err) {
        return {
          success: false,
          code: 'GLOBAL_STATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          rolledBack: true,
        };
      }

      // 3. Mutate bindings with snapshot tracking for rollback
      const modifiedFolders: Array<{ folder: vscode.WorkspaceFolder; originalBindings: ConfigurationBinding[] }> = [];
      let removedFromBindingsCount = 0;

      if (removeBindings) {
        for (const folder of folders) {
          const diag = await readBindingsForFolderDiagnostic(this.fsApi, folder);
          if (diag.kind !== 'valid') {
            continue;
          }

          const originalBindings = [...diag.bindings];
          const nextBindings: ConfigurationBinding[] = [];
          let folderChanged = false;

          for (const b of originalBindings) {
            const ids = b.infobaseIds.filter((x) => x !== id);
            if (ids.length !== b.infobaseIds.length) {
              removedFromBindingsCount += 1;
              folderChanged = true;
            }
            nextBindings.push({ ...b, infobaseIds: ids });
          }

          if (folderChanged) {
            try {
              await writeBindingsForFolder(this.fsApi, folder, nextBindings);
              modifiedFolders.push({ folder, originalBindings });
            } catch (err) {
              // Rollback all previously modified bindings
              let rolledBack = true;
              for (const item of modifiedFolders) {
                try {
                  await writeBindingsForFolder(this.fsApi, item.folder, item.originalBindings);
                } catch (rbErr) {
                  Logger.error('InfobaseCatalogMutationService: rollback failed for folder', rbErr);
                  rolledBack = false;
                }
              }

              await this.clearJournal();
              return {
                success: false,
                code: 'BINDINGS_WRITE_FAILED',
                message: err instanceof Error ? err.message : String(err),
                rolledBack,
                recoveryRequired: !rolledBack,
              };
            }

            try {
              await this.recordJournal({
                operationId,
                type: 'remove',
                phase: 'bindings_mutated',
                infobaseId: id,
                timestamp: Date.now(),
                hadPasswordBefore: hadPassword,
                targetEntry: existing,
                targetFolderPaths,
                modifiedBindings: modifiedFolders.map((mf) => ({
                  folderFsPath: mf.folder.uri.fsPath,
                  folderName: mf.folder.name,
                  originalBindings: mf.originalBindings,
                })),
              });
            } catch (err) {
              // Rollback all modified bindings including current folder
              let rolledBack = true;
              for (const item of modifiedFolders) {
                try {
                  await writeBindingsForFolder(this.fsApi, item.folder, item.originalBindings);
                } catch (rbErr) {
                  Logger.error(
                    'InfobaseCatalogMutationService: rollback failed for folder after journal failure',
                    rbErr,
                  );
                  rolledBack = false;
                }
              }

              await this.clearJournal();
              return {
                success: false,
                code: 'GLOBAL_STATE_FAILED',
                message: err instanceof Error ? err.message : String(err),
                rolledBack,
                recoveryRequired: !rolledBack,
              };
            }
          }
        }
      }

      // 4. Remove from catalog
      try {
        await this.deps.storage.remove(id);
      } catch (err) {
        // Rollback secret if storage.remove deleted it before failing
        if (existingPassword !== undefined) {
          try {
            await this.deps.secretStorage.store(secretKey, existingPassword);
          } catch (secErr) {
            Logger.error('InfobaseCatalogMutationService: failed to restore secret after remove failure', secErr);
          }
        }

        // Rollback bindings
        let rolledBack = true;
        for (const item of modifiedFolders) {
          try {
            await writeBindingsForFolder(this.fsApi, item.folder, item.originalBindings);
          } catch (rbErr) {
            Logger.error('InfobaseCatalogMutationService: rollback bindings failed', rbErr);
            rolledBack = false;
          }
        }

        return {
          success: false,
          code: 'GLOBAL_STATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          rolledBack,
          recoveryRequired: !rolledBack,
        };
      }

      // 5. Ensure secret is deleted
      try {
        await this.deps.secretStorage.delete(infobasePasswordSecretKey(id));
      } catch (err) {
        Logger.warn(`InfobaseCatalogMutationService: secret cleanup failed for ${id}`, err);
      }

      // 6. Success
      await this.clearJournal();
      return {
        success: true,
        infobaseId: id,
        removedFromBindingsCount,
      };
    });
  }

  // ─── Crash Recovery ────────────────────────────────────────────────────────

  async recoverPendingMutations(): Promise<RecoveryOutcome> {
    return this.runExclusive(async () => {
      const record = this.readJournal();
      if (!record) {
        return { recoveredCount: 0, errors: [] };
      }

      let recovered = 0;
      const errors: string[] = [];

      try {
        const secretKey = infobasePasswordSecretKey(record.infobaseId);
        const existing = await this.deps.storage.getById(record.infobaseId);

        if (record.type === 'save') {
          const isClearIntent =
            record.passwordChangeKind === 'clear' ||
            (record.targetEntry && !record.targetEntry.hasStoredPassword);

          if (isClearIntent) {
            await this.deps.secretStorage.delete(secretKey);
            if (existing && existing.hasStoredPassword) {
              const target = record.targetEntry ?? { ...existing, hasStoredPassword: false };
              await this.deps.storage.upsert(target);
            }
            recovered++;
          } else if (record.passwordChangeKind === 'set') {
            if (record.phase === 'secrets_mutated') {
              if (existing && !existing.hasStoredPassword && record.targetEntry) {
                await this.deps.storage.upsert(record.targetEntry);
              } else if (!existing) {
                await this.deps.secretStorage.delete(secretKey);
              }
            } else {
              // phase === 'intent'
              if (!existing) {
                await this.deps.secretStorage.delete(secretKey);
              }
            }
            recovered++;
          } else {
            // 'keep' or unspecified
            if (!existing) {
              await this.deps.secretStorage.delete(secretKey);
            }
            recovered++;
          }
        } else if (record.type === 'remove') {
          const folders = this.getWorkspaceFolders() ?? [];

          // 1. Preflight: if any folder has invalid/corrupted bindings, fail closed
          for (const folder of folders) {
            const diag = await readBindingsForFolderDiagnostic(this.fsApi, folder);
            if (diag.kind === 'invalid') {
              throw new Error(`Cannot recover remove operation: bindings file corrupted at ${diag.uri.fsPath}`);
            }
          }

          // 2. Cascade bindings removal across ALL workspace folders idempotently
          for (const folder of folders) {
            const diag = await readBindingsForFolderDiagnostic(this.fsApi, folder);
            if (diag.kind === 'valid') {
              let changed = false;
              const nextBindings = diag.bindings.map((b) => {
                const filtered = b.infobaseIds.filter((x) => x !== record.infobaseId);
                if (filtered.length !== b.infobaseIds.length) {
                  changed = true;
                }
                return { ...b, infobaseIds: filtered };
              });
              if (changed) {
                await writeBindingsForFolder(this.fsApi, folder, nextBindings);
              }
            }
          }

          // 3. Remove from catalog
          if (existing) {
            await this.deps.storage.remove(record.infobaseId);
          }

          // 4. Delete secret
          await this.deps.secretStorage.delete(secretKey);
          recovered++;
        }

        await this.clearJournal();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      return { recoveredCount: recovered, errors };
    });
  }
}
