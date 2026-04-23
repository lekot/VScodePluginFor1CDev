import * as assert from 'assert';
import { parseLockedMetadataObjects } from '../../src/services/ibcmd/ibcmdLockedObjectsParser';

suite('parseLockedMetadataObjects', () => {
  test('single locked object in Russian output', () => {
    const log = '[ERROR] редактирование объекта метаданных CommonModule.АвансовыйОтчетЛокализация запрещено!';
    const result = parseLockedMetadataObjects(log);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.kind, 'CommonModule');
    assert.strictEqual(result[0]!.name, 'АвансовыйОтчетЛокализация');
    assert.strictEqual(result[0]!.fullName, 'CommonModule.АвансовыйОтчетЛокализация');
  });

  test('single locked object in English output', () => {
    const log = 'editing of metadata object Catalog.MyRef is forbidden';
    const result = parseLockedMetadataObjects(log);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.kind, 'Catalog');
    assert.strictEqual(result[0]!.name, 'MyRef');
    assert.strictEqual(result[0]!.fullName, 'Catalog.MyRef');
  });

  test('two different locked objects in one log', () => {
    const log = [
      'редактирование объекта метаданных CommonModule.Foo запрещено',
      'редактирование объекта метаданных Catalog.Bar запрещено',
    ].join('\n');
    const result = parseLockedMetadataObjects(log);
    assert.strictEqual(result.length, 2);
    const fullNames = result.map((r) => r.fullName);
    assert.ok(fullNames.includes('CommonModule.Foo'));
    assert.ok(fullNames.includes('Catalog.Bar'));
  });

  test('duplicate locked objects are deduplicated', () => {
    const log = [
      'редактирование объекта метаданных CommonModule.Foo запрещено',
      'редактирование объекта метаданных CommonModule.Foo запрещено',
    ].join('\n');
    const result = parseLockedMetadataObjects(log);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.fullName, 'CommonModule.Foo');
  });

  test('deduplication is case-insensitive', () => {
    const log = [
      'редактирование объекта метаданных CommonModule.Foo запрещено',
      'редактирование объекта метаданных commonmodule.foo запрещено',
    ].join('\n');
    const result = parseLockedMetadataObjects(log);
    assert.strictEqual(result.length, 1);
  });

  test('empty log returns empty array', () => {
    assert.deepStrictEqual(parseLockedMetadataObjects(''), []);
  });

  test('irrelevant log returns empty array', () => {
    const log = '[INFO] Импорт завершён успешно.';
    assert.deepStrictEqual(parseLockedMetadataObjects(log), []);
  });

  test('fullName without dot: kind is empty, name equals fullName', () => {
    const log = 'редактирование объекта метаданных OrphanObject запрещено';
    const result = parseLockedMetadataObjects(log);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.kind, '');
    assert.strictEqual(result[0]!.name, 'OrphanObject');
    assert.strictEqual(result[0]!.fullName, 'OrphanObject');
  });
});
