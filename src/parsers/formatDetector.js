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
exports.FormatDetector = exports.ConfigFormat = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../utils/logger");
const designerParser_1 = require("./designerParser");
const edtParser_1 = require("./edtParser");
/**
 * Configuration format types
 */
var ConfigFormat;
(function (ConfigFormat) {
    ConfigFormat["Designer"] = "Designer";
    ConfigFormat["EDT"] = "EDT";
    ConfigFormat["Unknown"] = "Unknown";
})(ConfigFormat || (exports.ConfigFormat = ConfigFormat = {}));
/**
 * Detector for 1C configuration format
 */
class FormatDetector {
    /**
     * Detect configuration format
     * @param configPath Path to configuration root directory
     * @returns Detected format
     */
    static async detect(configPath) {
        logger_1.Logger.info('Detecting configuration format', configPath);
        try {
            // Check if path exists
            try {
                await fs.promises.access(configPath);
            }
            catch {
                logger_1.Logger.warn(`Configuration path does not exist: ${configPath}`);
                return ConfigFormat.Unknown;
            }
            // Check for Designer format first (has 1cv8.cf or 1cv8.cfe)
            if (await designerParser_1.DesignerParser.isDesignerFormat(configPath)) {
                logger_1.Logger.info('Detected Designer format');
                return ConfigFormat.Designer;
            }
            // Check for EDT format (has Configuration.xml)
            if (await edtParser_1.EdtParser.isEdtFormat(configPath)) {
                logger_1.Logger.info('Detected EDT format');
                return ConfigFormat.EDT;
            }
            logger_1.Logger.warn('Unknown configuration format');
            return ConfigFormat.Unknown;
        }
        catch (error) {
            logger_1.Logger.error('Error detecting configuration format', error);
            return ConfigFormat.Unknown;
        }
    }
    /**
     * Get configuration root path from workspace
     * @param workspacePath Path to workspace
     * @returns Configuration root path or null
     */
    static async findConfigurationRoot(workspacePath) {
        try {
            // Look for 1cv8.cf or 1cv8.cfe in workspace
            const cfPath = path.join(workspacePath, '1cv8.cf');
            const cfePath = path.join(workspacePath, '1cv8.cfe');
            try {
                await fs.promises.access(cfPath);
                return workspacePath;
            }
            catch {
                // Continue checking
            }
            try {
                await fs.promises.access(cfePath);
                return workspacePath;
            }
            catch {
                // Continue checking
            }
            // Look for Configuration.xml in workspace
            const configXmlPath = path.join(workspacePath, 'Configuration.xml');
            try {
                await fs.promises.access(configXmlPath);
                // Also check for metadata directories to confirm it's a valid config
                const hasMetadata = await this.hasMetadataDirectories(workspacePath);
                if (hasMetadata) {
                    return workspacePath;
                }
            }
            catch {
                // Continue checking
            }
            // Search in subdirectories recursively (max depth 5)
            const found = await this.searchConfigurationRecursive(workspacePath, 0, 5);
            return found;
        }
        catch (error) {
            logger_1.Logger.error('Error finding configuration root', error);
            return null;
        }
    }
    /**
     * Recursively search for configuration in subdirectories
     * @param dirPath Directory to search
     * @param currentDepth Current recursion depth
     * @param maxDepth Maximum recursion depth
     * @returns Configuration path or null
     */
    static async searchConfigurationRecursive(dirPath, currentDepth, maxDepth) {
        if (currentDepth >= maxDepth) {
            return null;
        }
        try {
            const items = await fs.promises.readdir(dirPath);
            for (const item of items) {
                // Skip common non-config directories
                if (item === 'node_modules' || item === '.git' || item === '.vscode' || item === 'dist' || item === 'out') {
                    continue;
                }
                const itemPath = path.join(dirPath, item);
                try {
                    const stat = await fs.promises.stat(itemPath);
                    if (stat.isDirectory()) {
                        // Check if this directory is a configuration root
                        const cfPath = path.join(itemPath, '1cv8.cf');
                        const cfePath = path.join(itemPath, '1cv8.cfe');
                        const configXmlPath = path.join(itemPath, 'Configuration.xml');
                        // Check all paths in parallel
                        const checks = await Promise.allSettled([
                            fs.promises.access(cfPath),
                            fs.promises.access(cfePath),
                            fs.promises.access(configXmlPath),
                        ]);
                        if (checks.some(result => result.status === 'fulfilled')) {
                            // Also verify metadata directories exist
                            const hasMetadata = await this.hasMetadataDirectories(itemPath);
                            if (hasMetadata) {
                                logger_1.Logger.info(`Found configuration at depth ${currentDepth + 1}: ${itemPath}`);
                                return itemPath;
                            }
                        }
                        // Recursively search in this subdirectory
                        const found = await this.searchConfigurationRecursive(itemPath, currentDepth + 1, maxDepth);
                        if (found) {
                            return found;
                        }
                    }
                }
                catch (error) {
                    logger_1.Logger.debug(`Error checking subdirectory ${itemPath}`, error);
                }
            }
            return null;
        }
        catch (error) {
            logger_1.Logger.debug(`Error reading directory ${dirPath}`, error);
            return null;
        }
    }
    /**
     * Check if directory has metadata type directories
     * @param dirPath Directory to check
     * @returns true if has at least one metadata directory
     */
    static async hasMetadataDirectories(dirPath) {
        const metadataTypes = ['Catalogs', 'Documents', 'Enums', 'Reports', 'DataProcessors', 'CommonModules'];
        for (const type of metadataTypes) {
            const typePath = path.join(dirPath, type);
            try {
                await fs.promises.access(typePath);
                const stat = await fs.promises.stat(typePath);
                if (stat.isDirectory()) {
                    return true;
                }
            }
            catch {
                // Continue checking
            }
        }
        return false;
    }
    /**
     * Validate configuration path
     * @param configPath Path to validate
     * @returns true if valid configuration path
     */
    static async isValidConfigurationPath(configPath) {
        try {
            // Check if path exists
            try {
                await fs.promises.access(configPath);
            }
            catch {
                return false;
            }
            const stat = await fs.promises.stat(configPath);
            if (!stat.isDirectory()) {
                return false;
            }
            // Check for required files or directories
            const cfPath = path.join(configPath, '1cv8.cf');
            const cfePath = path.join(configPath, '1cv8.cfe');
            const configXmlPath = path.join(configPath, 'Configuration.xml');
            const configDumpPath = path.join(configPath, 'ConfigDumpInfo.xml');
            // Check all paths in parallel
            const checks = await Promise.allSettled([
                fs.promises.access(cfPath),
                fs.promises.access(cfePath),
                fs.promises.access(configXmlPath),
                fs.promises.access(configDumpPath),
            ]);
            return checks.some(result => result.status === 'fulfilled');
        }
        catch (error) {
            logger_1.Logger.debug('Error validating configuration path', error);
            return false;
        }
    }
}
exports.FormatDetector = FormatDetector;
//# sourceMappingURL=formatDetector.js.map