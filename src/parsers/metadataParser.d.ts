import { TreeNode } from '../models/treeNode';
import { ConfigFormat } from './formatDetector';
/**
 * Main metadata parser that handles both EDT and Designer formats
 */
export declare class MetadataParser {
    /**
     * Parse configuration metadata
     * @param configPath Path to configuration root directory
     * @returns Root tree node
     */
    static parse(configPath: string): Promise<TreeNode>;
    /**
     * Parse configuration from workspace
     * @param workspacePath Path to workspace
     * @returns Root tree node or null if configuration not found
     */
    static parseFromWorkspace(workspacePath: string): Promise<TreeNode | null>;
    /**
     * Get detected format for configuration
     * @param configPath Path to configuration
     * @returns Detected format
     */
    static getFormat(configPath: string): Promise<ConfigFormat>;
    /**
     * Find configuration root in workspace
     * @param workspacePath Path to workspace
     * @returns Configuration root path or null
     */
    static findConfigurationRoot(workspacePath: string): Promise<string | null>;
}
//# sourceMappingURL=metadataParser.d.ts.map