import { Logger } from '../utils/logger';

/**
 * Types of parsing errors
 */
export enum ParsingErrorType {
  InvalidPath = 'InvalidPath',
  FileNotFound = 'FileNotFound',
  InvalidXml = 'InvalidXml',
  MissingElement = 'MissingElement',
  InvalidFormat = 'InvalidFormat',
  PermissionDenied = 'PermissionDenied',
  UnknownFormat = 'UnknownFormat',
  ParseError = 'ParseError',
}

/**
 * Parsing error with detailed information
 */
export class ParsingError extends Error {
  constructor(
    public type: ParsingErrorType,
    public filePath: string,
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'ParsingError';
  }

  /**
   * Get user-friendly error message
   */
  getUserMessage(): string {
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
  getDetailedMessage(): string {
    let message = `[${this.type}] ${this.message}`;
    if (this.originalError) {
      message += `\nOriginal error: ${this.originalError.message}`;
    }
    return message;
  }
}

/**
 * Error handler for parsing operations
 */
export class ParsingErrorHandler {
  /**
   * Handle file system errors
   * @param error Error from file system operation
   * @param filePath Path that caused the error
   * @returns ParsingError
   */
  static handleFileSystemError(error: unknown, filePath: string): ParsingError {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'ENOENT') {
      return new ParsingError(
        ParsingErrorType.FileNotFound,
        filePath,
        `File not found: ${filePath}`,
        err
      );
    }

    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return new ParsingError(
        ParsingErrorType.PermissionDenied,
        filePath,
        `Permission denied accessing: ${filePath}`,
        err
      );
    }

    if (err.code === 'EISDIR') {
      return new ParsingError(
        ParsingErrorType.InvalidPath,
        filePath,
        `Path is a directory, not a file: ${filePath}`,
        err
      );
    }

    return new ParsingError(
      ParsingErrorType.ParseError,
      filePath,
      `Error accessing file: ${filePath}`,
      err
    );
  }

  /**
   * Handle XML parsing errors
   * @param error Error from XML parser
   * @param filePath Path of XML file
   * @returns ParsingError
   */
  static handleXmlError(error: unknown, filePath: string): ParsingError {
    const err = error as Error;

    return new ParsingError(
      ParsingErrorType.InvalidXml,
      filePath,
      `Invalid XML in file: ${filePath}. ${err.message}`,
      err
    );
  }

  /**
   * Handle missing element errors
   * @param elementName Name of missing element
   * @param filePath Path of file
   * @returns ParsingError
   */
  static handleMissingElement(elementName: string, filePath: string): ParsingError {
    return new ParsingError(
      ParsingErrorType.MissingElement,
      filePath,
      `Missing required element '${elementName}' in: ${filePath}`
    );
  }

  /**
   * Handle format detection errors
   * @param filePath Path of configuration
   * @returns ParsingError
   */
  static handleUnknownFormat(filePath: string): ParsingError {
    return new ParsingError(
      ParsingErrorType.UnknownFormat,
      filePath,
      `Unknown configuration format at: ${filePath}`
    );
  }

  /**
   * Log parsing error
   * @param error ParsingError to log
   */
  static logError(error: ParsingError): void {
    Logger.error(error.getDetailedMessage());
  }

  /**
   * Validate error and return appropriate message
   * @param error Error to validate
   * @returns User-friendly error message
   */
  static getErrorMessage(error: unknown): string {
    if (error instanceof ParsingError) {
      return error.getUserMessage();
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error occurred';
  }
}

/**
 * Validation utilities for parsing
 */
export class ParsingValidation {
  /**
   * Validate configuration path
   * @param configPath Path to validate
   * @throws ParsingError if invalid
   */
  static validateConfigPath(configPath: string): void {
    if (!configPath || typeof configPath !== 'string') {
      throw new ParsingError(
        ParsingErrorType.InvalidPath,
        configPath || 'undefined',
        'Configuration path must be a non-empty string'
      );
    }

    if (configPath.length === 0) {
      throw new ParsingError(
        ParsingErrorType.InvalidPath,
        configPath,
        'Configuration path cannot be empty'
      );
    }
  }

  /**
   * Validate XML object structure
   * @param obj Object to validate
   * @param requiredElements Required element names
   * @throws ParsingError if validation fails
   */
  static validateXmlStructure(
    obj: Record<string, unknown>,
    requiredElements: string[],
    filePath: string
  ): void {
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
  static isValidMetadataType(type: string): boolean {
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
