// test/suite/rules/agentPathResolver.test.ts
// Unit-тесты для resolveAgentPath.
import * as assert from 'assert';
import * as path from 'path';
import { resolveAgentPath } from '../../../src/agent/agentPathResolver';

const CONFIG_ROOT = '/fake/config';

suite('agentPathResolver', () => {
    test('Catalog.Товары → rootTag=Catalog, objectName=Товары, filePath contains Catalogs/Товары.xml', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'Catalog.Товары');
        assert.strictEqual(result.rootTag, 'Catalog');
        assert.strictEqual(result.objectName, 'Товары');
        assert.ok(
            result.filePath.includes(path.join('Catalogs', 'Товары.xml')),
            `Expected filePath to contain Catalogs/Товары.xml, got: ${result.filePath}`
        );
        assert.strictEqual(result.nestedType, undefined);
        assert.strictEqual(result.nestedName, undefined);
        assert.strictEqual(result.tabularSection, undefined);
    });

    test('ChartOfAccounts.Хозрасчётный → filePath contains ChartsOfAccounts/', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'ChartOfAccounts.Хозрасчётный');
        assert.ok(
            result.filePath.includes('ChartsOfAccounts'),
            `Expected filePath to contain ChartsOfAccounts, got: ${result.filePath}`
        );
        assert.ok(
            !result.filePath.includes('ChartOfAccountss'),
            `filePath must NOT contain ChartOfAccountss (naive +s), got: ${result.filePath}`
        );
    });

    test('FilterCriterion.Мой → filePath contains FilterCriteria/', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'FilterCriterion.Мой');
        assert.ok(
            result.filePath.includes('FilterCriteria'),
            `Expected filePath to contain FilterCriteria, got: ${result.filePath}`
        );
    });

    test('Catalog.X.Attribute.Y → nestedType=Attribute, nestedName=Y', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'Catalog.X.Attribute.Y');
        assert.strictEqual(result.nestedType, 'Attribute');
        assert.strictEqual(result.nestedName, 'Y');
        assert.strictEqual(result.tabularSection, undefined);
    });

    test('Catalog.X.TabularSection.Y.Attribute.Z → tabularSection=Y, nestedType=Attribute, nestedName=Z', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'Catalog.X.TabularSection.Y.Attribute.Z');
        assert.strictEqual(result.tabularSection, 'Y');
        assert.strictEqual(result.nestedType, 'Attribute');
        assert.strictEqual(result.nestedName, 'Z');
    });

    test('Invalid path with 1 segment → throws', () => {
        assert.throws(() => resolveAgentPath(CONFIG_ROOT, 'Catalog'), /Invalid agent path/);
    });

    test('Invalid path with 3 segments → throws', () => {
        assert.throws(() => resolveAgentPath(CONFIG_ROOT, 'Catalog.X.Attribute'), /Invalid agent path/);
    });
});
