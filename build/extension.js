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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const logger_1 = require("./utils/logger");
/**
 * Activate the extension
 */
function activate(context) {
    logger_1.Logger.initialize();
    logger_1.Logger.info('1C Metadata Tree extension activated');
    // Register commands
    const openPanelCommand = vscode.commands.registerCommand('1c-metadata-tree.openPanel', () => {
        logger_1.Logger.info('Opening metadata tree panel');
        vscode.window.showInformationMessage('1C Metadata Tree panel opened');
    });
    const refreshCommand = vscode.commands.registerCommand('1c-metadata-tree.refresh', () => {
        logger_1.Logger.info('Refreshing metadata tree');
    });
    context.subscriptions.push(openPanelCommand, refreshCommand);
    // Set context for conditional activation
    vscode.commands.executeCommand('setContext', '1c-metadata-tree:enabled', true);
}
/**
 * Deactivate the extension
 */
function deactivate() {
    logger_1.Logger.info('1C Metadata Tree extension deactivated');
}
//# sourceMappingURL=extension.js.map