import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';

/**
 * Проверяет, установлен ли chromium для playwright на этой машине.
 * Быстрая проверка (<5мс): спрашивает у playwright API путь к исполняемому chromium,
 * затем проверяет fs.existsSync. Кеш browsers по дефолту — %LOCALAPPDATA%\ms-playwright на Windows.
 */
export async function isChromiumInstalled(_extensionPath: string): Promise<boolean> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pw = require('playwright') as typeof import('playwright');
        const executablePath = pw.chromium.executablePath();
        return fs.existsSync(executablePath);
    } catch {
        return false;
    }
}

/**
 * Устанавливает chromium через `playwright install chromium`. Показывает progress-нотификацию
 * и пишет лог в Output Channel '1C Forms'. Отменяемый через CancellationToken.
 *
 * Под капотом: spawn `process.execPath node_modules/playwright/cli.js install chromium`.
 * Stdin: не нужен. Stdout: пишем в output channel. Stderr: тоже пишем в output channel.
 * На exit 0 → resolve. На exit != 0 или cancel → reject с сообщением.
 */
export async function installChromium(
    extensionPath: string,
    outputChannel: vscode.OutputChannel,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken,
): Promise<void> {
    const cliPath = path.join(extensionPath, 'node_modules', 'playwright', 'cli.js');

    if (!fs.existsSync(cliPath)) {
        throw new Error(`playwright cli.js не найден: ${cliPath}`);
    }

    return new Promise<void>((resolve, reject) => {
        progress?.report({ message: 'Запуск установки Chromium...' });

        const proc = childProcess.spawn(process.execPath, [cliPath, 'install', 'chromium'], {
            cwd: extensionPath,
        });

        const onCancel = token?.onCancellationRequested(() => {
            outputChannel.appendLine('[chromiumInstaller] Установка отменена пользователем.');
            try {
                process.kill(proc.pid!);
            } catch {
                // игнорируем ошибки kill
            }
            reject(new Error('Установка Chromium отменена.'));
        });

        proc.stdout.on('data', (chunk: Buffer) => {
            const lines = chunk.toString('utf8').split(/\r?\n/);
            for (const line of lines) {
                if (line.trim()) {
                    outputChannel.appendLine(line);
                    progress?.report({ message: line.trim() });
                }
            }
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            const lines = chunk.toString('utf8').split(/\r?\n/);
            for (const line of lines) {
                if (line.trim()) {
                    outputChannel.appendLine(`[stderr] ${line}`);
                }
            }
        });

        proc.on('close', (code) => {
            onCancel?.dispose();
            if (code === 0) {
                outputChannel.appendLine('[chromiumInstaller] Chromium успешно установлен.');
                resolve();
            } else {
                const msg = `Установка Chromium завершилась с кодом ${code}.`;
                outputChannel.appendLine(`[chromiumInstaller] ${msg}`);
                reject(new Error(msg));
            }
        });

        proc.on('error', (err) => {
            onCancel?.dispose();
            outputChannel.appendLine(`[chromiumInstaller] Ошибка процесса: ${err.message}`);
            reject(err);
        });
    });
}

/**
 * Помощник: объединяет isChromiumInstalled + installChromium с withProgress-обёрткой.
 * Идемпотентно: если chromium уже есть — быстро возвращается.
 * Использует vscode.window.withProgress({ location: Notification, cancellable: true,
 * title: 'Установка Chromium для 1C Forms (≈150MB)' }).
 */
export async function ensureChromiumInstalled(extensionPath: string): Promise<void> {
    if (await isChromiumInstalled(extensionPath)) {
        return;
    }

    const outputChannel = vscode.window.createOutputChannel('1C Forms');
    outputChannel.show(true);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Установка Chromium для 1C Forms (≈150MB)',
            cancellable: true,
        },
        async (progress, token) => {
            await installChromium(extensionPath, outputChannel, progress, token);
        },
    );
}
