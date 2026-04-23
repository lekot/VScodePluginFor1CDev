/**
 * Smoke-тест: проверяет поле extensionVersion в .vscode/cdt-agent-bridge.json.
 * Если файл отсутствует — тест пропускается (skip).
 * Работает без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('AgentBridge — bridge file extensionVersion', () => {
    test('cdt-agent-bridge.json содержит extensionVersion строкой (если файл существует)', () => {
        // Ищем файл относительно корня репозитория (два уровня вверх от test/suite)
        const bridgeFilePath = path.join(__dirname, '..', '..', '.vscode', 'cdt-agent-bridge.json');

        if (!fs.existsSync(bridgeFilePath)) {
            // Файл отсутствует — VS Code не запущен или bridge не стартовал; пропускаем
            return;
        }

        let parsed: unknown;
        try {
            const raw = fs.readFileSync(bridgeFilePath, 'utf8');
            parsed = JSON.parse(raw);
        } catch (err) {
            assert.fail(`Не удалось прочитать/распарсить ${bridgeFilePath}: ${String(err)}`);
        }

        assert.ok(
            parsed !== null && typeof parsed === 'object',
            'bridge file должен содержать JSON-объект',
        );

        const obj = parsed as Record<string, unknown>;

        assert.ok(
            typeof obj['extensionVersion'] === 'string',
            `extensionVersion должен быть строкой, получено: ${JSON.stringify(obj['extensionVersion'])}`,
        );

        assert.ok(
            obj['extensionVersion'] !== '',
            'extensionVersion не должен быть пустой строкой',
        );
    });
});
