/**
 * Configuration format types
 */
export declare enum ConfigFormat {
    Designer = "Designer",
    EDT = "EDT",
    Unknown = "Unknown"
}
/**
 * Detector for 1C configuration format
 */
export declare class FormatDetector {
    /**
     * Detect configuration format
     * @param configPath Path to configuration root directory
     * @returns Detected format
     */
    static detect(configPath: string): Promise<ConfigFormat>;
    /**
     * Get configuration root path from workspace
     * @param workspacePath Path to workspace
     * @returns Configuration root path or null
     */
    static findConfigurationRoot(workspacePath: string): Promise<string | null>;
    /**
     * Recursively search for configuration in subdirectories
     * @param dirPath Directory to search
     * @param currentDepth Current recursion depth
     * @param maxDepth Maximum recursion depth
     * @returns Configuration path or null
     */
    private static searchConfigurationRecursive;
    /**
     * Check if directory has metadata type directories
     * @param dirPath Directory to check
     * @returns true if has at least one metadata directory
     */
    private static hasMetadataDirectories;
    /**
     * Validate configuration path
     * @param configPath Path to validate
     * @returns true if valid configuration path
     */
    static isValidConfigurationPath(configPath: string): Promise<boolean>;
}
//# sourceMappingURL=formatDetector.d.ts.map