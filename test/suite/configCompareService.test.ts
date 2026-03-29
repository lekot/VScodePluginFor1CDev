import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { runCompareInfobaseConfigurations } from '../../src/services/configCompareService';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

function makeEntry(partial: Partial<InfobaseEntry> & Pick<InfobaseEntry, 'id' | 'name' | 'type'>): InfobaseEntry {
  return {
    hasStoredPassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

suite('configCompareService runCompareInfobaseConfigurations (Phase 4 #62)', () => {
  teardown(() => {
    resetVscodeTestState();
  });

  test('null storage shows error and does not run progress', async () => {
    const a = makeEntry({ id: randomUUID(), name: 'A', type: 'file', filePath: '/a' });
    const b = makeEntry({ id: randomUUID(), name: 'B', type: 'file', filePath: '/b' });
    await runCompareInfobaseConfigurations({ storage: null, entryA: a, entryB: b });
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('хранилище не инициализировано')));
    assert.strictEqual(vscodeTestState.informationLog.length, 0);
  });

  test('warning when entryA is web', async () => {
    const storage = {} as InfobaseStorageService;
    const web = makeEntry({ id: randomUUID(), name: 'W', type: 'web', webUrl: 'http://x' });
    const file = makeEntry({ id: randomUUID(), name: 'F', type: 'file', filePath: '/a' });
    await runCompareInfobaseConfigurations({ storage, entryA: web, entryB: file });
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('веб-баз')));
  });

  test('warning when entryB is web', async () => {
    const storage = {} as InfobaseStorageService;
    const file = makeEntry({ id: randomUUID(), name: 'F', type: 'file', filePath: '/a' });
    const web = makeEntry({ id: randomUUID(), name: 'W', type: 'web', webUrl: 'http://x' });
    await runCompareInfobaseConfigurations({ storage, entryA: file, entryB: web });
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('веб-баз')));
  });

  test('warning when both entries share the same id', async () => {
    const storage = {} as InfobaseStorageService;
    const id = randomUUID();
    const a = makeEntry({ id, name: 'A', type: 'file', filePath: '/a' });
    const b = makeEntry({ id, name: 'B', type: 'file', filePath: '/b' });
    await runCompareInfobaseConfigurations({ storage, entryA: a, entryB: b });
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('разные')));
  });
});
