"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataParser = void 0;
const logger_1 = require("../utils/logger");
const designerParser_1 = require("./designerParser");
const edtParser_1 = require("./edtParser");
const formatDetector_1 = require("./formatDetector");
/**
 * Main metadata parser that handles both EDT and Designer formats
 */
class MetadataParser {
    /**
     * Parse configuration metadata
     * @param configPath Path to configuration root directory
     * @returns Root tree node
     */
    static async parse(configPath) {
        logger_1.Logger.info('Starting metadata parsing', configPath);
        try {
            // Validate configuration path
            if (!(await formatDetector_1.FormatDetector.isValidConfigurationPath(configPath))) {
                throw new Error(`Invalid configuration path: ${configPath}`);
            }
            // Detect format
            const format = await formatDetector_1.FormatDetector.detect(configPath);
            if (format === formatDetector_1.ConfigFormat.Unknown) {
                throw new Error(`Unknown configuration format at ${configPath}`);
            }
            // Parse based on format
            let rootNode;
            if (format === formatDetector_1.ConfigFormat.Designer) {
                rootNode = await designerParser_1.DesignerParser.parse(configPath);
            }
            else if (format === formatDetector_1.ConfigFormat.EDT) {
                rootNode = await edtParser_1.EdtParser.parse(configPath);
            }
            else {
                throw new Error(`Unsupported configuration format: ${format}`);
            }
            logger_1.Logger.info('Metadata parsing completed successfully');
            return rootNode;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.Logger.error('Error parsing metadata', error);
            throw new Error(`Failed to parse metadata: ${errorMessage}`);
        }
    }
    /**
     * Parse configuration from workspace
     * @param workspacePath Path to workspace
     * @returns Root tree node or null if configuration not found
     */
    static async parseFromWorkspace(workspacePath) {
        try {
            const configPath = await formatDetector_1.FormatDetector.findConfigurationRoot(workspacePath);
            if (!configPath) {
                logger_1.Logger.warn('Configuration not found in workspace', workspacePath);
                return null;
            }
            return await this.parse(configPath);
        }
        catch (error) {
            logger_1.Logger.error('Error parsing configuration from workspace', error);
            return null;
        }
    }
    /**
     * Get detected format for configuration
     * @param configPath Path to configuration
     * @returns Detected format
     */
    static async getFormat(configPath) {
        return formatDetector_1.FormatDetector.detect(configPath);
    }
    /**
     * Find configuration root in workspace
     * @param workspacePath Path to workspace
     * @returns Configuration root path or null
     */
    static async findConfigurationRoot(workspacePath) {
        return formatDetector_1.FormatDetector.findConfigurationRoot(workspacePath);
    }
}
exports.MetadataParser = MetadataParser;
//# sourceMappingURL=metadataParser.js.map