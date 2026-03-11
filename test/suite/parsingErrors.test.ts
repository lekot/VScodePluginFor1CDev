import * as assert from 'assert';
import {
  ParsingError,
  ParsingErrorType,
  ParsingErrorHandler,
  ParsingValidation,
} from '../../src/parsers/parsingErrors';

suite('ParsingErrors', () => {
  test('should create ParsingError with correct properties', () => {
    const error = new ParsingError(
      ParsingErrorType.FileNotFound,
      '/path/to/file.xml',
      'File not found'
    );

    assert.strictEqual(error.type, ParsingErrorType.FileNotFound);
    assert.strictEqual(error.filePath, '/path/to/file.xml');
    assert.strictEqual(error.message, 'File not found');
  });

  test('should get user-friendly error message', () => {
    const error = new ParsingError(
      ParsingErrorType.FileNotFound,
      '/path/to/file.xml',
      'File not found'
    );

    const userMessage = error.getUserMessage();
    assert.ok(userMessage.includes('File not found'));
    assert.ok(userMessage.includes('/path/to/file.xml'));
  });

  test('should get detailed error message', () => {
    const originalError = new Error('Original error');
    const error = new ParsingError(
      ParsingErrorType.InvalidXml,
      '/path/to/file.xml',
      'Invalid XML',
      originalError
    );

    const detailedMessage = error.getDetailedMessage();
    assert.ok(detailedMessage.includes('InvalidXml'));
    assert.ok(detailedMessage.includes('Invalid XML'));
    assert.ok(detailedMessage.includes('Original error'));
  });

  test('should handle file system errors', () => {
    const fsError = new Error('ENOENT: no such file or directory');
    (fsError as NodeJS.ErrnoException).code = 'ENOENT';

    const parsingError = ParsingErrorHandler.handleFileSystemError(fsError, '/path/to/file.xml');

    assert.strictEqual(parsingError.type, ParsingErrorType.FileNotFound);
  });

  test('should handle permission denied errors', () => {
    const fsError = new Error('EACCES: permission denied');
    (fsError as NodeJS.ErrnoException).code = 'EACCES';

    const parsingError = ParsingErrorHandler.handleFileSystemError(fsError, '/path/to/file.xml');

    assert.strictEqual(parsingError.type, ParsingErrorType.PermissionDenied);
  });

  test('should handle XML parsing errors', () => {
    const xmlError = new Error('Invalid XML syntax');
    const parsingError = ParsingErrorHandler.handleXmlError(xmlError, '/path/to/file.xml');

    assert.strictEqual(parsingError.type, ParsingErrorType.InvalidXml);
  });

  test('should handle missing element errors', () => {
    const parsingError = ParsingErrorHandler.handleMissingElement('Configuration', '/path/to/file.xml');

    assert.strictEqual(parsingError.type, ParsingErrorType.MissingElement);
    assert.ok(parsingError.message.includes('Configuration'));
  });

  test('should validate configuration path', () => {
    assert.doesNotThrow(() => {
      ParsingValidation.validateConfigPath('/valid/path');
    });
  });

  test('should throw error for empty configuration path', () => {
    assert.throws(() => {
      ParsingValidation.validateConfigPath('');
    });
  });

  test('should throw error for null configuration path', () => {
    assert.throws(() => {
      ParsingValidation.validateConfigPath(null as unknown as string);
    });
  });

  test('should validate XML structure', () => {
    const obj = {
      root: 'value',
      child: 'value',
    };

    assert.doesNotThrow(() => {
      ParsingValidation.validateXmlStructure(obj, ['root', 'child'], '/path/to/file.xml');
    });
  });

  test('should throw error for missing required elements', () => {
    const obj = {
      root: 'value',
    };

    assert.throws(() => {
      ParsingValidation.validateXmlStructure(obj, ['root', 'missing'], '/path/to/file.xml');
    });
  });

  test('should validate metadata type', () => {
    assert.strictEqual(ParsingValidation.isValidMetadataType('Catalog'), true);
    assert.strictEqual(ParsingValidation.isValidMetadataType('Document'), true);
    assert.strictEqual(ParsingValidation.isValidMetadataType('InvalidType'), false);
  });

  test('should get error message from ParsingError', () => {
    const error = new ParsingError(
      ParsingErrorType.FileNotFound,
      '/path/to/file.xml',
      'File not found'
    );

    const message = ParsingErrorHandler.getErrorMessage(error);
    assert.ok(message.includes('File not found'));
  });

  test('should get error message from regular Error', () => {
    const error = new Error('Test error');
    const message = ParsingErrorHandler.getErrorMessage(error);

    assert.strictEqual(message, 'Test error');
  });

  test('should get default error message for unknown error', () => {
    const message = ParsingErrorHandler.getErrorMessage('unknown error');

    assert.strictEqual(message, 'Unknown error occurred');
  });
});
