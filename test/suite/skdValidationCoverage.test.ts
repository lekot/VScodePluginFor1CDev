import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SkdOperations } from '../../src/agent/agentSkdOperations';
import { resolvePowerShellExecutable } from '../../src/services/skd/powershellRunner';

import type { SkdValidateResult } from '../../src/agent/agentSkdTypes';

function assertValidateResult(result: unknown): asserts result is { success: true; data: SkdValidateResult } {
    assert.ok(result && typeof result === 'object' && (result as { success: boolean }).success === true);
    const data = (result as { data?: unknown }).data;
    assert.ok(data && typeof data === 'object' && !('status' in data));
}

suite('SKD validation coverage and XSD contract — #247', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');

    test('parses "no schemas" output as partial coverage with xsdChecked=false and xsdReason', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: '=== Validation OK: Template.xml (15 checks; XSD not checked: no schemas (/v8-xsd-fetch)) ===\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assertValidateResult(result);
        assert.strictEqual(result.data.valid, true);
        assert.strictEqual(result.data.coverage, 'partial');
        assert.strictEqual(result.data.xsdChecked, false);
        assert.strictEqual(result.data.xsdReason, 'no schemas (/v8-xsd-fetch)');
    });

    test('parses "template outside a dump" output as partial coverage with xsdChecked=false', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: '=== Validation OK: Template.xml (15 checks; XSD not checked: template outside a dump) ===\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assertValidateResult(result);
        assert.strictEqual(result.data.valid, true);
        assert.strictEqual(result.data.coverage, 'partial');
        assert.strictEqual(result.data.xsdChecked, false);
        assert.strictEqual(result.data.xsdReason, 'template outside a dump');
    });

    test('parses successful XSD check as full coverage with xsdChecked=true', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: [
                    '[OK]  XML parsed successfully',
                    '[OK]  XSD 2.15: order, types and values OK',
                    '=== Validation OK: Template.xml (16 checks) ===',
                ].join('\n') + '\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assertValidateResult(result);
        assert.strictEqual(result.data.valid, true);
        assert.strictEqual(result.data.coverage, 'full');
        assert.strictEqual(result.data.xsdChecked, true);
        assert.strictEqual(result.data.xsdReason, undefined);
    });

    test('parses XSD error as invalid with errorCount=1 and coverage=full', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: [
                    '[OK]  XML parsed successfully',
                    '[ERROR]  XSD 2.15, line 12: dataSet/query: invalid element order',
                    '=== Result: 1 errors, 0 warnings (16 checks) ===',
                ].join('\n') + '\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assertValidateResult(result);
        assert.strictEqual(result.data.valid, false);
        assert.strictEqual(result.data.errorCount, 1);
        assert.strictEqual(result.data.coverage, 'full');
        assert.strictEqual(result.data.xsdChecked, true);
    });

    test('real PowerShell execution on standalone template returns partial coverage with xsdChecked=false', async function () {
        this.timeout(15000);
        const pwsh = await resolvePowerShellExecutable();
        if (!pwsh) { this.skip(); return; }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-validate-test-'));
        try {
            const templatePath = path.join(tmpDir, 'Template.xml');
            const sampleXml = [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"',
                ' xmlns:dcscom="http://v8.1c.ru/8.1/data-composition-system/common"',
                ' xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core"',
                ' xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings">',
                '  <dataSource>',
                '    <name>DataSource1</name>',
                '    <dataSourceType>Local</dataSourceType>',
                '  </dataSource>',
                '  <dataSet xsi:type="DataSetQuery" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
                '    <name>Main</name>',
                '    <field xsi:type="DataSetFieldField">',
                '      <dataPath>Field1</dataPath>',
                '      <field>Field1</field>',
                '    </field>',
                '    <dataSource>DataSource1</dataSource>',
                '    <query>SELECT 1 AS Field1</query>',
                '  </dataSet>',
                '  <settingsVariant>',
                '    <dcsset:name>Default</dcsset:name>',
                '    <dcsset:settings>',
                '      <dcsset:selection />',
                '    </dcsset:settings>',
                '  </settingsVariant>',
                '</DataCompositionSchema>',
            ].join('\n');
            await fs.writeFile(templatePath, sampleXml, 'utf8');

            const ops = new SkdOperations({ extensionPath: repoRoot });
            const result = await ops.skdValidate({ templatePath });

            assertValidateResult(result);
            assert.strictEqual(result.data.valid, true);
            assert.strictEqual(result.data.coverage, 'partial', 'Validation without project XSD must report partial coverage');
            assert.strictEqual(result.data.xsdChecked, false, 'xsdChecked must be false when no schemas are available');
            assert.ok(result.data.xsdReason, 'xsdReason must specify why XSD was not checked');
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});
