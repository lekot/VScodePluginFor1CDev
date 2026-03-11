"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
let vscode;
try {
    vscode = require('vscode');
}
catch {
    vscode = null;
}
/**
 * Logger utility for the extension
 */
class Logger {
    static initialize() {
        try {
            if (vscode && vscode.window) {
                this.outputChannel = vscode.window.createOutputChannel('1C Metadata Tree');
            }
        }
        catch {
            // vscode not available (e.g., in tests)
            this.outputChannel = null;
        }
    }
    static info(message, ...args) {
        this.log('INFO', message, args);
    }
    static warn(message, ...args) {
        this.log('WARN', message, args);
    }
    static error(message, error) {
        const errorStr = error instanceof Error ? error.message : String(error);
        this.log('ERROR', message, [errorStr]);
    }
    static debug(message, ...args) {
        this.log('DEBUG', message, args);
    }
    static log(level, message, args) {
        const timestamp = new Date().toISOString();
        const argsStr = args.length > 0 ? ` ${JSON.stringify(args)}` : '';
        const logMessage = `[${timestamp}] [${level}] ${message}${argsStr}`;
        if (this.outputChannel) {
            this.outputChannel.appendLine(logMessage);
        }
        if (level === 'ERROR') {
            console.error(logMessage);
        }
        else {
            console.log(logMessage);
        }
    }
    static show() {
        if (this.outputChannel) {
            this.outputChannel.show();
        }
    }
}
exports.Logger = Logger;
Logger.outputChannel = null;
//# sourceMappingURL=logger.js.map