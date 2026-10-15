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

    test('validates params: requires non-empty templatePath', async () => {
        const ops = new SkdOperations({ extensionPath: repoRoot });
        const result = await ops.skdValidate({ templatePath: '' });
        assert.strictEqual(result.success, false);
        assert.strictEqual((result as { error: string }).error, 'параметр templatePath обязателен');
    });

    test('passes detailed, maxErrors, and outFile arguments to powershell runner', async () => {
        let capturedArgs: string[] = [];
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async (options) => {
                capturedArgs = [...options.args];
                return {
                    stdout: '=== Validation OK: Template.xml (15 checks; XSD not checked: no schemas) ===\n',
                    stderr: '',
                    exitCode: 0,
                };
            },
        });

        const result = await ops.skdValidate({
            templatePath: '/dummy/Template.xml',
            detailed: true,
            maxErrors: 10,
            outFile: '/dummy/out.json',
        });
        assertValidateResult(result);
        assert.ok(capturedArgs.includes('-Detailed'));
        assert.ok(capturedArgs.includes('-MaxErrors'));
        assert.strictEqual(capturedArgs[capturedArgs.indexOf('-MaxErrors') + 1], '10');
        assert.ok(capturedArgs.includes('-OutFile'));
        assert.strictEqual(capturedArgs[capturedArgs.indexOf('-OutFile') + 1], '/dummy/out.json');
    });

    test('handles process failure when exitCode !== 0 and no validation report in stdout', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: '',
                stderr: 'Template file not found: /nonexistent/Template.xml',
                exitCode: 1,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/nonexistent/Template.xml' });
        assert.strictEqual(result.success, false);
        assert.ok((result as { error: string }).error.includes('Template file not found'));
    });

    test('falls back to exit code message when exitCode !== 0, no report, and empty stdout/stderr', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: '',
                stderr: '',
                exitCode: 2,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assert.strictEqual(result.success, false);
        assert.strictEqual((result as { error: string }).error, 'skd-validate failed with exit code 2');
    });

    test('treats warning in validation report as valid=false', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: [
                    '[OK]  XML parsed successfully',
                    '[WARN]  Expression field1 has potential syntax issue',
                    '=== Result: 0 errors, 1 warnings (15 checks; XSD not checked: no schemas) ===',
                ].join('\n') + '\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assertValidateResult(result);
        assert.strictEqual(result.data.valid, false);
        assert.strictEqual(result.data.warningCount, 1);
        assert.strictEqual(result.data.errorCount, 0);
    });

    test('parses alternative XSD not checked format', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: [
                    'XSD: 2.15 — not checked: missing schema cache',
                    '=== Result: 0 errors, 0 warnings ===',
                ].join('\n') + '\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assertValidateResult(result);
        assert.strictEqual(result.data.coverage, 'partial');
        assert.strictEqual(result.data.xsdChecked, false);
        assert.strictEqual(result.data.xsdReason, 'missing schema cache');
    });

    test('defaults to no schemas when output has no XSD mentions', async () => {
        const ops = new SkdOperations({
            extensionPath: repoRoot,
            runPowerShellScript: async () => ({
                stdout: '=== Result: 0 errors, 0 warnings ===\n',
                stderr: '',
                exitCode: 0,
            }),
        });

        const result = await ops.skdValidate({ templatePath: '/dummy/Template.xml' });
        assertValidateResult(result);
        assert.strictEqual(result.data.coverage, 'partial');
        assert.strictEqual(result.data.xsdChecked, false);
        assert.strictEqual(result.data.xsdReason, 'no schemas');
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
