/**
 * Smoke-тесты для agentSkdOperations + powershellRunner.
 * Работают без VS Code runtime (core suite / mocha TDD).
 *
 * Если PowerShell не обнаружен в системе — все тесты пропускаются.
 */

import * as assert from 'assert';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { resolvePowerShellExecutable, _resetPwshCache } from '../../src/services/skd/powershellRunner';
import { SkdOperations } from '../../src/agent/agentSkdOperations';

// Фиктивный extensionPath — скрипты будут не найдены, но это ок для smoke-теста
// который только проверяет структуру ответа при валидации несуществующего файла.
const FAKE_EXTENSION_PATH = path.join(__dirname, '..', '..'); // root of repo — не содержит resources/skd реально

// Реальный extensionPath (если запускается из собранного расширения)
const REAL_EXTENSION_PATH = path.resolve(__dirname, '..', '..', '..', '..', '..');

suite('SkdOperations — smoke', function () {
    this.timeout(15000);

    let pwsh: string | undefined;

    suiteSetup(async () => {
        _resetPwshCache();
        pwsh = await resolvePowerShellExecutable();
    });

    suiteTeardown(() => {
        _resetPwshCache();
    });

    // ─── resolvePowerShellExecutable ─────────────────────────────────────────

    test('resolvePowerShellExecutable — возвращает string или undefined', async () => {
        // Уже вызван в suiteSetup, просто убеждаемся в типе
        assert.ok(pwsh === undefined || typeof pwsh === 'string');
    });

    test('resolvePowerShellExecutable — кеш: второй вызов возвращает тот же результат', async () => {
        const second = await resolvePowerShellExecutable();
        assert.strictEqual(pwsh, second);
    });

    // ─── skdValidate с несуществующим файлом ─────────────────────────────────

    test('skdValidate(non-existent file) — success=false с ошибкой', async function () {
        if (!pwsh) {
            this.skip();
            return;
        }

        // Используем реальный extensionPath если resources/skd существует, иначе fake
        const extensionPath = detectExtensionPath();
        const ops = new SkdOperations({ extensionPath });

        const result = await ops.skdValidate({
            templatePath: '/non/existent/path/Template.xml',
        });

        assert.strictEqual(result.success, false, 'ожидается success=false для несуществующего файла');
        assert.ok(result.error, 'ожидается поле error');
    });

    // ─── skdCompile — валидация params ───────────────────────────────────────

    test('skdCompile без outputPath — success=false с ошибкой валидации', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error — намеренно передаём невалидные params для теста валидации
        const result = await ops.skdCompile({ definitionFile: 'some.json' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('outputPath'));
    });

    test('skdCompile без definitionFile и value — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        const result = await ops.skdCompile({ outputPath: '/tmp/out.xml' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('definitionFile') || result.error?.includes('value'));
    });

    test('skdCompile с обоими definitionFile и value — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        const result = await ops.skdCompile({
            definitionFile: 'a.json',
            value: '{}',
            outputPath: '/tmp/out.xml',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('definitionFile') || result.error?.includes('value') || result.error?.includes('оба'));
    });

    // ─── skdInfo — валидация params ───────────────────────────────────────────

    test('skdInfo без templatePath — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error — намеренно пустые params
        const result = await ops.skdInfo({});
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('templatePath'));
    });

    // ─── skdEdit — валидация params ───────────────────────────────────────────

    test('skdEdit без templatePath — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error
        const result = await ops.skdEdit({ operation: 'add-field', value: '{}' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('templatePath'));
    });

    test('skdEdit без operation — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error
        const result = await ops.skdEdit({ templatePath: '/tmp/t.xml', value: '{}' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('operation'));
    });

    // ─── skdValidate — валидация params ──────────────────────────────────────

    test('skdValidate без templatePath — success=false', async () => {
        const ops = new SkdOperations({ extensionPath: FAKE_EXTENSION_PATH });
        // @ts-expect-error
        const result = await ops.skdValidate({});
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('templatePath'));
    });
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function detectExtensionPath(): string {
    // Проверяем, есть ли реальные PS1-скрипты рядом
    try {
        const fs = require('fs') as typeof import('fs');
        const candidate = path.resolve(__dirname, '..', '..');
        if (fs.existsSync(path.join(candidate, 'resources', 'skd', 'skd-validate.ps1'))) {
            return candidate;
        }
    } catch {
        // ignore
    }
    return FAKE_EXTENSION_PATH;
}
