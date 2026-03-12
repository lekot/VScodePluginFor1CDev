import * as assert from 'assert';
import { TypeEditorProvider } from '../typeEditorProvider';
import { TypeDefinition } from '../../types/typeDefinitions';
import * as vscode from 'vscode';
import * as path from 'path';

// Mock VS Code API
const mockExtensionUri = vscode.Uri.file(path.join(__dirname, '..'));
const mockContext: vscode.ExtensionContext = {
  extensionUri: mockExtensionUri,
  globalState: {
    get: () => undefined,
    update: async () => {},
    keys: () => [],
  },
  workspaceState: {
    get: () => undefined,
    update: async () => {},
    keys: () => [],
  },
  globalStorageUri: mockExtensionUri,
  workspaceStorageUri: mockExtensionUri,
  asAbsolutePath: (relativePath: string) => path.join(__dirname, relativePath),
  storageUri: undefined,
  storagePath: undefined,
  subscriptions: [],
  secrets: {
    onDidChange: () => ({ dispose: () => {} }),
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
  },
  environmentVariableCollection: {} as any,
  extension: {
    id: 'test-extension',
    extensionUri: mockExtensionUri,
    extensionPath: __dirname,
    isActive: true,
    exports: undefined,
    packageJSON: {},
    activate: async () => ({}),
  },
  extensionMode: vscode.ExtensionMode.Test,
  globalStoragePath: '',
  workspaceStoragePath: '',
  logPath: '',
  logUri: undefined,
} as any;

describe('TypeEditorProvider', () => {
  let provider: TypeEditorProvider;

  beforeEach(() => {
    provider = new TypeEditorProvider(mockContext);
  });

  describe('getWebviewContent', () => {
    const emptyRef: { referenceKind: string; objectNames: string[] }[] = [];

    it('should generate HTML with composite checkbox and tree', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('Составной тип данных'));
      assert.ok(content.includes('composite-cb'));
      assert.ok(content.includes('id="type-tree"'));
    });

    it('should include search field with Ctrl+Alt+M hint', () => {
      const definition: TypeDefinition = { category: 'primitive', types: [] };
      const content = provider['getWebviewContent'](definition, emptyRef);
      assert.ok(content.includes('Поиск (Ctrl+Alt+M)'));
      assert.ok(content.includes('id="search-input"'));
    });

    it('should include type preview section', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('Type Preview'));
      assert.ok(content.includes('Not set'));
    });

    it('should include Save and Cancel buttons', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('id="cancel-btn"'));
      assert.ok(content.includes('Cancel'));
      assert.ok(content.includes('id="save-btn"'));
      assert.ok(content.includes('Save'));
    });

    it('should apply VS Code theme colors', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('--vscode-editor-background'));
      assert.ok(content.includes('--vscode-editor-foreground'));
      assert.ok(content.includes('--vscode-button-background'));
      assert.ok(content.includes('--vscode-input-background'));
      assert.ok(content.includes('--vscode-focusBorder'));
    });

    it('should include qualifiers section for focused primitive', () => {
      const definition: TypeDefinition = { category: 'primitive', types: [] };
      const content = provider['getWebviewContent'](definition, emptyRef);
      assert.ok(content.includes('Квалификаторы'));
      assert.ok(content.includes('id="qualifier-section"'));
      assert.ok(content.includes('id="string-qualifiers"'));
      assert.ok(content.includes('id="number-qualifiers"'));
      assert.ok(content.includes('id="date-qualifiers"'));
    });

    it('should display formatted type in preview', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string', qualifiers: { length: 50, allowedLength: 'Variable' } }],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('String(50)'));
    });

    it('should disable save button when no types', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('id="save-btn"') && content.includes('disabled'));
    });

    it('should enable save button when types exist', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string' }],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('id="save-btn"'));
      const saveBtnMatch = content.match(/id="save-btn"[^>]*>/);
      assert.ok(saveBtnMatch && !saveBtnMatch[0].includes('disabled'));
    });

    it('should include JavaScript for webview communication', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('acquireVsCodeApi'));
      assert.ok(content.includes('postMessage'));
    });

    it('should render type display in preview section', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string' }],
      };
      const content = provider['getWebviewContent'](definition, emptyRef);
      
      assert.ok(content.includes('preview-value'));
      assert.ok(content.includes('String'));
    });

    it('should include tree with primitives and reference groups', () => {
      const definition: TypeDefinition = { category: 'primitive', types: [] };
      const refGroups = [
        { referenceKind: 'CatalogRef', objectNames: ['Products'] },
      ];
      const content = provider['getWebviewContent'](definition, refGroups);
      assert.ok(content.includes('primitive:string'));
      assert.ok(content.includes('primitive:number'));
      assert.ok(content.includes('CatalogRef'));
      assert.ok(content.includes('ref:CatalogRef:Products'));
    });

    it('should accept referenceableObjects and pass to script', () => {
      const definition: TypeDefinition = { category: 'primitive', types: [] };
      const refGroups = [{ referenceKind: 'DocumentRef', objectNames: ['Order'] }];
      const content = provider['getWebviewContent'](definition, refGroups);
      assert.ok(content.includes('DocumentRef'));
      assert.ok(content.includes('Order'));
    });
  });

  describe('formatTypeDisplay', () => {
    it('should return "Not set" for empty types', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const result = provider['formatTypeDisplay'](definition);
      assert.strictEqual(result, 'Not set');
    });

    it('should format string type with length', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string', qualifiers: { length: 100, allowedLength: 'Variable' } }],
      };
      const result = provider['formatTypeDisplay'](definition);
      assert.strictEqual(result, 'String(100)');
    });

    it('should format number type with precision and scale', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'number', qualifiers: { digits: 10, fractionDigits: 2, allowedSign: 'Any' } }],
      };
      const result = provider['formatTypeDisplay'](definition);
      assert.strictEqual(result, 'Number(10,2)');
    });

    it('should format boolean type', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'boolean' }],
      };
      const result = provider['formatTypeDisplay'](definition);
      assert.strictEqual(result, 'Boolean');
    });

    it('should format date type with fractions', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'date', qualifiers: { dateFractions: 'DateTime' } }],
      };
      const result = provider['formatTypeDisplay'](definition);
      assert.strictEqual(result, 'DateTime');
    });

    it('should format reference type', () => {
      const definition: TypeDefinition = {
        category: 'reference',
        types: [{ kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'Products' } }],
      };
      const result = provider['formatTypeDisplay'](definition);
      assert.strictEqual(result, 'CatalogRef.Products');
    });

    it('should format composite type with multiple entries', () => {
      const definition: TypeDefinition = {
        category: 'composite',
        types: [
          { kind: 'string', qualifiers: { length: 50, allowedLength: 'Variable' } },
          { kind: 'number', qualifiers: { digits: 10, fractionDigits: 2, allowedSign: 'Any' } },
          { kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'Products' } },
        ],
      };
      const result = provider['formatTypeDisplay'](definition);
      assert.strictEqual(result, 'String(50) | Number(10,2) | CatalogRef.Products');
    });
  });

  describe('getQualifierValue', () => {
    it('should return qualifier value for existing type', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string', qualifiers: { length: 100, allowedLength: 'Variable' } }],
      };
      const result = provider['getQualifierValue'](definition, 'string', 'length');
      assert.strictEqual(result, 100);
    });

    it('should return undefined for non-existent type', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string' }],
      };
      const result = provider['getQualifierValue'](definition, 'number', 'digits');
      assert.strictEqual(result, undefined);
    });

    it('should return undefined for non-existent qualifier', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string' }],
      };
      const result = provider['getQualifierValue'](definition, 'string', 'length');
      assert.strictEqual(result, undefined);
    });
  });

  describe('getReferenceValue', () => {
    it('should return object name for reference type', () => {
      const definition: TypeDefinition = {
        category: 'reference',
        types: [{ kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'Products' } }],
      };
      const result = provider['getReferenceValue'](definition);
      assert.strictEqual(result, 'Products');
    });

    it('should return undefined for non-reference type', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string' }],
      };
      const result = provider['getReferenceValue'](definition);
      assert.strictEqual(result, undefined);
    });
  });

  describe('renderCompositeList', () => {
    it('should return empty state message for empty types', () => {
      const definition: TypeDefinition = {
        category: 'composite',
        types: [],
      };
      const result = provider['renderCompositeList'](definition);
      assert.ok(result.includes('No types added yet'));
    });

    it('should render type items with remove buttons', () => {
      const definition: TypeDefinition = {
        category: 'composite',
        types: [{ kind: 'string' }],
      };
      const result = provider['renderCompositeList'](definition);
      assert.ok(result.includes('type-item'));
      assert.ok(result.includes('data-action="remove"'));
    });
  });

  describe('validateTypeDefinition', () => {
    it('should return error for undefined type definition', () => {
      const result = provider['validateTypeDefinition'](undefined);
      assert.ok(result.includes('Type definition is required'));
    });

    it('should return error for empty types array', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.ok(result.includes('Type definition is required'));
    });

    it('should return no errors for valid string type', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string', qualifiers: { length: 50, allowedLength: 'Variable' } }],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.strictEqual(result.length, 0);
    });

    it('should return error for invalid string length', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'string', qualifiers: { length: 2000, allowedLength: 'Variable' } }],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.ok(result.some((e: string) => e.includes('String length must be between 1 and 1024')));
    });

    it('should return no errors for valid number type', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'number', qualifiers: { digits: 10, fractionDigits: 2, allowedSign: 'Any' } }],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.strictEqual(result.length, 0);
    });

    it('should return error for invalid number digits', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'number', qualifiers: { digits: 50, fractionDigits: 2, allowedSign: 'Any' } }],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.ok(result.some((e: string) => e.includes('Number digits must be between 1 and 38')));
    });

    it('should return error for invalid fraction digits', () => {
      const definition: TypeDefinition = {
        category: 'primitive',
        types: [{ kind: 'number', qualifiers: { digits: 5, fractionDigits: 10, allowedSign: 'Any' } }],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.ok(result.some((e: string) => e.includes('Number fraction digits must be between 0 and')));
    });

    it('should allow reference with empty object name (group-only selection)', () => {
      const definition: TypeDefinition = {
        category: 'reference',
        types: [{ kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: '' } }],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.strictEqual(result.length, 0);
    });

    it('should return no errors for valid reference type', () => {
      const definition: TypeDefinition = {
        category: 'reference',
        types: [{ kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'Products' } }],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.strictEqual(result.length, 0);
    });

    it('should return no errors for valid composite type', () => {
      const definition: TypeDefinition = {
        category: 'composite',
        types: [
          { kind: 'string', qualifiers: { length: 50, allowedLength: 'Variable' } },
          { kind: 'number', qualifiers: { digits: 10, fractionDigits: 2, allowedSign: 'Any' } },
        ],
      };
      const result = provider['validateTypeDefinition'](definition);
      assert.strictEqual(result.length, 0);
    });
  });
});
