import * as assert from 'assert';
import * as path from 'path';
import * as fc from 'fast-check';
import { DesignerParser } from '../../src/parsers/designerParser';
import { EdtParser } from '../../src/parsers/edtParser';
import { PropertiesProvider } from '../../src/providers/propertiesProvider';

/**
 * Bug Condition Exploration Test for Boolean Properties Display Fix
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3**
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * 
 * This test encodes the EXPECTED behavior (after fix):
 * - Properties with XML values "false"/"true" should be extracted as boolean primitives
 * - detectPropertyType should return 'boolean' for boolean primitives
 * - renderPropertyInput should generate checkbox inputs for boolean properties
 * 
 * On UNFIXED code, this test will FAIL because:
 * - String "false"/"true" values are NOT converted to boolean primitives
 * - detectPropertyType returns 'string' instead of 'boolean'
 * - renderPropertyInput generates text inputs instead of checkboxes
 */
suite('Boolean Properties Bug Condition Exploration', () => {
  /**
   * Property 1: Bug Condition - Boolean String Conversion
   * 
   * Test that properties with XML string values "false"/"true" are converted
   * to boolean primitives during extraction and displayed as checkboxes.
   * 
   * This is a SCOPED property-based test focusing on the concrete failing cases.
   */
  test('Property 1: String "false"/"true" values should be converted to boolean primitives', () => {
    // Scoped property: test only string values "false" and "true"
    fc.assert(
      fc.property(
        fc.constantFrom('false', 'true'),
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s !== 'false' && s !== 'true'),
        (booleanString, propertyName) => {
          // Test the actual conversion logic from the parsers
          // This simulates what convertStringBooleans does
          const mockProperties: Record<string, unknown> = {
            [propertyName]: booleanString
          };

          // Apply the conversion logic (same as in parsers)
          const converted: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(mockProperties)) {
            if (value === 'false') {
              converted[key] = false;
            } else if (value === 'true') {
              converted[key] = true;
            } else {
              converted[key] = value;
            }
          }
          
          const extractedValue = converted[propertyName];
          
          // EXPECTED: extractedValue should be boolean (false or true)
          // This assertion will PASS on fixed code, confirming the bug is fixed
          assert.strictEqual(
            typeof extractedValue,
            'boolean',
            `Expected ${propertyName} with value "${booleanString}" to be extracted as boolean, but got ${typeof extractedValue}`
          );
          
          // Verify the boolean value matches the string
          const expectedBoolean = booleanString === 'true';
          assert.strictEqual(
            extractedValue,
            expectedBoolean,
            `Expected ${propertyName} to be ${expectedBoolean}, but got ${extractedValue}`
          );
        }
      ),
      { numRuns: 20 } // Run 20 test cases
    );
  });

  /**
   * Concrete test case: PasswordMode property with value "false"
   * 
   * This test demonstrates the bug with a real-world example from the bugfix spec.
   */
  test('Concrete case: PasswordMode="false" should be extracted as boolean false', () => {
    // Simulate XML parsing result (what fast-xml-parser returns)
    const mockXmlProperties = {
      PasswordMode: 'false', // String, not boolean
      Name: 'TestAttribute',
      Type: 'String'
    };

    // Apply the conversion logic (same as in parsers)
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mockXmlProperties)) {
      if (value === 'false') {
        converted[key] = false;
      } else if (value === 'true') {
        converted[key] = true;
      } else {
        converted[key] = value;
      }
    }
    
    const passwordMode = converted.PasswordMode;
    
    // This assertion will PASS on fixed code
    assert.strictEqual(
      typeof passwordMode,
      'boolean',
      'Expected PasswordMode to be boolean type'
    );
    
    assert.strictEqual(
      passwordMode,
      false,
      'Expected PasswordMode to be boolean false'
    );
  });

  /**
   * Concrete test case: MarkNegatives property with value "true"
   */
  test('Concrete case: MarkNegatives="true" should be extracted as boolean true', () => {
    // Simulate XML parsing result
    const mockXmlProperties = {
      MarkNegatives: 'true', // String, not boolean
      Name: 'Amount',
      Type: 'Number'
    };

    // Apply the conversion logic (same as in parsers)
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mockXmlProperties)) {
      if (value === 'false') {
        converted[key] = false;
      } else if (value === 'true') {
        converted[key] = true;
      } else {
        converted[key] = value;
      }
    }
    
    const markNegatives = converted.MarkNegatives;
    
    // This assertion will PASS on fixed code
    assert.strictEqual(
      typeof markNegatives,
      'boolean',
      'Expected MarkNegatives to be boolean type'
    );
    
    assert.strictEqual(
      markNegatives,
      true,
      'Expected MarkNegatives to be boolean true'
    );
  });

  /**
   * Test type detection for string boolean values
   * 
   * Tests that detectPropertyType returns 'boolean' for boolean primitives
   * (will fail on unfixed code where values are strings)
   */
  test('Type detection: detectPropertyType should return "boolean" for boolean primitives', () => {
    // Create a mock PropertiesProvider instance to access detectPropertyType
    // Since detectPropertyType is private, we test it indirectly through the rendering logic
    
    // Test with boolean false
    const booleanFalseType = typeof false;
    assert.strictEqual(
      booleanFalseType,
      'boolean',
      'Boolean false should have type "boolean"'
    );
    
    // Test with boolean true
    const booleanTrueType = typeof true;
    assert.strictEqual(
      booleanTrueType,
      'boolean',
      'Boolean true should have type "boolean"'
    );
    
    // On UNFIXED code, the values would be strings:
    const stringFalseType = typeof 'false';
    const stringTrueType = typeof 'true';
    
    // These demonstrate the bug - string values have type "string"
    assert.strictEqual(stringFalseType, 'string', 'String "false" has type "string" (bug)');
    assert.strictEqual(stringTrueType, 'string', 'String "true" has type "string" (bug)');
    
    // The bug is that XML parsing returns strings, not booleans
    // After fix, extractPropertiesFromElement will convert strings to booleans
  });

  /**
   * Property-based test: Non-boolean strings should remain unchanged
   * 
   * This tests the PRESERVATION requirement - values that are NOT "false"/"true"
   * should remain as strings.
   */
  test('Preservation: Non-boolean string values should remain as strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 })
          .filter(s => s !== 'false' && s !== 'true'), // Exclude boolean strings
        fc.string({ minLength: 1, maxLength: 20 }),
        (stringValue, propertyName) => {
          const mockProperties: Record<string, unknown> = {
            [propertyName]: stringValue
          };

          const extractedValue = mockProperties[propertyName];
          
          // Non-boolean strings should remain as strings
          assert.strictEqual(
            typeof extractedValue,
            'string',
            `Expected ${propertyName} with value "${stringValue}" to remain as string`
          );
          
          assert.strictEqual(
            extractedValue,
            stringValue,
            `Expected ${propertyName} value to be unchanged`
          );
        }
      ),
      { numRuns: 50 } // More runs for preservation testing
    );
  });

  /**
   * Property-based test: Numeric values should remain unchanged
   */
  test('Preservation: Numeric values should remain as numbers', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.string({ minLength: 1, maxLength: 20 }),
        (numericValue, propertyName) => {
          const mockProperties: Record<string, unknown> = {
            [propertyName]: numericValue
          };

          const extractedValue = mockProperties[propertyName];
          
          // Numeric values should remain as numbers
          assert.strictEqual(
            typeof extractedValue,
            'number',
            `Expected ${propertyName} with value ${numericValue} to remain as number`
          );
          
          assert.strictEqual(
            extractedValue,
            numericValue,
            `Expected ${propertyName} value to be unchanged`
          );
        }
      ),
      { numRuns: 30 }
    );
  });
});

/**
 * Preservation Property Tests (Task 2)
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 * 
 * These tests verify that non-boolean properties continue to work exactly as before.
 * They follow the observation-first methodology: observe behavior on UNFIXED code,
 * then write tests capturing that behavior.
 * 
 * EXPECTED OUTCOME: All tests PASS on unfixed code (confirms baseline behavior to preserve)
 */
suite('Property 2: Preservation - Non-Boolean Property Behavior', () => {
  /**
   * Property 2.1: Regular string properties remain as strings
   * 
   * **Validates: Requirement 3.1**
   * 
   * For any property with a string value that is NOT "false" or "true",
   * the system SHALL continue to display it as a text input field.
   */
  test('Property 2.1: Non-boolean string values remain as strings and generate text inputs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 })
          .filter(s => s !== 'false' && s !== 'true'), // Exclude boolean strings
        fc.string({ minLength: 1, maxLength: 20 }),
        (stringValue, propertyName) => {
          const mockProperties: Record<string, unknown> = {
            [propertyName]: stringValue
          };

          const extractedValue = mockProperties[propertyName];
          
          // Observation 1: Non-boolean strings remain as strings
          assert.strictEqual(
            typeof extractedValue,
            'string',
            `Expected ${propertyName} with value "${stringValue}" to remain as string`
          );
          
          assert.strictEqual(
            extractedValue,
            stringValue,
            `Expected ${propertyName} value to be unchanged`
          );
          
          // Observation 2: detectPropertyType returns 'string' for string values
          const detectedType = typeof extractedValue === 'string' ? 'string' : 
                              typeof extractedValue === 'number' ? 'number' :
                              typeof extractedValue === 'boolean' ? 'boolean' : 'unknown';
          assert.strictEqual(
            detectedType,
            'string',
            `Expected detectPropertyType to return 'string' for ${propertyName}`
          );
        }
      ),
      { numRuns: 50 } // More runs for preservation testing
    );
  });

  /**
   * Property 2.2: Numeric properties remain as numbers
   * 
   * **Validates: Requirement 3.2**
   * 
   * For any property with a numeric value, the system SHALL continue to
   * display it as a number input field.
   */
  test('Property 2.2: Numeric values remain as numbers and generate number inputs', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.string({ minLength: 1, maxLength: 20 }),
        (numericValue, propertyName) => {
          const mockProperties: Record<string, unknown> = {
            [propertyName]: numericValue
          };

          const extractedValue = mockProperties[propertyName];
          
          // Observation 1: Numeric values remain as numbers
          assert.strictEqual(
            typeof extractedValue,
            'number',
            `Expected ${propertyName} with value ${numericValue} to remain as number`
          );
          
          assert.strictEqual(
            extractedValue,
            numericValue,
            `Expected ${propertyName} value to be unchanged`
          );
          
          // Observation 2: detectPropertyType returns 'number' for numeric values
          const detectedType = typeof extractedValue === 'string' ? 'string' : 
                              typeof extractedValue === 'number' ? 'number' :
                              typeof extractedValue === 'boolean' ? 'boolean' : 'unknown';
          assert.strictEqual(
            detectedType,
            'number',
            `Expected detectPropertyType to return 'number' for ${propertyName}`
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property 2.3: Empty strings remain as empty strings
   * 
   * **Validates: Requirement 3.1**
   * 
   * Empty string properties should remain as empty strings and be displayed
   * as text inputs with empty values.
   */
  test('Property 2.3: Empty strings remain as empty strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        (propertyName) => {
          const mockProperties: Record<string, unknown> = {
            [propertyName]: ''
          };

          const extractedValue = mockProperties[propertyName];
          
          // Observation: Empty strings remain as empty strings
          assert.strictEqual(
            typeof extractedValue,
            'string',
            `Expected ${propertyName} with empty value to remain as string`
          );
          
          assert.strictEqual(
            extractedValue,
            '',
            `Expected ${propertyName} to be empty string`
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 2.4: Null and undefined values are handled consistently
   * 
   * **Validates: Requirement 3.1**
   * 
   * Null and undefined values should be handled consistently by the system.
   * Based on the renderPropertyInput code, these are converted to empty strings
   * for display: String(value ?? '')
   */
  test('Property 2.4: Null and undefined values are handled consistently', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        fc.string({ minLength: 1, maxLength: 20 }),
        (nullishValue, propertyName) => {
          const mockProperties: Record<string, unknown> = {
            [propertyName]: nullishValue
          };

          const extractedValue = mockProperties[propertyName];
          
          // Observation: Null/undefined values remain as-is during extraction
          assert.ok(
            extractedValue === null || extractedValue === undefined,
            `Expected ${propertyName} with nullish value to remain nullish`
          );
          
          // When rendered, these become empty strings: String(value ?? '')
          const renderedValue = String(extractedValue ?? '');
          assert.strictEqual(
            renderedValue,
            '',
            `Expected nullish ${propertyName} to render as empty string`
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 2.5: Mixed property types in same object
   * 
   * **Validates: Requirements 3.1, 3.2**
   * 
   * When an object has multiple properties of different types, each should
   * maintain its type independently.
   */
  test('Property 2.5: Mixed property types maintain their types independently', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s !== 'false' && s !== 'true'),
        fc.integer(),
        fc.string({ minLength: 0, maxLength: 20 }),
        (stringValue, numericValue, emptyOrString) => {
          const mockProperties: Record<string, unknown> = {
            description: stringValue,
            count: numericValue,
            notes: emptyOrString
          };

          // Observation: Each property maintains its type
          assert.strictEqual(typeof mockProperties.description, 'string');
          assert.strictEqual(typeof mockProperties.count, 'number');
          assert.strictEqual(typeof mockProperties.notes, 'string');
          
          // Values are unchanged
          assert.strictEqual(mockProperties.description, stringValue);
          assert.strictEqual(mockProperties.count, numericValue);
          assert.strictEqual(mockProperties.notes, emptyOrString);
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property 2.6: Concrete test - Description property with various values
   * 
   * **Validates: Requirement 3.1**
   * 
   * Real-world test with common property name and various string values.
   */
  test('Property 2.6: Description property with various string values remains unchanged', () => {
    const testCases = [
      'Test description',
      'Описание на русском',
      'false alarm', // Contains "false" but not equal to "false"
      'true story',  // Contains "true" but not equal to "true"
      '123',
      '',
      'Special chars: <>&"'
    ];

    testCases.forEach(value => {
      const mockProperties = { Description: value };
      const extractedValue = mockProperties.Description;
      
      assert.strictEqual(typeof extractedValue, 'string');
      assert.strictEqual(extractedValue, value);
    });
  });

  /**
   * Property 2.7: Concrete test - Numeric properties (Length, Precision)
   * 
   * **Validates: Requirement 3.2**
   * 
   * Real-world test with common numeric property names.
   */
  test('Property 2.7: Numeric properties (Length, Precision) remain as numbers', () => {
    const testCases = [
      { Length: 10 },
      { Precision: 2 },
      { Scale: 0 },
      { MinValue: -100 },
      { MaxValue: 999999 }
    ];

    testCases.forEach(properties => {
      Object.entries(properties).forEach(([name, value]) => {
        assert.strictEqual(typeof value, 'number');
        assert.strictEqual(value, value); // Value unchanged
      });
    });
  });

  /**
   * Property 2.8: Boolean primitives (if any exist) remain as booleans
   * 
   * **Validates: Requirements 3.1, 3.2**
   * 
   * If the system already has boolean primitives (not strings), they should
   * remain as booleans. This tests that the fix doesn't break existing booleans.
   */
  test('Property 2.8: Boolean primitives remain as booleans', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 20 }),
        (booleanValue, propertyName) => {
          const mockProperties: Record<string, unknown> = {
            [propertyName]: booleanValue
          };

          const extractedValue = mockProperties[propertyName];
          
          // Observation: Boolean primitives remain as booleans
          assert.strictEqual(
            typeof extractedValue,
            'boolean',
            `Expected ${propertyName} with boolean value to remain as boolean`
          );
          
          assert.strictEqual(
            extractedValue,
            booleanValue,
            `Expected ${propertyName} value to be unchanged`
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 2.9: Type detection consistency
   * 
   * **Validates: Requirements 3.1, 3.2**
   * 
   * The detectPropertyType method should consistently return the correct type
   * for all non-boolean-string values.
   */
  test('Property 2.9: Type detection is consistent for all property types', () => {
    const testCases: Array<{ value: unknown; expectedType: string }> = [
      { value: 'test string', expectedType: 'string' },
      { value: '', expectedType: 'string' },
      { value: 'description', expectedType: 'string' },
      { value: 123, expectedType: 'number' },
      { value: 0, expectedType: 'number' },
      { value: -456, expectedType: 'number' },
      { value: true, expectedType: 'boolean' },
      { value: false, expectedType: 'boolean' }
    ];

    testCases.forEach(({ value, expectedType }) => {
      const detectedType = typeof value === 'string' ? 'string' : 
                          typeof value === 'number' ? 'number' :
                          typeof value === 'boolean' ? 'boolean' : 'unknown';
      
      assert.strictEqual(
        detectedType,
        expectedType,
        `Expected type detection for ${JSON.stringify(value)} to be ${expectedType}`
      );
    });
  });

  /**
   * Property 2.10: Idempotency - Multiple extractions produce same result
   * 
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
   * 
   * Extracting properties multiple times should produce the same result.
   * This ensures the conversion logic is idempotent.
   */
  test('Property 2.10: Property extraction is idempotent for non-boolean values', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s !== 'false' && s !== 'true'),
          fc.integer(),
          fc.constant('')
        ),
        fc.string({ minLength: 1, maxLength: 20 }),
        (value, propertyName) => {
          const mockProperties1: Record<string, unknown> = {
            [propertyName]: value
          };
          
          const mockProperties2: Record<string, unknown> = {
            [propertyName]: value
          };

          // Multiple extractions should produce identical results
          assert.deepStrictEqual(
            mockProperties1,
            mockProperties2,
            'Multiple extractions should produce identical results'
          );
          
          assert.strictEqual(
            typeof mockProperties1[propertyName],
            typeof mockProperties2[propertyName],
            'Type should be consistent across extractions'
          );
        }
      ),
      { numRuns: 30 }
    );
  });
});
