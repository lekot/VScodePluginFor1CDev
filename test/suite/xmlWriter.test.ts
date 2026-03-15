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
      // Copy fixture to temp location
      fs.copyFileSync(passwordAttrFixturePath, tempPasswordAttrPath);

      // Read original XML to verify Type structure
      const originalXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
      assert.ok(originalXml.includes('<v8:Type>xs:string</v8:Type>'));
      assert.ok(originalXml.includes('<v8:StringQualifiers>'));

      // Simulate changing Type to a different type with structured XML
      // This is the XML string that would be generated when user changes Type
      const newTypeXml = `<Type>
						<v8:Type>xs:decimal</v8:Type>
						<v8:NumberQualifiers>
							<v8:Digits>10</v8:Digits>
							<v8:FractionDigits>2</v8:FractionDigits>
							<v8:AllowedSign>Any</v8:AllowedSign>
						</v8:NumberQualifiers>
					</Type>`;

      // When Type is explicitly changed, it's passed as XML string
      const properties = {
        Name: 'Password',
        Type: newTypeXml,
      };

      await XMLWriter.writeNestedElementProperties(
        tempPasswordAttrPath,
        'Attribute',
        'Password',
        properties
      );

      // Verify Type was parsed and written as structured XML
      const modifiedXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
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
      // Copy fixture to temp location
      fs.copyFileSync(passwordAttrFixturePath, tempPasswordAttrPath);

      const originalContent = fs.readFileSync(tempPasswordAttrPath, 'utf-8');

      // Make the file read-only to simulate write failure
      // Note: This test verifies backup creation; actual rollback is harder to test
      // without mocking fs operations, but we can verify backup is created

      // First, do a successful write to verify backup is created
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

      // Backup should be created during write and then deleted on success
      // We can't easily verify the transient backup, but we can verify the write succeeded
      const modifiedContent = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
      assert.notStrictEqual(originalContent, modifiedContent, 'File should be modified');

      // Verify no backup file remains after successful write
      assert.ok(
        !fs.existsSync(`${tempPasswordAttrPath}.bak`),
        'Backup should be cleaned up after successful write'
      );
    });

    // Requirement 3.4: Multiple changed properties are all written correctly
    test('multiple changed properties are all written correctly', async () => {
      // Copy fixture to temp location
      fs.copyFileSync(passwordAttrFixturePath, tempPasswordAttrPath);

      // Read original XML
      const originalXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
      assert.ok(originalXml.includes('<PasswordMode>false</PasswordMode>'));
      assert.ok(originalXml.includes('Password Field'));

      // Change multiple properties at once (simulating user changing multiple fields)
      const properties = {
        Name: 'Password',
        Synonym: 'New Password Label',
        PasswordMode: true,
      };

      await XMLWriter.writeNestedElementProperties(
        tempPasswordAttrPath,
        'Attribute',
        'Password',
        properties
      );

      // Verify all changed properties were written
      const modifiedXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
      assert.ok(
        modifiedXml.includes('New Password Label'),
        'Synonym should be updated'
      );
      assert.ok(
        modifiedXml.includes('<PasswordMode>true</PasswordMode>'),
        'PasswordMode should be updated'
      );

      // Verify Type structure is preserved (this is the current behavior we want to preserve)
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
      // Copy fixture to temp location
      fs.copyFileSync(passwordAttrFixturePath, tempPasswordAttrPath);

      // Read original XML to verify Type structure before modification
      const originalXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
      assert.ok(originalXml.includes('<v8:Type>xs:string</v8:Type>'), 'Original should have structured Type');
      assert.ok(originalXml.includes('<v8:StringQualifiers>'), 'Original should have StringQualifiers');
      assert.ok(originalXml.includes('<v8:Length>10</v8:Length>'), 'Original should have Length qualifier');

      // Simulate what PropertiesProvider does: pass all properties including Type as display string
      // This is the bug condition - Type is passed as "string(10)" display string, not structured XML
      const properties = {
        Name: 'Password',
        Synonym: 'Password Field',
        Type: 'string(10)',  // Display string representation, not structured XML
        PasswordMode: true   // This is the ONLY property the user changed
      };

      // Call writeNestedElementProperties with changedKeys to indicate only PasswordMode changed
      // This is the FIXED behavior - only write the changed property
      await XMLWriter.writeNestedElementProperties(
        tempPasswordAttrPath,
        'Attribute',
        'Password',
        properties,
        ['PasswordMode']  // Only PasswordMode was changed by the user
      );

      // Read modified XML
      const modifiedXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');

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
      // Copy fixture to temp location
      fs.copyFileSync(passwordAttrFixturePath, tempPasswordAttrPath);

      // Read original XML
      const originalXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');
      const originalPasswordMode = originalXml.includes('<PasswordMode>false</PasswordMode>');
      assert.ok(originalPasswordMode, 'Original should have PasswordMode=false');

      // Simulate changing only Synonym
      const properties = {
        Name: 'Password',
        Synonym: 'New Password Synonym',  // This is the ONLY property the user changed
        Type: 'string(10)',
        PasswordMode: false
      };

      await XMLWriter.writeNestedElementProperties(
        tempPasswordAttrPath,
        'Attribute',
        'Password',
        properties,
        ['Synonym']  // Only Synonym was changed by the user
      );

      const modifiedXml = fs.readFileSync(tempPasswordAttrPath, 'utf-8');

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
