"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Logger utility for the extension
 */
class Logger {
    static initialize() {
        this.outputChannel = vscode.window.createOutputChannel('1C Metadata Tree');
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
        this.outputChannel.appendLine(logMessage);
        if (level === 'ERROR') {
            console.error(logMessage);
        }
        else {
            console.log(logMessage);
        }
    }
    static show() {
        this.outputChannel.show();
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map