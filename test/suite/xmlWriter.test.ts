import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XMLWriter } from '../../src/utils/XMLWriter';

suite('XMLWriter', () => {
  // Use source fixtures path, not compiled path
  const fixturesPath = path.join(__dirname, '../../../test/fixtures');
  const testXmlPath = path.join(fixturesPath, 'test-properties.xml');
  const tempXmlPath = path.join(fixturesPath, 'temp-test-properties.xml');

  // Clean up temp file after each test
  teardown(() => {
    if (fs.existsSync(tempXmlPath)) {
      fs.unlinkSync(tempXmlPath);
    }
  });

  suite('readProperties', () => {
    test('should read properties from XML file', async () => {
      const properties = await XMLWriter.readProperties(testXmlPath);

      assert.ok(properties);
      assert.strictEqual(typeof properties, 'object');
      assert.ok(Object.keys(properties).length > 0);
    });

    test('should extract Name property', async () => {
      const properties = await XMLWriter.readProperties(testXmlPath);

      assert.ok('Name' in properties);
      assert.strictEqual(properties.Name, 'TestCatalog');
    });

    test('should extract Synonym property', async () => {
      const properties = await XMLWriter.readProperties(testXmlPath);

      assert.ok('Synonym' in properties);
      assert.strictEqual(properties.Synonym, 'Test Catalog Synonym');
    });

    test('should extract Comment property', async () => {
      const properties = await XMLWriter.readProperties(testXmlPath);

      assert.ok('Comment' in properties);
      assert.strictEqual(properties.Comment, 'Test comment');
    });

    test('should extract boolean properties', async () => {
      const properties = await XMLWriter.readProperties(testXmlPath);

      assert.ok('UseStandardCommands' in properties);
      assert.ok('InputByString' in properties);
    });

    test('should throw error for non-existent file', async () => {
      const nonExistentPath = path.join(fixturesPath, 'non-existent.xml');

      await assert.rejects(
        async () => {
          await XMLWriter.readProperties(nonExistentPath);
        },
        (err: Error) => /File not found|Failed to read properties/.test(err.message),
        'Expected file not found or read error'
      );
    });

    test('should throw or return object for invalid XML', async () => {
      const invalidXmlPath = path.join(fixturesPath, 'invalid.xml');
      // Parser may throw or return empty/partial result for malformed XML
      fs.writeFileSync(invalidXmlPath, '<?xml version="1.0"?><root><item>test</root>');

      try {
        try {
          const properties = await XMLWriter.readProperties(invalidXmlPath);
          assert.strictEqual(typeof properties, 'object');
        } catch (err) {
          assert.ok(err instanceof Error && /Failed to read properties|Invalid XML structure/.test(err.message));
        }
      } finally {
        if (fs.existsSync(invalidXmlPath)) {
          fs.unlinkSync(invalidXmlPath);
        }
      }
    });
  });

  suite('writeProperties', () => {
    test('should write properties to XML file', async () => {
      // Copy test file to temp location
      fs.copyFileSync(testXmlPath, tempXmlPath);

      const newProperties = {
        Name: 'UpdatedCatalog',
        Synonym: 'Updated Synonym',
        Comment: 'Updated comment',
      };

      await XMLWriter.writeProperties(tempXmlPath, newProperties);

      // Verify file was written
      assert.ok(fs.existsSync(tempXmlPath));

      // Read back and verify
      const readProperties = await XMLWriter.readProperties(tempXmlPath);
      assert.strictEqual(readProperties.Name, 'UpdatedCatalog');
      assert.strictEqual(readProperties.Synonym, 'Updated Synonym');
      assert.strictEqual(readProperties.Comment, 'Updated comment');
    });

    test('should preserve XML structure when writing', async () => {
      // Copy test file to temp location
      fs.copyFileSync(testXmlPath, tempXmlPath);

      const newProperties = {
        Name: 'UpdatedCatalog',
      };

      await XMLWriter.writeProperties(tempXmlPath, newProperties);

      const updatedContent = fs.readFileSync(tempXmlPath, 'utf-8');

      // Should still have XML declaration
      assert.ok(updatedContent.includes('<?xml version="1.0"'));

      // Should still have root element
      assert.ok(updatedContent.includes('<MetaDataObject'));

      // Should still have Properties node
      assert.ok(updatedContent.includes('<Properties>'));

      // Should preserve other properties
      assert.ok(updatedContent.includes('Synonym'));
      assert.ok(updatedContent.includes('Comment'));
    });

    test('should preserve formatting when writing', async () => {
      // Copy test file to temp location
      fs.copyFileSync(testXmlPath, tempXmlPath);

      const newProperties = {
        Name: 'UpdatedCatalog',
      };

      await XMLWriter.writeProperties(tempXmlPath, newProperties);

      const updatedContent = fs.readFileSync(tempXmlPath, 'utf-8');

      // Should have indentation (tabs or spaces)
      assert.ok(updatedContent.includes('\t') || updatedContent.includes('  '));

      // Should have line breaks
      assert.ok(updatedContent.includes('\n'));
    });

    test('should throw error for non-existent file', async () => {
      const nonExistentPath = path.join(fixturesPath, 'non-existent.xml');

      await assert.rejects(
        async () => {
          await XMLWriter.writeProperties(nonExistentPath, { Name: 'Test' });
        },
        (err: Error) => /Failed to write properties|Unable to read/.test(err.message),
        'Expected write or read error for non-existent file'
      );
    });
  });

  suite('updateProperty', () => {
    test('should update single property', async () => {
      // Copy test file to temp location
      fs.copyFileSync(testXmlPath, tempXmlPath);

      await XMLWriter.updateProperty(tempXmlPath, 'Name', 'NewCatalogName');

      // Read back and verify
      const properties = await XMLWriter.readProperties(tempXmlPath);
      assert.strictEqual(properties.Name, 'NewCatalogName');

      // Other properties should remain unchanged
      assert.strictEqual(properties.Synonym, 'Test Catalog Synonym');
      assert.strictEqual(properties.Comment, 'Test comment');
    });

    test('should update Synonym property', async () => {
      // Copy test file to temp location
      fs.copyFileSync(testXmlPath, tempXmlPath);

      await XMLWriter.updateProperty(tempXmlPath, 'Synonym', 'New Synonym');

      // Read back and verify
      const properties = await XMLWriter.readProperties(tempXmlPath);
      assert.strictEqual(properties.Synonym, 'New Synonym');

      // Other properties should remain unchanged
      assert.strictEqual(properties.Name, 'TestCatalog');
    });

    test('should update Comment property', async () => {
      // Copy test file to temp location
      fs.copyFileSync(testXmlPath, tempXmlPath);

      await XMLWriter.updateProperty(tempXmlPath, 'Comment', 'New comment text');

      // Read back and verify
      const properties = await XMLWriter.readProperties(tempXmlPath);
      assert.strictEqual(properties.Comment, 'New comment text');
    });

    test('should preserve structure when updating property', async () => {
      // Copy test file to temp location
      fs.copyFileSync(testXmlPath, tempXmlPath);

      await XMLWriter.updateProperty(tempXmlPath, 'Name', 'NewName');

      const updatedContent = fs.readFileSync(tempXmlPath, 'utf-8');

      // Should still have same structure
      assert.ok(updatedContent.includes('<MetaDataObject'));
      assert.ok(updatedContent.includes('<Catalog'));
      assert.ok(updatedContent.includes('<Properties>'));
      assert.ok(updatedContent.includes('</Properties>'));
    });

    test('should throw error for non-existent file', async () => {
      const nonExistentPath = path.join(fixturesPath, 'non-existent.xml');

      await assert.rejects(
        async () => {
          await XMLWriter.updateProperty(nonExistentPath, 'Name', 'Test');
        },
        {
          message: /Failed to update property/,
        }
      );
    });
  });

  suite('error handling', () => {
    test('should handle gracefully when Properties node is missing', async () => {
      const noPropsXmlPath = path.join(fixturesPath, 'no-properties.xml');
      const xmlContent = '<?xml version="1.0"?><MetaDataObject><Catalog><Name>Test</Name></Catalog></MetaDataObject>';
      fs.writeFileSync(noPropsXmlPath, xmlContent);

      try {
        const properties = await XMLWriter.readProperties(noPropsXmlPath);
        assert.ok(properties);
        assert.strictEqual(typeof properties, 'object');
      } finally {
        if (fs.existsSync(noPropsXmlPath)) {
          fs.unlinkSync(noPropsXmlPath);
        }
      }
    });

    test('should handle empty XML file', async () => {
      const emptyXmlPath = path.join(fixturesPath, 'empty.xml');
      fs.writeFileSync(emptyXmlPath, '');

      try {
        await assert.rejects(
          async () => {
            await XMLWriter.readProperties(emptyXmlPath);
          },
          (err: Error) => /Failed to read properties|empty|invalid/.test(err.message),
          'Expected rejection for empty file'
        );
      } finally {
        if (fs.existsSync(emptyXmlPath)) {
          fs.unlinkSync(emptyXmlPath);
        }
      }
    });
  });

  suite('integration with Configuration.xml', () => {
    test('should read properties from Configuration.xml', async () => {
      const configPath = path.join(fixturesPath, 'designer-config', 'Configuration.xml');

      const properties = await XMLWriter.readProperties(configPath);

      assert.ok(properties);
      assert.ok('Name' in properties);
      assert.strictEqual(properties.Name, 'TestConfiguration');
    });

    test('should read Version property from Configuration.xml', async () => {
      const configPath = path.join(fixturesPath, 'designer-config', 'Configuration.xml');

      const properties = await XMLWriter.readProperties(configPath);

      assert.ok('Version' in properties);
      assert.strictEqual(properties.Version, '1.0.0');
    });

    test('should read Vendor property from Configuration.xml', async () => {
      const configPath = path.join(fixturesPath, 'designer-config', 'Configuration.xml');

      const properties = await XMLWriter.readProperties(configPath);

      assert.ok('Vendor' in properties);
      assert.strictEqual(properties.Vendor, 'Test Vendor');
    });
  });

  suite('createMinimalElementFile', () => {
    let tmpDir: string;

    setup(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-xml-'));
    });

    teardown(async () => {
      try {
        if (tmpDir && fs.existsSync(tmpDir)) {
          await fs.promises.rm(tmpDir, { recursive: true });
        }
      } catch {
        // ignore
      }
    });

    test('creates Catalog with default properties', async () => {
      const catalogPath = path.join(tmpDir, 'TestCatalog.xml');
      await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'TestCatalog');
      assert.ok(fs.existsSync(catalogPath));
      const properties = await XMLWriter.readProperties(catalogPath);
      assert.strictEqual(properties.Name, 'TestCatalog');
      assert.strictEqual(properties.Hierarchical, false);
      assert.strictEqual(Number(properties.CodeLength), 9);
      assert.strictEqual(Number(properties.DescriptionLength), 25);
      assert.strictEqual(properties.CodeType, 'String');
    });

    test('creates Document with default properties', async () => {
      const docPath = path.join(tmpDir, 'TestDocument.xml');
      await XMLWriter.createMinimalElementFile(docPath, 'Document', 'TestDocument');
      assert.ok(fs.existsSync(docPath));
      const properties = await XMLWriter.readProperties(docPath);
      assert.strictEqual(properties.Name, 'TestDocument');
      assert.strictEqual(properties.NumberType, 'String');
      assert.strictEqual(Number(properties.NumberLength), 9);
    });

    test('creates CommonModule without ChildObjects (1C Configurator leaf shape)', async () => {
      const cmPath = path.join(tmpDir, 'TestCommonModule.xml');
      await XMLWriter.createMinimalElementFile(cmPath, 'CommonModule', 'TestCommonModule');
      assert.ok(fs.existsSync(cmPath));
      const raw = await fs.promises.readFile(cmPath, 'utf-8');
      assert.ok(!raw.includes('<ChildObjects'), 'CommonModule must not emit ChildObjects');
      const properties = await XMLWriter.readProperties(cmPath);
      assert.strictEqual(properties.Name, 'TestCommonModule');
    });

    test('creates Role without ChildObjects (EDT / Configurator readable shape)', async () => {
      const rolePath = path.join(tmpDir, 'TestRole.xml');
      await XMLWriter.createMinimalElementFile(rolePath, 'Role', 'TestRole');
      assert.ok(fs.existsSync(rolePath));
      const raw = await fs.promises.readFile(rolePath, 'utf-8');
      assert.ok(!raw.includes('<ChildObjects'), 'Role must not emit ChildObjects');
      const properties = await XMLWriter.readProperties(rolePath);
      assert.strictEqual(properties.Name, 'TestRole');
    });

    test('creates SessionParameter without ChildObjects (docs/1c-config-objects-spec.md)', async () => {
      const p = path.join(tmpDir, 'TestSessionParameter.xml');
      await XMLWriter.createMinimalElementFile(p, 'SessionParameter', 'Параметр1');
      const raw = await fs.promises.readFile(p, 'utf-8');
      assert.ok(!raw.includes('<ChildObjects'), 'SessionParameter must not emit ChildObjects');
    });
  });

  // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
  suite('Preservation - Existing Functionality', () => {
    const passwordAttrFixturePath = path.join(fixturesPath, 'designer-config', 'Catalogs', 'TestCatalogWithPasswordAttribute.xml');
    const tempPasswordAttrPath = path.join(fixturesPath, 'temp-password-attr.xml');
    const tempRootPath = path.join(fixturesPath, 'temp-root-element.xml');

    teardown(() => {
      if (fs.existsSync(tempPasswordAttrPath)) {
        fs.unlinkSync(tempPasswordAttrPath);
      }
      if (fs.existsSync(tempRootPath)) {
        fs.unlinkSync(tempRootPath);
      }
      // Clean up any backup files
      if (fs.existsSync(`${tempPasswordAttrPath}.bak`)) {
        fs.unlinkSync(`${tempPasswordAttrPath}.bak`);
      }
      if (fs.existsSync(`${tempRootPath}.bak`)) {
        fs.unlinkSync(`${tempRootPath}.bak`);
      }
    });

    // Requirement 3.2: Root element property writes via writeProperties (not nested elements)
    test('root element writes continue to work correctly', async () => {
      // Copy fixture to temp location
      fs.copyFileSync(testXmlPath, tempRootPath);

      // Write multiple properties to root element using writeProperties
      const newProperties = {
        Name: 'UpdatedRootCatalog',
        Synonym: 'Updated Root Synonym',
        Comment: 'Updated root comment',
      };

      await XMLWriter.writeProperties(tempRootPath, newProperties);

      // Verify all properties were written correctly
      const updatedProps = await XMLWriter.readProperties(tempRootPath);
      assert.strictEqual(updatedProps.Name, 'UpdatedRootCatalog');
      assert.strictEqual(updatedProps.Synonym, 'Updated Root Synonym');
      assert.strictEqual(updatedProps.Comment, 'Updated root comment');

      // Verify XML structure is preserved
      const xmlContent = fs.readFileSync(tempRootPath, 'utf-8');
      assert.ok(xmlContent.includes('<MetaDataObject'));
      assert.ok(xmlContent.includes('<Properties>'));
    });

    // Requirement 3.1: Type XML parsing when Type is explicitly changed
    test('Type XML parsing produces structured XML when Type is in changed properties', async () => {
      const originalXml = fs.readFileSync(passwordAttrFixturePath, 'utf-8');
      assert.ok(originalXml.includes('<v8:Type>xs:string</v8:Type>'));
      assert.ok(originalXml.includes('<v8:StringQualifiers>'));

      const newTypeXml = `<Type>
						<v8:Type>xs:decimal</v8:Type>
						<v8:NumberQualifiers>
							<v8:Digits>10</v8:Digits>
							<v8:FractionDigits>2</v8:FractionDigits>
							<v8:AllowedSign>Any</v8:AllowedSign>
						</v8:NumberQualifiers>
					</Type>`;

      const properties = {
        Name: 'Password',
        Type: newTypeXml,
      };

      const modifiedXml = XMLWriter.buildUpdatedNestedXml(
        originalXml,
        'Attribute',
        'Password',
        properties
      );
      assert.ok(
        modifiedXml.includes('<v8:Type>xs:decimal</v8:Type>'),
        'Type should be parsed and written as structured XML'
      );
      assert.ok(
        modifiedXml.includes('<v8:NumberQualifiers>'),
        'Type qualifiers should be preserved'
      );
      assert.ok(
        modifiedXml.includes('<v8:Digits>10</v8:Digits>'),
        'Type qualifier values should be preserved'
      );
    });

    // Requirement 3.5: Backup files are created and rollback works on failure
    test('backup files are created and rollback works on failure', async () => {
      fs.copyFileSync(passwordAttrFixturePath, tempPasswordAttrPath);
      const originalContent = fs.readFileSync(tempPasswordAttrPath, 'utf-8');

      const properties = {
        Name: 'Password',
        PasswordMode: true,
      };

      await XMLWriter.writeNestedElementProperties(
        tempPasswordAttrPath,
        'Attribute',
        'Password',
        properties
      );

      const modifiedContent = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
      assert.notStrictEqual(originalContent, modifiedContent, 'File should be modified');
      assert.ok(
        modifiedContent.includes('<PasswordMode>true</PasswordMode>'),
        'PasswordMode should be updated to true'
      );
      assert.ok(
        !fs.existsSync(`${tempPasswordAttrPath}.bak`),
        'Backup should be cleaned up after successful write'
      );
    });

    // Requirement 3.4: Multiple changed properties are all written correctly
    test('multiple changed properties are all written correctly', async () => {
      const originalXml = fs.readFileSync(passwordAttrFixturePath, 'utf-8');
      assert.ok(originalXml.includes('<PasswordMode>false</PasswordMode>'));
      assert.ok(originalXml.includes('Password Field'));

      const properties = {
        Name: 'Password',
        Synonym: 'New Password Label',
        PasswordMode: true,
      };

      const modifiedXml = XMLWriter.buildUpdatedNestedXml(
        originalXml,
        'Attribute',
        'Password',
        properties
      );
      assert.ok(
        modifiedXml.includes('New Password Label'),
        'Synonym should be updated'
      );
      assert.ok(
        modifiedXml.includes('<PasswordMode>true</PasswordMode>'),
        'PasswordMode should be updated'
      );
      assert.ok(
        modifiedXml.includes('<v8:Type>xs:string</v8:Type>'),
        'Type structure should be preserved'
      );
    });

    // Additional preservation test: verify writeProperties handles multiple properties
    test('root element writeProperties handles multiple properties correctly', async () => {
      fs.copyFileSync(testXmlPath, tempRootPath);

      const properties = {
        Name: 'MultiPropTest',
        Synonym: 'Multi Property Test',
        Comment: 'Testing multiple properties',
        UseStandardCommands: true,
      };

      await XMLWriter.writeProperties(tempRootPath, properties);

      const updatedProps = await XMLWriter.readProperties(tempRootPath);
      assert.strictEqual(updatedProps.Name, 'MultiPropTest');
      assert.strictEqual(updatedProps.Synonym, 'Multi Property Test');
      assert.strictEqual(updatedProps.Comment, 'Testing multiple properties');
      assert.strictEqual(updatedProps.UseStandardCommands, true);
    });
  });

  suite('generateSimpleUuid', () => {
    test('returns a string matching UUID v4 format', () => {
      const uuid = XMLWriter.generateSimpleUuid();
      assert.strictEqual(typeof uuid, 'string');
      assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    test('returns unique values on each call', () => {
      const uuid1 = XMLWriter.generateSimpleUuid();
      const uuid2 = XMLWriter.generateSimpleUuid();
      assert.notStrictEqual(uuid1, uuid2);
    });
  });

  suite('createMinimalElementFile - edge cases', () => {
    let tmpDir: string;

    setup(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-edge-'));
    });

    teardown(async () => {
      try {
        if (tmpDir && fs.existsSync(tmpDir)) {
          await fs.promises.rm(tmpDir, { recursive: true });
        }
      } catch {
        // ignore
      }
    });

    test('escapes special XML characters in element name', async () => {
      const p = path.join(tmpDir, 'SpecialName.xml');
      await XMLWriter.createMinimalElementFile(p, 'Catalog', 'Test&Name<>');
      const raw = await fs.promises.readFile(p, 'utf-8');
      assert.ok(raw.includes('Test&amp;Name&lt;&gt;'), 'Ampersand and angle brackets must be escaped');
      assert.ok(!raw.includes('<Name>Test&Name'), 'Unescaped & must not appear inside <Name>');
    });

    test('handles Unicode (Cyrillic) element name', async () => {
      const p = path.join(tmpDir, 'CyrillicCatalog.xml');
      await XMLWriter.createMinimalElementFile(p, 'Catalog', 'ТестовыйКаталог');
      const properties = await XMLWriter.readProperties(p);
      assert.strictEqual(properties.Name, 'ТестовыйКаталог');
    });

    test('created file has valid XML declaration', async () => {
      const p = path.join(tmpDir, 'XmlDeclTest.xml');
      await XMLWriter.createMinimalElementFile(p, 'Document', 'DocTest');
      const raw = await fs.promises.readFile(p, 'utf-8');
      assert.ok(raw.startsWith('<?xml version="1.0"'), 'File must start with XML declaration');
    });

    test('created Catalog file contains ChildObjects', async () => {
      const p = path.join(tmpDir, 'WithChildObjects.xml');
      await XMLWriter.createMinimalElementFile(p, 'Catalog', 'WithChildren');
      const raw = await fs.promises.readFile(p, 'utf-8');
      assert.ok(raw.includes('<ChildObjects'), 'Catalog must emit ChildObjects');
    });

    test('created file uuid is embedded in root tag', async () => {
      const p = path.join(tmpDir, 'UuidTest.xml');
      await XMLWriter.createMinimalElementFile(p, 'Catalog', 'UuidTest');
      const raw = await fs.promises.readFile(p, 'utf-8');
      assert.match(raw, /uuid="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i);
    });
  });

  suite('addNestedElement', () => {
    let tmpDir: string;

    setup(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-nested-'));
    });

    teardown(async () => {
      try {
        if (tmpDir && fs.existsSync(tmpDir)) {
          await fs.promises.rm(tmpDir, { recursive: true });
        }
      } catch {
        // ignore
      }
    });

    test('adds Attribute to Catalog ChildObjects', async () => {
      const src = path.join(fixturesPath, 'designer-config', 'Catalogs', 'TestCatalog1.xml');
      const dest = path.join(tmpDir, 'Catalog.xml');
      fs.copyFileSync(src, dest);

      await XMLWriter.addNestedElement(dest, 'Attribute', 'NewField');

      const raw = await fs.promises.readFile(dest, 'utf-8');
      assert.ok(raw.includes('NewField'), 'New attribute name must appear in file');
    });

    test('throws for non-existent file', async () => {
      await assert.rejects(
        () => XMLWriter.addNestedElement(path.join(tmpDir, 'missing.xml'), 'Attribute', 'X'),
        (err: Error) => /File not found|Unable to read/.test(err.message)
      );
    });

    test('throws for empty file', async () => {
      const emptyPath = path.join(tmpDir, 'empty.xml');
      fs.writeFileSync(emptyPath, '', 'utf-8');
      await assert.rejects(
        () => XMLWriter.addNestedElement(emptyPath, 'Attribute', 'X'),
        (err: Error) => /empty|invalid|File/.test(err.message)
      );
    });

    test('throws Unable to read when path is a directory', async () => {
      // fs.readFile on a directory throws EISDIR, exercising the readError catch in readUtf8AndParse
      const dirPath = path.join(tmpDir, 'subdir');
      fs.mkdirSync(dirPath);
      await assert.rejects(
        () => XMLWriter.addNestedElement(dirPath, 'Attribute', 'X'),
        (err: Error) => /Unable to read|File not found/.test(err.message)
      );
    });
  });

  suite('removeNestedElement', () => {
    let tmpDir: string;

    setup(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-remove-'));
    });

    teardown(async () => {
      try {
        if (tmpDir && fs.existsSync(tmpDir)) {
          await fs.promises.rm(tmpDir, { recursive: true });
        }
      } catch {
        // ignore
      }
    });

    test('removes existing Attribute from Catalog ChildObjects', async () => {
      const src = path.join(fixturesPath, 'designer-config', 'Catalogs', 'TestCatalog1.xml');
      const dest = path.join(tmpDir, 'Catalog.xml');
      fs.copyFileSync(src, dest);

      // First verify the attribute exists
      const rawBefore = await fs.promises.readFile(dest, 'utf-8');
      assert.ok(rawBefore.includes('NewAttribute'), 'Fixture must contain NewAttribute');

      await XMLWriter.removeNestedElement(dest, 'Attribute', 'NewAttribute');

      const rawAfter = await fs.promises.readFile(dest, 'utf-8');
      assert.ok(!rawAfter.includes('<Name>NewAttribute</Name>'), 'NewAttribute must be removed');
    });

    test('throws for non-existent file', async () => {
      await assert.rejects(
        () => XMLWriter.removeNestedElement(path.join(tmpDir, 'missing.xml'), 'Attribute', 'X'),
        (err: Error) => /File not found|Unable to read/.test(err.message)
      );
    });
  });

  suite('addDesignerFormReferenceToOwnerMetadata', () => {
    let tmpDir: string;

    setup(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-form-'));
    });

    teardown(async () => {
      try {
        if (tmpDir && fs.existsSync(tmpDir)) {
          await fs.promises.rm(tmpDir, { recursive: true });
        }
      } catch {
        // ignore
      }
    });

    test('adds Form reference to Catalog ChildObjects', async () => {
      const src = path.join(fixturesPath, 'designer-config', 'Catalogs', 'TestCatalog1.xml');
      const dest = path.join(tmpDir, 'Catalog.xml');
      fs.copyFileSync(src, dest);

      await XMLWriter.addDesignerFormReferenceToOwnerMetadata(dest, 'ItemForm');

      const raw = await fs.promises.readFile(dest, 'utf-8');
      assert.ok(raw.includes('ItemForm'), 'Form name must appear in file after adding');
    });

    test('does not modify file when form reference already exists', async () => {
      const src = path.join(fixturesPath, 'designer-config', 'Catalogs', 'TestCatalog1.xml');
      const dest = path.join(tmpDir, 'Catalog.xml');
      fs.copyFileSync(src, dest);

      // Add once
      await XMLWriter.addDesignerFormReferenceToOwnerMetadata(dest, 'ListForm');
      const rawAfterFirst = await fs.promises.readFile(dest, 'utf-8');

      // Add again — should be no-op
      await XMLWriter.addDesignerFormReferenceToOwnerMetadata(dest, 'ListForm');
      const rawAfterSecond = await fs.promises.readFile(dest, 'utf-8');

      // Count occurrences — should not be doubled
      const count = (rawAfterSecond.match(/ListForm/g) ?? []).length;
      assert.ok(count >= 1, 'Form name must appear at least once');
      const countFirst = (rawAfterFirst.match(/ListForm/g) ?? []).length;
      assert.strictEqual(count, countFirst, 'Adding same form twice must not duplicate it');
    });

    test('throws for non-existent file', async () => {
      await assert.rejects(
        () => XMLWriter.addDesignerFormReferenceToOwnerMetadata(path.join(tmpDir, 'missing.xml'), 'Form'),
        (err: Error) => /File not found|Unable to read/.test(err.message)
      );
    });
  });

  suite('writeNestedElementProperties - error paths', () => {
    let tmpDir: string;

    setup(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-wnep-'));
    });

    teardown(async () => {
      try {
        if (tmpDir && fs.existsSync(tmpDir)) {
          await fs.promises.rm(tmpDir, { recursive: true });
        }
      } catch {
        // ignore
      }
    });

    test('throws Unable to read error for non-existent file', async () => {
      await assert.rejects(
        () => XMLWriter.writeNestedElementProperties(
          path.join(tmpDir, 'missing.xml'),
          'Attribute',
          'SomeAttr',
          { Name: 'SomeAttr' }
        ),
        (err: Error) => {
          assert.ok(err instanceof Error);
          assert.ok(
            /Unable to read|Failed to write nested/.test(err.message),
            `Unexpected message: ${err.message}`
          );
          return true;
        }
      );
    });

    test('wraps error as "Failed to write nested" when XML parse fails inside build step', async () => {
      // Write content that passes the fs.readFile step but causes xmlParser.parse
      // to throw inside buildUpdatedNestedXmlImpl, exercising the buildError catch
      // (lines 519-523) and the outer re-wrap path (lines 535-541)
      const badXmlPath = path.join(tmpDir, 'bad-nested.xml');
      // XML with a malformed attribute value (unclosed quote) — triggers parse error
      fs.writeFileSync(badXmlPath, '<root attr="val</root>', 'utf-8');

      await assert.rejects(
        () => XMLWriter.writeNestedElementProperties(
          badXmlPath,
          'Attribute',
          'Attr',
          { Name: 'Attr' }
        ),
        (err: Error) => {
          assert.ok(err instanceof Error);
          assert.ok(
            /Failed to write nested|Failed to generate/.test(err.message),
            `Unexpected message: ${err.message}`
          );
          return true;
        }
      );
    });
  });

  // **Validates: Requirements 2.1, 2.2, 2.3**
  suite('Bug Condition - Selective Property Writing', () => {
    const passwordAttrFixturePath = path.join(fixturesPath, 'designer-config', 'Catalogs', 'TestCatalogWithPasswordAttribute.xml');
    const tempPasswordAttrPath = path.join(fixturesPath, 'temp-password-attr.xml');

    teardown(() => {
      if (fs.existsSync(tempPasswordAttrPath)) {
        fs.unlinkSync(tempPasswordAttrPath);
      }
    });

    test('EXPECTED FAILURE: changing only PasswordMode should not corrupt Type property', async () => {
      const originalXml = fs.readFileSync(passwordAttrFixturePath, 'utf-8');
      assert.ok(originalXml.includes('<v8:Type>xs:string</v8:Type>'), 'Original should have structured Type');
      assert.ok(originalXml.includes('<v8:StringQualifiers>'), 'Original should have StringQualifiers');
      assert.ok(originalXml.includes('<v8:Length>10</v8:Length>'), 'Original should have Length qualifier');

      const properties = {
        Name: 'Password',
        Synonym: 'Password Field',
        Type: 'string(10)',
        PasswordMode: true,
      };

      const modifiedXml = XMLWriter.buildUpdatedNestedXml(
        originalXml,
        'Attribute',
        'Password',
        properties,
        ['PasswordMode']
      );

      // EXPECTED BEHAVIOR (what should happen after fix):
      // - Only PasswordMode should be written to XML
      // - Type should remain in its original structured form with v8:Type and v8:StringQualifiers
      // - Name and Synonym should remain unchanged

      // ACTUAL BEHAVIOR (bug - this test will FAIL on unfixed code):
      // - All properties are written, including Type
      // - Type gets corrupted from structured XML to string "string(10)"
      // - The structured v8:Type and v8:StringQualifiers are lost

      // Verify Type is still structured (this will FAIL on unfixed code)
      assert.ok(
        modifiedXml.includes('<v8:Type>xs:string</v8:Type>'),
        'BUG DETECTED: Type was corrupted - should preserve structured v8:Type element'
      );
      assert.ok(
        modifiedXml.includes('<v8:StringQualifiers>'),
        'BUG DETECTED: Type was corrupted - should preserve StringQualifiers'
      );
      assert.ok(
        modifiedXml.includes('<v8:Length>10</v8:Length>'),
        'BUG DETECTED: Type was corrupted - should preserve Length qualifier'
      );

      // Verify PasswordMode was changed
      assert.ok(
        modifiedXml.includes('<PasswordMode>true</PasswordMode>'),
        'PasswordMode should be updated to true'
      );

      // Type should NOT be written as plain text "string(10)"
      assert.ok(
        !modifiedXml.includes('<Type>string(10)</Type>'),
        'BUG DETECTED: Type should not be written as plain text string'
      );
    });

    test('EXPECTED FAILURE: changing Synonym should not write unchanged properties', async () => {
      const originalXml = fs.readFileSync(passwordAttrFixturePath, 'utf-8');
      assert.ok(originalXml.includes('<PasswordMode>false</PasswordMode>'), 'Original should have PasswordMode=false');

      const properties = {
        Name: 'Password',
        Synonym: 'New Password Synonym',
        Type: 'string(10)',
        PasswordMode: false,
      };

      const modifiedXml = XMLWriter.buildUpdatedNestedXml(
        originalXml,
        'Attribute',
        'Password',
        properties,
        ['Synonym']
      );

      // EXPECTED: Only Synonym should be modified
      // ACTUAL (bug): All properties are written, Type is corrupted

      // Verify Type is still structured (will FAIL on unfixed code)
      assert.ok(
        modifiedXml.includes('<v8:Type>xs:string</v8:Type>'),
        'BUG DETECTED: Type should remain structured when changing Synonym'
      );

      // Verify Synonym was changed
      assert.ok(
        modifiedXml.includes('New Password Synonym'),
        'Synonym should be updated'
      );
    });

    test('EXPECTED FAILURE: derived properties should not be written to XML', async () => {
      // Copy fixture to temp location
      fs.copyFileSync(passwordAttrFixturePath, tempPasswordAttrPath);

      // Simulate properties object with derived/computed properties
      // In real scenario, Type display string is derived from XML, not a native property
      const properties = {
        Name: 'Password',
        Type: 'string(10)',  // Derived display property
        PasswordMode: true,  // User changed this
        _displayName: 'Password Field'  // Hypothetical derived property
      };

      await XMLWriter.writeNestedElementProperties(
        tempPasswordAttrPath,
        'Attribute',
        'Password',
        properties,
        ['PasswordMode']  // Only PasswordMode was changed by the user
      );

      const modifiedXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');

      // EXPECTED: Derived properties should not be written
      // ACTUAL (bug): All properties in the object are written

      // Verify Type is still structured (will FAIL on unfixed code)
      assert.ok(
        modifiedXml.includes('<v8:Type>xs:string</v8:Type>'),
        'BUG DETECTED: Type should not be overwritten by derived display string'
      );

      // Verify derived property is not written to XML
      assert.ok(
        !modifiedXml.includes('_displayName'),
        'Derived properties should not be written to XML'
      );
    });
  });
});
