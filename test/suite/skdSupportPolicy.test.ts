import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XMLValidator } from 'fast-xml-parser';
import { resolvePowerShellExecutable } from '../../src/services/skd/powershellRunner';
import {
    buildParentConfigurations,
    SUPPORT_UUIDS,
    syntheticSupplier,
} from './supportTestFixtures';

type EditPolicy = 'deny' | 'warn' | 'off';
type ScriptKind = 'skd-edit' | 'skd-compile';
type CwdSource = 'target' | 'neutral' | 'foreign';

interface DatabasePolicy {
    configSrc: string;
    editingAllowedCheck?: EditPolicy;
}

interface ProjectPolicy {
    editingAllowedCheck?: EditPolicy;
    databases?: DatabasePolicy[];
}

interface PowerShellExecutable {
    path: string;
    label: string;
}

interface RuntimeFixtureOptions {
    projectPolicy?: ProjectPolicy;
    projectFileContent?: string;
    omitProjectFile?: boolean;
    configRootRelative?: string;
    cwdPolicy: EditPolicy;
    absoluteDatabaseConfigSrc?: boolean;
    driveRelativeDatabaseConfigSrc?: boolean;
    driveOnlyDatabaseConfigSrc?: boolean;
    rootRelativeDatabaseConfigSrc?: boolean;
}

interface RuntimeFixture {
    root: string;
    cwdBySource: Record<CwdSource, string>;
    targetPath: string;
    definitionPath: string;
}

interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

const protectedObjectUuid = SUPPORT_UUIDS.objectA;
const vendorObjectUuid = SUPPORT_UUIDS.vendorA;
const projectRootName = 'Проект с пробелом';
const templateRelativePath = path.join(
    'Catalogs',
    'Номенклатура',
    'Templates',
    'Обычный макет',
    'Ext',
    'Template.xml',
);
const definitionJson = JSON.stringify({
    dataSets: [{ name: 'Main', query: 'SELECT 1' }],
});
const initialTemplateXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"',
    ' xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings"',
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <dataSet xsi:type="DataSetQuery" uuid="${protectedObjectUuid}">`,
    '    <name>Main</name>',
    '    <dataSource>ИсточникДанных1</dataSource>',
    '    <query>SELECT 1</query>',
    '  </dataSet>',
    '  <settingsVariant>',
    '    <dcsset:name>Default</dcsset:name>',
    '    <dcsset:settings><dcsset:selection /></dcsset:settings>',
    '  </settingsVariant>',
    '</DataCompositionSchema>',
    '',
].join('\n');

let executables: PowerShellExecutable[] = [];
let available = false;

suite('SKD target support policy runtime matrix', function () {
    this.timeout(300000);

    suiteSetup(async function () {
        const pwsh = await resolvePowerShellExecutable();
        if (pwsh) {
            executables.push({ path: pwsh, label: path.basename(pwsh) });
        }

        if (process.platform === 'win32') {
            const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
            const windowsPowerShell = path.join(
                windowsRoot,
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
            );
            try {
                await fs.access(windowsPowerShell);
                if (!executables.some((entry) => path.resolve(entry.path).toLowerCase() === path.resolve(windowsPowerShell).toLowerCase())) {
                    executables.push({ path: windowsPowerShell, label: 'Windows PowerShell 5.1' });
                }
            } catch {
                // Windows PowerShell is optional when PowerShell Core is installed.
            }
        }

        available = executables.length > 0;
        if (!available) {
            console.warn('[PENDING] SKD support policy runtime matrix requires pwsh (or Windows PowerShell on Windows).');
            this.skip();
        }
    });

    test('target policy wins over conflicting process CWD policy for deny, warn, and off', async function () {
        if (!available) { this.skip(); return; }

        const issues: string[] = [];
        await runMatrixCase('same deny target from target, neutral, and foreign CWD', {
            cwdPolicy: 'off',
            projectPolicy: { editingAllowedCheck: 'deny' },
        }, 'deny', issues, ['target', 'neutral', 'foreign']);
        await runMatrixCase('same off target from target, neutral, and foreign CWD', {
            cwdPolicy: 'deny',
            projectPolicy: { editingAllowedCheck: 'off' },
        }, 'off', issues, ['target', 'neutral', 'foreign']);
        await runMatrixCase('target warn reports even when foreign CWD is off', {
            cwdPolicy: 'off',
            projectPolicy: { editingAllowedCheck: 'warn' },
        }, 'warn', issues);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('relative configSrc is resolved from the owning project file', async function () {
        if (!available) { this.skip(); return; }

        const issues: string[] = [];
        await runMatrixCase('project-relative database override', {
            cwdPolicy: 'deny',
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [{ configSrc: './База с пробелом', editingAllowedCheck: 'off' }],
            },
        }, 'off', issues, ['neutral', 'foreign']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('database-specific policy uses the most specific matching root', async function () {
        if (!available) { this.skip(); return; }

        const issues: string[] = [];
        await runMatrixCase('nested database override', {
            cwdPolicy: 'deny',
            configRootRelative: path.join('База с пробелом', 'Вложенная'),
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [
                    { configSrc: './База с пробелом', editingAllowedCheck: 'warn' },
                    { configSrc: './База с пробелом/Вложенная', editingAllowedCheck: 'off' },
                ],
            },
        }, 'off', issues, ['target']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('most-specific database without an override falls back to project policy', async function () {
        if (!available) { this.skip(); return; }

        const issues: string[] = [];
        await runMatrixCase('specific database without policy', {
            cwdPolicy: 'off',
            configRootRelative: path.join('Database', 'Nested'),
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [
                    { configSrc: './Database', editingAllowedCheck: 'off' },
                    { configSrc: './Database/Nested' },
                ],
            },
        }, 'deny', issues, ['target']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('absolute configSrc retains its absolute meaning', async function () {
        if (!available) { this.skip(); return; }

        const issues: string[] = [];
        await runMatrixCase('absolute database override', {
            cwdPolicy: 'deny',
            absoluteDatabaseConfigSrc: true,
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [{ configSrc: './База с пробелом', editingAllowedCheck: 'off' }],
            },
        }, 'off', issues, ['target']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('drive-relative configSrc is rejected instead of resolving from process CWD', async function () {
        if (!available) { this.skip(); return; }
        if (process.platform !== 'win32') {
            console.warn('[PENDING] drive-relative configSrc semantics are specific to Windows paths.');
            this.skip();
            return;
        }

        const issues: string[] = [];
        await runMatrixCase('drive-relative configSrc must deny from every CWD', {
            cwdPolicy: 'off',
            driveRelativeDatabaseConfigSrc: true,
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [{ configSrc: 'База с пробелом', editingAllowedCheck: 'off' }],
            },
        }, 'deny', issues, ['target', 'neutral']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('drive-only configSrc is rejected instead of resolving to the target CWD', async function () {
        if (!available) { this.skip(); return; }
        if (process.platform !== 'win32') {
            console.warn('[PENDING] Drive-only configSrc semantics are specific to Windows paths.');
            this.skip();
            return;
        }

        const issues: string[] = [];
        await runMatrixCase('drive-only configSrc must deny from every CWD', {
            cwdPolicy: 'off',
            configRootRelative: '.',
            driveOnlyDatabaseConfigSrc: true,
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [{ configSrc: '.', editingAllowedCheck: 'off' }],
            },
        }, 'deny', issues, ['target', 'neutral']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('root-relative configSrc is rejected instead of resolving from the current drive', async function () {
        if (!available) { this.skip(); return; }
        if (process.platform !== 'win32') {
            console.warn('[PENDING] Root-relative configSrc semantics are specific to Windows paths.');
            this.skip();
            return;
        }

        const issues: string[] = [];
        await runMatrixCase('root-relative configSrc must deny from every CWD', {
            cwdPolicy: 'off',
            rootRelativeDatabaseConfigSrc: true,
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [{ configSrc: './База с пробелом', editingAllowedCheck: 'off' }],
            },
        }, 'deny', issues, ['target', 'neutral']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('database policy does not match a sibling path with a shared prefix', async function () {
        if (!available) { this.skip(); return; }

        const issues: string[] = [];
        await runMatrixCase('sibling prefix boundary', {
            cwdPolicy: 'off',
            configRootRelative: 'База с пробелом-Сосед',
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [{ configSrc: './База с пробелом', editingAllowedCheck: 'off' }],
            },
        }, 'deny', issues, ['target']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('database path comparison follows host filesystem case rules', async function () {
        if (!available) { this.skip(); return; }

        const caseInsensitiveHost = process.platform === 'win32';
        const issues: string[] = [];
        await runMatrixCase('host-aware case comparison', {
            cwdPolicy: 'off',
            configRootRelative: 'Database',
            projectPolicy: {
                editingAllowedCheck: 'deny',
                databases: [{ configSrc: './database', editingAllowedCheck: 'off' }],
            },
        }, caseInsensitiveHost ? 'off' : 'deny', issues, ['target']);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });

    test('missing and malformed target project files retain default deny', async function () {
        if (!available) { this.skip(); return; }

        const issues: string[] = [];
        await runMatrixCase('missing target project file', {
            cwdPolicy: 'off',
            omitProjectFile: true,
        }, 'deny', issues);
        await runMatrixCase('malformed target project file', {
            cwdPolicy: 'off',
            projectFileContent: '{"editingAllowedCheck":',
        }, 'deny', issues);
        assert.deepStrictEqual(issues, [], issues.join('\n'));
    });
});

async function runMatrixCase(
    caseName: string,
    fixtureOptions: RuntimeFixtureOptions,
    expectedMode: EditPolicy,
    issues: string[],
    cwdSources: readonly CwdSource[] = ['foreign'],
): Promise<void> {
    for (const executable of executables) {
        for (const scriptKind of ['skd-edit', 'skd-compile'] as const) {
            const fixture = await createRuntimeFixture(fixtureOptions);
            try {
                for (const cwdSource of cwdSources) {
                    try {
                        await fs.writeFile(fixture.targetPath, initialTemplateXml, 'utf8');
                        const before = await fs.readFile(fixture.targetPath);
                        const result = await runProductionScript(
                            executable.path,
                            scriptKind,
                            fixture,
                            fixture.cwdBySource[cwdSource],
                        );
                        const diagnostic = `${result.stdout}\n${result.stderr}`;
                        const label = `${caseName} (${executable.label}, ${scriptKind}, ${cwdSource} CWD)`;

                        if (expectedMode === 'deny') {
                            if (result.exitCode !== 1) {
                                issues.push(`${label}: expected exit 1, got ${result.exitCode}. Output: ${compact(diagnostic)}`);
                            }
                            if (!diagnostic.includes('[support-guard]') || !diagnostic.includes('Редактирование отклонено')) {
                                issues.push(`${label}: expected support guard diagnostic. Output: ${compact(diagnostic)}`);
                            }
                            const after = await fs.readFile(fixture.targetPath);
                            if (!after.equals(before)) {
                                issues.push(`${label}: denied operation changed target bytes`);
                            }
                            continue;
                        }

                        if (result.exitCode !== 0) {
                            issues.push(`${label}: expected successful write, got exit ${result.exitCode}. Output: ${compact(diagnostic)}`);
                            continue;
                        }
                        const after = await fs.readFile(fixture.targetPath);
                        if (after.equals(before)) {
                            issues.push(`${label}: successful operation left target bytes unchanged`);
                        }
                        const validation = XMLValidator.validate(after.toString('utf8'));
                        if (validation !== true) {
                            issues.push(`${label}: successful operation did not write well-formed XML: ${JSON.stringify(validation)}`);
                        }
                        const hasGuardDiagnostic = diagnostic.includes('[support-guard]');
                        if (expectedMode === 'warn') {
                            if (!hasGuardDiagnostic || !diagnostic.includes('ПРЕДУПРЕЖДЕНИЕ')) {
                                issues.push(`${label}: expected support guard warning after a successful write. Output: ${compact(diagnostic)}`);
                            }
                        } else if (hasGuardDiagnostic) {
                            issues.push(`${label}: off policy unexpectedly emitted a support guard diagnostic. Output: ${compact(diagnostic)}`);
                        }
                    } catch (error) {
                        issues.push(`${caseName} (${executable.label}, ${scriptKind}, ${cwdSource} CWD): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
                    }
                }
            } catch (error) {
                issues.push(`${caseName} (${executable.label}, ${scriptKind}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            } finally {
                await fs.rm(fixture.root, { recursive: true, force: true });
            }
        }
    }
}

async function createRuntimeFixture(options: RuntimeFixtureOptions): Promise<RuntimeFixture> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skd-policy-239-'));
    const projectRoot = path.join(root, projectRootName);
    const configRoot = path.join(projectRoot, options.configRootRelative ?? 'База с пробелом');
    const targetPath = path.join(configRoot, templateRelativePath);
    const foreignProjectRoot = path.join(root, 'Другой проект с отличающейся политикой');
    const foreignCwd = path.join(foreignProjectRoot, 'Рабочая папка');
    const neutralCwd = path.join(root, 'Нейтральная папка');
    const definitionPath = path.join(root, 'definition.json');

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(foreignCwd, { recursive: true });
    await fs.mkdir(neutralCwd, { recursive: true });
    await fs.writeFile(path.join(configRoot, 'Configuration.xml'),
        `<MetaDataObject><Configuration uuid="${protectedObjectUuid}" /></MetaDataObject>`, 'utf8');
    await fs.mkdir(path.join(configRoot, 'Ext'), { recursive: true });
    await fs.writeFile(path.join(configRoot, 'Ext', 'ParentConfigurations.bin'), buildParentConfigurations({
        suppliers: [syntheticSupplier({
            objects: [{ mode: '0', localUuid: protectedObjectUuid, vendorUuid: vendorObjectUuid }],
        })],
    }));
    await fs.writeFile(targetPath, initialTemplateXml, 'utf8');
    await fs.writeFile(definitionPath, definitionJson, 'utf8');

    if (!options.omitProjectFile) {
        const projectFile = path.join(projectRoot, '.v8-project.json');
        const projectPolicy = options.projectPolicy ?? {};
        const databases = projectPolicy.databases?.map((database) => ({
            ...database,
            configSrc: options.driveRelativeDatabaseConfigSrc
                ? `${path.parse(projectRoot).root.slice(0, 2)}${database.configSrc}`
                : options.driveOnlyDatabaseConfigSrc
                    ? path.parse(projectRoot).root.slice(0, 2)
                    : options.rootRelativeDatabaseConfigSrc
                        ? '\\' + path.relative(path.parse(projectRoot).root, path.resolve(projectRoot, database.configSrc))
                : options.absoluteDatabaseConfigSrc
                    ? path.resolve(projectRoot, database.configSrc)
                    : database.configSrc,
        }));
        const content = options.projectFileContent ?? JSON.stringify(
            databases ? { ...projectPolicy, databases } : projectPolicy,
        );
        await fs.writeFile(projectFile, content, 'utf8');
    }
    await fs.writeFile(path.join(foreignProjectRoot, '.v8-project.json'), JSON.stringify({
        editingAllowedCheck: options.cwdPolicy,
    }), 'utf8');

    return {
        root,
        cwdBySource: { target: projectRoot, neutral: neutralCwd, foreign: foreignCwd },
        targetPath,
        definitionPath,
    };
}

async function runProductionScript(
    executable: string,
    scriptKind: ScriptKind,
    fixture: RuntimeFixture,
    cwd: string,
): Promise<ProcessResult> {
    const scriptPath = path.resolve(__dirname, '..', '..', '..', 'resources', 'skd', `${scriptKind}.ps1`);
    const args = scriptKind === 'skd-edit'
        ? [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
            '-TemplatePath', fixture.targetPath,
            '-Operation', 'set-query',
            '-Value', 'SELECT 2',
            '-DataSet', 'Main',
        ]
        : [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
            '-DefinitionFile', fixture.definitionPath,
            '-OutputPath', fixture.targetPath,
        ];

    return await new Promise<ProcessResult>((resolve, reject) => {
        const child = spawn(executable, args, { cwd, windowsHide: true });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 60000);
        child.stdout.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`PowerShell process timed out after 60 seconds: ${scriptKind}`));
                return;
            }
            resolve({
                exitCode: code ?? -1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            });
        });
    });
}

function compact(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}
