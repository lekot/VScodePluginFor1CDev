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
        assert.deepStrictEqual(result.nestedPath, [
            { type: 'Catalog', name: 'X' },
            { type: 'TabularSection', name: 'Y' },
            { type: 'Attribute', name: 'Z' },
        ]);
    });

    test('HTTPService.X.URLTemplate.Y.Method.Z builds a full selector without a tabular scope', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'HTTPService.X.URLTemplate.Y.Method.Z');
        assert.strictEqual(result.tabularSection, undefined);
        assert.deepStrictEqual(result.nestedPath, [
            { type: 'HTTPService', name: 'X' },
            { type: 'URLTemplate', name: 'Y' },
            { type: 'Method', name: 'Z' },
        ]);
    });

    test('ExternalDataSource table path resolves to its Designer table file and retains the public selector', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'ExternalDataSource.Source.Table.Tasks') as ReturnType<typeof resolveAgentPath> & {
            fileRootType?: string;
            fileNestedPath?: Array<{ type: string; name: string }>;
        };
        assert.ok(result.filePath.includes(path.join('ExternalDataSources', 'Source', 'Tables', 'Tasks.xml')));
        assert.strictEqual(result.fileRootType, 'Table');
        assert.deepStrictEqual(result.nestedPath, [
            { type: 'ExternalDataSource', name: 'Source' },
            { type: 'Table', name: 'Tasks' },
        ]);
        assert.deepStrictEqual(result.fileNestedPath, [{ type: 'Table', name: 'Tasks' }]);
    });

    test('ExternalDataSource field selector is file-relative while public path remains complete', () => {
        const result = resolveAgentPath(CONFIG_ROOT, 'ExternalDataSource.Source.Table.Tasks.Field.Code') as ReturnType<typeof resolveAgentPath> & {
            fileRootType?: string;
            fileNestedPath?: Array<{ type: string; name: string }>;
        };
        assert.ok(result.filePath.includes(path.join('ExternalDataSources', 'Source', 'Tables', 'Tasks.xml')));
        assert.strictEqual(result.fileRootType, 'Table');
        assert.deepStrictEqual(result.nestedPath, [
            { type: 'ExternalDataSource', name: 'Source' },
            { type: 'Table', name: 'Tasks' },
            { type: 'Field', name: 'Code' },
        ]);
        assert.deepStrictEqual(result.fileNestedPath, [
            { type: 'Table', name: 'Tasks' },
            { type: 'Field', name: 'Code' },
        ]);
    });

    test('Invalid path with 1 segment → throws', () => {
        assert.throws(() => resolveAgentPath(CONFIG_ROOT, 'Catalog'), /Invalid agent path/);
    });

    test('Invalid path with 3 segments → throws', () => {
        assert.throws(() => resolveAgentPath(CONFIG_ROOT, 'Catalog.X.Attribute'), /Invalid agent path/);
    });
});
