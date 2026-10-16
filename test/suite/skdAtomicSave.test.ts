import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XMLValidator } from 'fast-xml-parser';
import { resolvePowerShellExecutable } from '../../src/services/skd/powershellRunner';

interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

const utf8Bom = Buffer.from([0xEF, 0xBB, 0xBF]);

const sampleTemplateXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"',
    ' xmlns:dcsat="http://v8.1c.ru/8.1/data-composition-system/area-template"',
    ' xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core"',
    ' xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings"',
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '  <dataSet xsi:type="DataSetQuery">',
    '    <name>Main</name>',
    '    <dataSource>DataSource1</dataSource>',
    '    <query>SELECT 1</query>',
    '  </dataSet>',
    '  <template>',
    '    <name>Template1</name>',
    '    <parameter xmlns:dcsat="http://v8.1c.ru/8.1/data-composition-system/area-template" xsi:type="dcsat:ExpressionAreaTemplateParameter">',
    '      <dcsat:name>Param1</dcsat:name>',
    '      <dcsat:expression>Amount</dcsat:expression>',
    '    </parameter>',
    '    <dcsat:tableCell>',
    '      <dcsat:appearance />',
    '      <dcsat:value xsi:type="dcscor:Parameter">Param1</dcsat:value>',
    '    </dcsat:tableCell>',
    '  </template>',
    '  <settingsVariant>',
    '    <dcsset:name>Default</dcsset:name>',
    '    <dcsset:settings><dcsset:selection /></dcsset:settings>',
    '  </settingsVariant>',
    '</DataCompositionSchema>',
    '',
].join('\r\n');

const sampleDefinitionJson = JSON.stringify({
    dataSets: [{ name: 'Main', query: 'SELECT 1 AS Fld1' }],
});

async function runScript(executable: string, scriptPath: string, args: string[], cwd: string): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve) => {
        const fullArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath, ...args];
        const child = spawn(executable, fullArgs, { cwd, windowsHide: true });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const timer = setTimeout(() => {
            child.kill();
        }, 60000);

        child.stdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
        child.once('close', (exitCode) => {
            clearTimeout(timer);
            resolve({
                exitCode: exitCode ?? -1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            });
        });
        child.once('error', (err) => {
            clearTimeout(timer);
            resolve({
                exitCode: -1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: err.message,
            });
        });
    });
}

suite('SKD atomic file save — #240', function () {
    this.timeout(120000);

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const skdEditPath = path.join(repoRoot, 'resources', 'skd', 'skd-edit.ps1');
    const skdCompilePath = path.join(repoRoot, 'resources', 'skd', 'skd-compile.ps1');

    let pwsh: string | undefined;

    suiteSetup(async () => {
        pwsh = await resolvePowerShellExecutable();
    });

    // ─── 1. Contract / Source verification ───────────────────────────────────

    test('skd-edit.ps1 does not use direct non-atomic WriteAllText on target file', async () => {
        const content = await fs.readFile(skdEditPath, 'utf8');
        const matches = content.match(/\[System\.IO\.File\]::WriteAllText\(\s*\$resolvedPath/g);
        assert.strictEqual(
            matches,
            null,
            `skd-edit.ps1 must not use direct [System.IO.File]::WriteAllText($resolvedPath, ...); found: ${matches?.length ?? 0}`,
        );
    });

    test('skd-edit.ps1 defines and uses an atomic file save helper', async () => {
        const content = await fs.readFile(skdEditPath, 'utf8');
        assert.ok(
            content.includes('function Save-FileAtomically') || content.includes('function Save-ContentAtomically'),
            'skd-edit.ps1 must define an atomic file save helper',
        );
        assert.ok(
            content.includes('[System.IO.File]::Replace('),
            'atomic save helper must use [System.IO.File]::Replace for atomic substitution',
        );
    });

    test('skd-compile.ps1 does not use direct non-atomic WriteAllText on target file', async () => {
        const content = await fs.readFile(skdCompilePath, 'utf8');
        const matches = content.match(/\[System\.IO\.File\]::WriteAllText\(\s*\$OutputPath/g);
        assert.strictEqual(
            matches,
            null,
            `skd-compile.ps1 must not use direct [System.IO.File]::WriteAllText($OutputPath, ...); found: ${matches?.length ?? 0}`,
        );
    });

    test('skd-compile.ps1 defines and uses an atomic file save helper', async () => {
        const content = await fs.readFile(skdCompilePath, 'utf8');
        assert.ok(
            content.includes('function Save-FileAtomically') || content.includes('function Save-ContentAtomically'),
            'skd-compile.ps1 must define an atomic file save helper',
        );
        assert.ok(
            content.includes('[System.IO.File]::Replace('),
            'atomic save helper must use [System.IO.File]::Replace for atomic substitution',
        );
    });

    test('skd-edit.ps1 does not use non-atomic File.Copy overwrite fallback in Save-FileAtomically', async () => {
        const content = await fs.readFile(skdEditPath, 'utf8');
        assert.ok(
            !content.includes('[System.IO.File]::Copy($tempPath, $destinationPath'),
            'Save-FileAtomically in skd-edit.ps1 must not fall back to non-atomic File::Copy which can corrupt target file',
        );
    });

    test('skd-compile.ps1 does not use non-atomic File.Copy overwrite fallback in Save-FileAtomically', async () => {
        const content = await fs.readFile(skdCompilePath, 'utf8');
        assert.ok(
            !content.includes('[System.IO.File]::Copy($tempPath, $destinationPath'),
            'Save-FileAtomically in skd-compile.ps1 must not fall back to non-atomic File::Copy which can corrupt target file',
        );
    });

    // ─── 2. Runtime execution tests ──────────────────────────────────────────

    test('runtime: skd-edit performs atomic save, preserves UTF-8 BOM, and cleans up temp files', async function () {
        if (!pwsh) { this.skip(); return; }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-atomic-test-'));
        try {
            const templatePath = path.join(tmpDir, 'Template.xml');
            await fs.writeFile(templatePath, Buffer.concat([utf8Bom, Buffer.from(sampleTemplateXml, 'utf8')]));

            const res = await runScript(pwsh, skdEditPath, [
                '-TemplatePath', templatePath,
                '-Operation', 'set-query',
                '-Value', 'SELECT 2 AS NewField',
                '-DataSet', 'Main',
            ], tmpDir);

            assert.strictEqual(res.exitCode, 0, `Expected exit 0, got ${res.exitCode}: ${res.stdout}\n${res.stderr}`);
            assert.ok(res.stdout.includes('[OK] Saved'), `Expected [OK] Saved in stdout: ${res.stdout}`);

            const savedBytes = await fs.readFile(templatePath);
            assert.ok(savedBytes.subarray(0, 3).equals(utf8Bom), 'Saved file must have UTF-8 BOM');

            const savedText = savedBytes.subarray(3).toString('utf8');
            assert.ok(savedText.includes('SELECT 2 AS NewField'), 'Saved file must contain mutated query');
            const validation = XMLValidator.validate(savedText);
            assert.strictEqual(validation, true, `Saved XML must be well-formed: ${JSON.stringify(validation)}`);

            const dirFiles = await fs.readdir(tmpDir);
            const tempFiles = dirFiles.filter((f) => f.includes('.tmp.') || f.includes('.bak.'));
            assert.deepStrictEqual(tempFiles, [], `Temporary/backup files must be cleaned up: ${tempFiles.join(', ')}`);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runtime: skd-edit add-drilldown performs atomic save, preserves UTF-8 BOM, and cleans up temp files', async function () {
        if (!pwsh) { this.skip(); return; }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-atomic-drilldown-'));
        try {
            const templatePath = path.join(tmpDir, 'Template.xml');
            await fs.writeFile(templatePath, Buffer.concat([utf8Bom, Buffer.from(sampleTemplateXml, 'utf8')]));

            const res = await runScript(pwsh, skdEditPath, [
                '-TemplatePath', templatePath,
                '-Operation', 'add-drilldown',
                '-Value', 'Amount',
            ], tmpDir);

            assert.strictEqual(res.exitCode, 0, `Expected exit 0, got ${res.exitCode}: ${res.stdout}\n${res.stderr}`);
            assert.ok(res.stdout.includes('[OK] Saved'), `Expected [OK] Saved in stdout: ${res.stdout}`);

            const savedBytes = await fs.readFile(templatePath);
            assert.ok(savedBytes.subarray(0, 3).equals(utf8Bom), 'Saved file must have UTF-8 BOM');

            const savedText = savedBytes.subarray(3).toString('utf8');
            assert.ok(savedText.includes('Расшифровка_Amount'), 'Saved file must contain drilldown parameter');

            const dirFiles = await fs.readdir(tmpDir);
            const tempFiles = dirFiles.filter((f) => f.includes('.tmp.') || f.includes('.bak.'));
            assert.deepStrictEqual(tempFiles, [], `Temporary/backup files must be cleaned up: ${tempFiles.join(', ')}`);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runtime: fault before commit leaves target byte-identical and cleans up temp files', async function () {
        if (!pwsh) { this.skip(); return; }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-atomic-fault-'));
        try {
            const templatePath = path.join(tmpDir, 'Template.xml');
            const originalBytes = Buffer.concat([utf8Bom, Buffer.from(sampleTemplateXml, 'utf8')]);
            await fs.writeFile(templatePath, originalBytes);

            // Operation on non-existent dataset triggers failure before save
            const res = await runScript(pwsh, skdEditPath, [
                '-TemplatePath', templatePath,
                '-Operation', 'set-query',
                '-Value', 'SELECT 99',
                '-DataSet', 'NonExistentDataSet',
            ], tmpDir);

            assert.notStrictEqual(res.exitCode, 0, 'Faulty operation must fail');

            const targetBytes = await fs.readFile(templatePath);
            assert.ok(targetBytes.equals(originalBytes), 'Target file must remain byte-identical after failure before commit');

            const dirFiles = await fs.readdir(tmpDir);
            const tempFiles = dirFiles.filter((f) => f.includes('.tmp.') || f.includes('.bak.'));
            assert.deepStrictEqual(tempFiles, [], `No temp files must remain: ${tempFiles.join(', ')}`);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runtime: skd-compile performs atomic write, preserves UTF-8 BOM, and cleans up temp files', async function () {
        if (!pwsh) { this.skip(); return; }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-atomic-compile-'));
        try {
            const defPath = path.join(tmpDir, 'def.json');
            await fs.writeFile(defPath, sampleDefinitionJson, 'utf8');

            const outPath = path.join(tmpDir, 'Template.xml');
            // Write existing file first to verify atomic overwrite
            const existingBytes = Buffer.from('INITIAL CONTENT BEFORE COMPILE', 'utf8');
            await fs.writeFile(outPath, existingBytes);

            const res = await runScript(pwsh, skdCompilePath, [
                '-DefinitionFile', defPath,
                '-OutputPath', outPath,
            ], tmpDir);

            assert.strictEqual(res.exitCode, 0, `Expected exit 0, got ${res.exitCode}: ${res.stdout}\n${res.stderr}`);

            const savedBytes = await fs.readFile(outPath);
            assert.ok(savedBytes.subarray(0, 3).equals(utf8Bom), 'Compiled file must have UTF-8 BOM');

            const savedText = savedBytes.subarray(3).toString('utf8');
            assert.ok(savedText.includes('SELECT 1 AS Fld1'), 'Compiled file must contain dataset query');
            const validation = XMLValidator.validate(savedText);
            assert.strictEqual(validation, true, `Compiled XML must be well-formed: ${JSON.stringify(validation)}`);

            const dirFiles = await fs.readdir(tmpDir);
            const tempFiles = dirFiles.filter((f) => f.includes('.tmp.') || f.includes('.bak.'));
            assert.deepStrictEqual(tempFiles, [], `No temp files must remain: ${tempFiles.join(', ')}`);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runtime: writer failure during atomic save leaves target file untouched and cleans up temp files', async function () {
        if (!pwsh) { this.skip(); return; }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-atomic-writer-fail-'));
        try {
            const destPath = path.join(tmpDir, 'Template.xml');
            const originalContent = '<OriginalXml>12345</OriginalXml>';
            await fs.writeFile(destPath, originalContent, 'utf8');

            const editContent = await fs.readFile(skdEditPath, 'utf8');
            const fnMatch = editContent.match(/function Save-FileAtomically[\s\S]*?\n\}/);
            assert.ok(fnMatch, 'Save-FileAtomically function must be present');

            // Inject fault in Save-FileAtomically by simulating [System.IO.File]::Replace throwing PlatformNotSupportedException
            const faultScriptPath = path.join(tmpDir, 'test-fault-injection.ps1');
            const faultScript = [
                '$ErrorActionPreference = "Stop"',
                fnMatch[0].replace(
                    '[System.IO.File]::Replace($tempPath, $destinationPath, $backupPath)',
                    'throw [System.PlatformNotSupportedException]::new("Simulated Replace failure")'
                ),
                'try {',
                `    Save-FileAtomically "${destPath.replace(/\\/g, '/')}" "<PartialContent>" ([System.Text.Encoding]::UTF8)`,
                '} catch {',
                '    [Console]::Error.WriteLine("Safely caught: " + $_.Exception.Message)',
                '}',
            ].join('\r\n');
            await fs.writeFile(faultScriptPath, faultScript, 'utf8');

            const faultRes = await runScript(pwsh, faultScriptPath, [], tmpDir);
            assert.ok(
                faultRes.stderr.includes('Safely caught') || faultRes.stdout.includes('Safely caught'),
                `Expected error to be caught: ${faultRes.stdout} ${faultRes.stderr}`,
            );

            // Target must remain EXACTLY originalContent, NOT <PartialContent>
            const actualContent = await fs.readFile(destPath, 'utf8');
            assert.strictEqual(actualContent, originalContent, 'Target file MUST remain untouched when Replace fails');

            const dirFiles = await fs.readdir(tmpDir);
            const tempFiles = dirFiles.filter((f) => f.includes('.tmp.') || f.includes('.bak.'));
            assert.deepStrictEqual(tempFiles, [], `Temporary/backup files must be cleaned up: ${tempFiles.join(', ')}`);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    test('runtime: writer failure after destination moved to backup restores original file from backup', async function () {
        if (!pwsh) { this.skip(); return; }

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-atomic-backup-restore-'));
        try {
            const destPath = path.join(tmpDir, 'Template.xml');
            const originalContent = '<OriginalXml>PRESERVED_RESTORED</OriginalXml>';
            await fs.writeFile(destPath, originalContent, 'utf8');

            const editContent = await fs.readFile(skdEditPath, 'utf8');
            const fnMatch = editContent.match(/function Save-FileAtomically[\s\S]*?\n\}/);
            assert.ok(fnMatch, 'Save-FileAtomically function must be present');

            // Simulate scenario where destination was moved to backup by Replace, but an error occurs before completion
            const faultScriptPath = path.join(tmpDir, 'test-restore-backup.ps1');
            const faultScript = [
                '$ErrorActionPreference = "Stop"',
                fnMatch[0].replace(
                    '[System.IO.File]::Replace($tempPath, $destinationPath, $backupPath)',
                    '[System.IO.File]::Move($destinationPath, $backupPath); throw [System.IO.IOException]::new("Simulated crash after backup created")'
                ),
                'try {',
                `    Save-FileAtomically "${destPath.replace(/\\/g, '/')}" "<ShouldNotBeCommitted>" ([System.Text.Encoding]::UTF8)`,
                '} catch {',
                '    [Console]::Error.WriteLine("Caught crash: " + $_.Exception.Message)',
                '}',
            ].join('\r\n');
            await fs.writeFile(faultScriptPath, faultScript, 'utf8');

            const faultRes = await runScript(pwsh, faultScriptPath, [], tmpDir);
            assert.ok(
                faultRes.stderr.includes('Caught crash') || faultRes.stdout.includes('Caught crash'),
                `Expected crash to be caught: ${faultRes.stdout} ${faultRes.stderr}`,
            );

            // Target must be restored from backup!
            const restoredContent = await fs.readFile(destPath, 'utf8');
            assert.strictEqual(restoredContent, originalContent, 'Target file MUST be restored from backup if destination disappeared');

            const dirFiles = await fs.readdir(tmpDir);
            const tempFiles = dirFiles.filter((f) => f.includes('.tmp.') || f.includes('.bak.'));
            assert.deepStrictEqual(tempFiles, [], `Temporary/backup files must be cleaned up after restore: ${tempFiles.join(', ')}`);
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });
});
