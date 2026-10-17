import type { BindingManager } from '../bindings/bindingManager';
import { Logger } from '../utils/logger';
import { InfobaseStorageService } from './infobaseStorageService';
import {
  InfobaseCatalogMutationService,
  type PasswordChange,
  type SaveInfobaseOutcome,
  type RemoveInfobaseOutcome,
} from './infobaseCatalogMutationService';
import type { InfobaseEntry } from './models/infobaseEntry';

/**
 * Фасад каталога баз + привязок (WOW design §8.1). Каскад при удалении базы — plan §2A #30, design §14.2.
 * Aggregate root / application coordinator over InfobaseStorageService and BindingManager (#254).
 */
export class InfobaseManager {
  private readonly mutationService: InfobaseCatalogMutationService | null;

  constructor(
    private readonly storage: InfobaseStorageService,
    private readonly bindingManager: BindingManager,
    mutationService?: InfobaseCatalogMutationService,
  ) {
    this.mutationService = mutationService ?? null;
  }

  get catalog(): InfobaseStorageService {
    return this.storage;
  }

  get bindings(): BindingManager {
    return this.bindingManager;
  }

  get mutations(): InfobaseCatalogMutationService | null {
    return this.mutationService;
  }

  /**
   * Logical save of catalog entry + password in a single atomic transaction.
   */
  async saveCatalogEntry(
    entry: InfobaseEntry,
    passwordChange?: PasswordChange,
  ): Promise<SaveInfobaseOutcome> {
    if (this.mutationService) {
      return this.mutationService.saveInfobase({ entry, passwordChange });
    }
    // Fallback if mutationService wasn't provided directly
    await this.storage.upsert(entry);
    if (passwordChange?.kind === 'set' && passwordChange.password) {
      await this.storage.writePasswordSecret(entry.id, passwordChange.password);
    }
    return { success: true, entry };
  }

  /**
   * Удаляет базу из глобального каталога и вычищает её id из всех привязок в workspace.
   */
  async removeCatalogEntry(infobaseId: string): Promise<RemoveInfobaseOutcome | void> {
    if (this.mutationService) {
      return this.mutationService.removeInfobase({ infobaseId });
    }
    // Legacy fallback for simple mock-based tests without full mutation service
    const removedBindings = await this.bindingManager.removeInfobaseFromAllBindings(infobaseId);
    if (removedBindings > 0) {
      Logger.info(`InfobaseManager: removed infobase ${infobaseId} from ${removedBindings} configuration binding(s)`);
    }
    await this.storage.remove(infobaseId);
    return {
      success: true,
      infobaseId,
      removedFromBindingsCount: removedBindings,
    };
  }
}
