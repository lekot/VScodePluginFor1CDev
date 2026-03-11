/**
 * Types of parsing errors
 */
export declare enum ParsingErrorType {
    InvalidPath = "InvalidPath",
    FileNotFound = "FileNotFound",
    InvalidXml = "InvalidXml",
    MissingElement = "MissingElement",
    InvalidFormat = "InvalidFormat",
    PermissionDenied = "PermissionDenied",
    UnknownFormat = "UnknownFormat",
    ParseError = "ParseError"
}
/**
 * Parsing error with detailed information
 */
export declare class ParsingError extends Error {
    type: ParsingErrorType;
    filePath: string;
    originalError?: Error | undefined;
    constructor(type: ParsingErrorType, filePath: string, message: string, originalError?: Error | undefined);
    /**
     * Get user-friendly error message
     */
    getUserMessage(): string;
    /**
     * Get detailed error information for logging
     */
    getDetailedMessage(): string;
}
/**
 * Error handler for parsing operations
 */
export declare class ParsingErrorHandler {
    /**
     * Handle file system errors
     * @param error Error from file system operation
     * @param filePath Path that caused the error
     * @returns ParsingError
     */
    static handleFileSystemError(error: unknown, filePath: string): ParsingError;
    /**
     * Handle XML parsing errors
     * @param error Error from XML parser
     * @param filePath Path of XML file
     * @returns ParsingError
     */
    static handleXmlError(error: unknown, filePath: string): ParsingError;
    /**
     * Handle missing element errors
     * @param elementName Name of missing element
     * @param filePath Path of file
     * @returns ParsingError
     */
    static handleMissingElement(elementName: string, filePath: string): ParsingError;
    /**
     * Handle format detection errors
     * @param filePath Path of configuration
     * @returns ParsingError
     */
    static handleUnknownFormat(filePath: string): ParsingError;
    /**
     * Log parsing error
     * @param error ParsingError to log
     */
    static logError(error: ParsingError): void;
    /**
     * Validate error and return appropriate message
     * @param error Error to validate
     * @returns User-friendly error message
     */
    static getErrorMessage(error: unknown): string;
}
/**
 * Validation utilities for parsing
 */
export declare class ParsingValidation {
    /**
     * Validate configuration path
     * @param configPath Path to validate
     * @throws ParsingError if invalid
     */
    static validateConfigPath(configPath: string): void;
    /**
     * Validate XML object structure
     * @param obj Object to validate
     * @param requiredElements Required element names
     * @throws ParsingError if validation fails
     */
    static validateXmlStructure(obj: Record<string, unknown>, requiredElements: string[], filePath: string): void;
    /**
     * Validate metadata type
     * @param type Type to validate
     * @returns true if valid
     */
    static isValidMetadataType(type: string): boolean;
}
//# sourceMappingURL=parsingErrors.d.ts.map