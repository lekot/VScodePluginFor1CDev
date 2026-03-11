"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParsingValidation = exports.ParsingErrorHandler = exports.ParsingError = exports.ParsingErrorType = void 0;
const logger_1 = require("../utils/logger");
/**
 * Types of parsing errors
 */
var ParsingErrorType;
(function (ParsingErrorType) {
    ParsingErrorType["InvalidPath"] = "InvalidPath";
    ParsingErrorType["FileNotFound"] = "FileNotFound";
    ParsingErrorType["InvalidXml"] = "InvalidXml";
    ParsingErrorType["MissingElement"] = "MissingElement";
    ParsingErrorType["InvalidFormat"] = "InvalidFormat";
    ParsingErrorType["PermissionDenied"] = "PermissionDenied";
    ParsingErrorType["UnknownFormat"] = "UnknownFormat";
    ParsingErrorType["ParseError"] = "ParseError";
})(ParsingErrorType || (exports.ParsingErrorType = ParsingErrorType = {}));
/**
 * Parsing error with detailed information
 */
class ParsingError extends Error {
    constructor(type, filePath, message, originalError) {
        super(message);
        this.type = type;
        this.filePath = filePath;
        this.originalError = originalError;
        this.name = 'ParsingError';
    }
    /**
     * Get user-friendly error message
     */
    getUserMessage() {
        switch (this.type) {
            case ParsingErrorType.InvalidPath:
                return `Invalid configuration path: ${this.filePath}`;
            case ParsingErrorType.FileNotFound:
                return `File not found: ${this.filePath}`;
            case ParsingErrorType.InvalidXml:
                return `Invalid XML file: ${this.filePath}`;
            case ParsingErrorType.MissingElement:
                return `Missing required element in: ${this.filePath}`;
            case ParsingErrorType.InvalidFormat:
                return `Invalid configuration format at: ${this.filePath}`;
            case ParsingErrorType.PermissionDenied:
                return `Permission denied accessing: ${this.filePath}`;
            case ParsingErrorType.UnknownFormat:
                return `Unknown configuration format at: ${this.filePath}`;
            case ParsingErrorType.ParseError:
                return `Error parsing: ${this.filePath}`;
            default:
                return `Unknown error: ${this.message}`;
        }
    }
    /**
     * Get detailed error information for logging
     */
    getDetailedMessage() {
        let message = `[${this.type}] ${this.message}`;
        if (this.originalError) {
            message += `\nOriginal error: ${this.originalError.message}`;
        }
        return message;
    }
}
exports.ParsingError = ParsingError;
/**
 * Error handler for parsing operations
 */
class ParsingErrorHandler {
    /**
     * Handle file system errors
     * @param error Error from file system operation
     * @param filePath Path that caused the error
     * @returns ParsingError
     */
    static handleFileSystemError(error, filePath) {
        const err = error;
        if (err.code === 'ENOENT') {
            return new ParsingError(ParsingErrorType.FileNotFound, filePath, `File not found: ${filePath}`, err);
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            return new ParsingError(ParsingErrorType.PermissionDenied, filePath, `Permission denied accessing: ${filePath}`, err);
        }
        if (err.code === 'EISDIR') {
            return new ParsingError(ParsingErrorType.InvalidPath, filePath, `Path is a directory, not a file: ${filePath}`, err);
        }
        return new ParsingError(ParsingErrorType.ParseError, filePath, `Error accessing file: ${filePath}`, err);
    }
    /**
     * Handle XML parsing errors
     * @param error Error from XML parser
     * @param filePath Path of XML file
     * @returns ParsingError
     */
    static handleXmlError(error, filePath) {
        const err = error;
        return new ParsingError(ParsingErrorType.InvalidXml, filePath, `Invalid XML in file: ${filePath}. ${err.message}`, err);
    }
    /**
     * Handle missing element errors
     * @param elementName Name of missing element
     * @param filePath Path of file
     * @returns ParsingError
     */
    static handleMissingElement(elementName, filePath) {
        return new ParsingError(ParsingErrorType.MissingElement, filePath, `Missing required element '${elementName}' in: ${filePath}`);
    }
    /**
     * Handle format detection errors
     * @param filePath Path of configuration
     * @returns ParsingError
     */
    static handleUnknownFormat(filePath) {
        return new ParsingError(ParsingErrorType.UnknownFormat, filePath, `Unknown configuration format at: ${filePath}`);
    }
    /**
     * Log parsing error
     * @param error ParsingError to log
     */
    static logError(error) {
        logger_1.Logger.error(error.getDetailedMessage());
    }
    /**
     * Validate error and return appropriate message
     * @param error Error to validate
     * @returns User-friendly error message
     */
    static getErrorMessage(error) {
        if (error instanceof ParsingError) {
            return error.getUserMessage();
        }
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown error occurred';
    }
}
exports.ParsingErrorHandler = ParsingErrorHandler;
/**
 * Validation utilities for parsing
 */
class ParsingValidation {
    /**
     * Validate configuration path
     * @param configPath Path to validate
     * @throws ParsingError if invalid
     */
    static validateConfigPath(configPath) {
        if (!configPath || typeof configPath !== 'string') {
            throw new ParsingError(ParsingErrorType.InvalidPath, configPath || 'undefined', 'Configuration path must be a non-empty string');
        }
        if (configPath.length === 0) {
            throw new ParsingError(ParsingErrorType.InvalidPath, configPath, 'Configuration path cannot be empty');
        }
    }
    /**
     * Validate XML object structure
     * @param obj Object to validate
     * @param requiredElements Required element names
     * @throws ParsingError if validation fails
     */
    static validateXmlStructure(obj, requiredElements, filePath) {
        for (const element of requiredElements) {
            if (!(element in obj)) {
                throw ParsingErrorHandler.handleMissingElement(element, filePath);
            }
        }
    }
    /**
     * Validate metadata type
     * @param type Type to validate
     * @returns true if valid
     */
    static isValidMetadataType(type) {
        const validTypes = [
            'Catalog',
            'Document',
            'Enum',
            'Report',
            'DataProcessor',
            'ChartOfCharacteristicTypes',
            'ChartOfAccounts',
            'ChartOfCalculationTypes',
            'InformationRegister',
            'AccumulationRegister',
            'AccountingRegister',
            'CalculationRegister',
            'BusinessProcess',
            'Task',
            'ExternalDataSource',
            'Constant',
            'SessionParameter',
            'FilterCriterion',
            'ScheduledJob',
            'FunctionalOption',
            'FunctionalOptionsParameter',
            'SettingsStorage',
            'EventSubscription',
            'CommonModule',
            'CommandGroup',
            'Command',
            'Role',
            'Interface',
            'Style',
            'WebService',
            'HTTPService',
            'IntegrationService',
            'Subsystem',
        ];
        return validTypes.includes(type);
    }
}
exports.ParsingValidation = ParsingValidation;
//# sourceMappingURL=parsingErrors.js.map