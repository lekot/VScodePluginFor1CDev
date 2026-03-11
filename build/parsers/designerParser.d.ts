import { TreeNode } from '../models/treeNode';
/**
 * Parser for 1C Designer format metadata
 * Designer format uses structured XML files in specific directory structure
 */
export declare class DesignerParser {
    /**
     * Parse Designer format configuration
     * @param configPath Path to configuration root directory
     * @returns Root tree node
     */
    static parse(configPath: string): Promise<TreeNode>;
    /**
     * Detect if path contains Designer format configuration
     * @param _configPath Path to check
     * @returns true if Designer format detected
     */
    static isDesignerFormat(_configPath: string): Promise<boolean>;
}
//# sourceMappingURL=designerParser.d.ts.map