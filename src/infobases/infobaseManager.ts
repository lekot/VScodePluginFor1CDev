import type { BindingManager } from '../bindings/bindingManager';
import { Logger } from '../utils/logger';
import { InfobaseStorageService } from './infobaseStorageService';

/**
 * Фасад каталога баз + привязок (WOW design §8.1). Каскад при удалении базы — plan §2A #30, design §14.2.
 */
export class InfobaseManager {
  constructor(
    private readonly storage: InfobaseStorageService,
    private readonly bindingManager: BindingManager,
  ) {}

  get catalog(): InfobaseStorageService {
    return this.storage;
  }

  get bindings(): BindingManager {
    return this.bindingManager;
  }

  /**
   * Удаляет базу из глобального каталога и вычищает её id из всех привязок в workspace.
   */
  async removeCatalogEntry(infobaseId: string): Promise<void> {
    const removedBindings = await this.bindingManager.removeInfobaseFromAllBindings(infobaseId);
    if (removedBindings > 0) {
      Logger.info(`InfobaseManager: removed infobase ${infobaseId} from ${removedBindings} configuration binding(s)`);
    }
    await this.storage.remove(infobaseId);
  }
}
