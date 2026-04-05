import * as vscode from 'vscode';
import { BslAttachConfiguration } from './types';

export class BslDebugConfigProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
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

        return cfg;
    }
}
