import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
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
        {
          message: /File not found/,
        }
      );
    });

    test('should throw error for invalid XML', async () => {
      const invalidXmlPath = path.join(fixturesPath, 'invalid.xml');
      fs.writeFileSync(invalidXmlPath, '<?xml version="1.0"?><root><item>test</root>');

      try {
        await assert.rejects(
          async () => {
            await XMLWriter.readProperties(invalidXmlPath);
          },
          {
            message: /Failed to read properties/,
          }
        );
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
        {
          message: /Failed to write properties/,
        }
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
          {
            message: /Failed to read properties/,
          }
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
});
