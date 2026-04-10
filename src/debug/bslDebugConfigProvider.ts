import * as vscode from 'vscode';
import { BslAttachConfiguration } from './types';
import { Logger } from '../utils/logger';

/**
 * Resolve `${workspaceFolder:Name}` variable in a path string.
 * If the named folder is not found, returns the original string with a warning logged.
 */
function resolveWorkspaceFolderVar(value: string): string {
    return value.replace(/\$\{workspaceFolder:([^}]+)\}/g, (_match, folderName: string) => {
        const found = vscode.workspace.workspaceFolders?.find((f) => f.name === folderName);
        if (found) {
            return found.uri.fsPath;
        }
        console.warn(`BslDebugConfigProvider: workspace folder "${folderName}" not found`);
        return value;
    });
}

export class BslDebugConfigProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        Logger.info('BslDebugConfigProvider.resolveDebugConfiguration entry', {
            folder: _folder?.uri.fsPath ?? '<undefined>',
            configKeys: Object.keys(config ?? {}),
            type: config?.type,
            request: (config as Record<string, unknown>)?.request,
            name: (config as Record<string, unknown>)?.name,
        });
        const cfg = config as BslAttachConfiguration;

        // Apply defaults
        if (!cfg.host) {
            cfg.host = 'localhost';
        }
        if (cfg.port === undefined || cfg.port === null) {
            cfg.port = 1550;
        }
        if (cfg.autoAttachTargets === undefined) {
            cfg.autoAttachTargets = true;
        }
        if (cfg.pingIntervalMs === undefined) {
            cfg.pingIntervalMs = 1000;
        }
        if (cfg.connectTimeoutMs === undefined) {
            cfg.connectTimeoutMs = 0;
        }

        // Validate port
        const port = cfg.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            void vscode.window.showErrorMessage(
                `BSL Debug: некорректный порт "${port}". Укажите целое число от 1 до 65535.`
            );
            return undefined;
        }

        // Resolve ${workspaceFolder:Name} variables in manually specified extensions[]
        if (Array.isArray(cfg.extensions)) {
            cfg.extensions = cfg.extensions.map(resolveWorkspaceFolderVar);
        } else {
            // Auto-populate extensions from multi-root workspace folders (excluding active folder)
            const folders = vscode.workspace.workspaceFolders ?? [];
            if (folders.length > 1) {
                const activeFolderPath = _folder?.uri.fsPath;
                cfg.extensions = folders
                    .map((f) => f.uri.fsPath)
                    .filter((p) => p !== activeFolderPath);
            } else {
                cfg.extensions = [];
            }
        }

        return cfg;
    }
}
