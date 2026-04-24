import * as assert from 'assert';
import type { BindingManager } from '../../src/bindings/bindingManager';
import { InfobaseManager } from '../../src/infobases/infobaseManager';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';

suite('InfobaseManager (WOW 2A cascade delete)', () => {
  test('catalog and bindings getters expose constructor dependencies', () => {
    const bindingManager = {} as BindingManager;
    const storage = {} as InfobaseStorageService;
    const mgr = new InfobaseManager(storage, bindingManager);

    assert.strictEqual(mgr.catalog, storage);
    assert.strictEqual(mgr.bindings, bindingManager);
  });

  test('removeCatalogEntry removes id from bindings before storage', async () => {
    const order: string[] = [];
    const bindingManager = {
      async removeInfobaseFromAllBindings(id: string): Promise<number> {
        order.push(`bindings:${id}`);
        return 2;
      },
    } as unknown as BindingManager;
    const storage = {
      async remove(id: string): Promise<void> {
        order.push(`storage:${id}`);
      },
    } as unknown as InfobaseStorageService;
    const mgr = new InfobaseManager(storage, bindingManager);
    await mgr.removeCatalogEntry('ib-1');
    assert.deepStrictEqual(order, ['bindings:ib-1', 'storage:ib-1']);
  });

  test('removeCatalogEntry still removes from storage when no bindings were updated', async () => {
    const order: string[] = [];
    const bindingManager = {
      async removeInfobaseFromAllBindings(id: string): Promise<number> {
        order.push(`bindings:${id}`);
        return 0;
      },
    } as unknown as BindingManager;
    const storage = {
      async remove(id: string): Promise<void> {
        order.push(`storage:${id}`);
      },
    } as unknown as InfobaseStorageService;
    const mgr = new InfobaseManager(storage, bindingManager);
    await mgr.removeCatalogEntry('ib-2');
    assert.deepStrictEqual(order, ['bindings:ib-2', 'storage:ib-2']);
  });
});
