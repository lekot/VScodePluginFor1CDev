const { TypeParser } = require('../out/src/parsers/typeParser');
const { TypeFormatter } = require('../out/src/utils/typeFormatter');

// Simulate what flattenAttributeProperties does
function testFlattenProperties(attrProperties) {
  const properties = {};
  
  for (const [key, value] of Object.entries(attrProperties)) {
    if (key.startsWith('@_') || key.startsWith('#')) {
      continue;
    }
    
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      properties[key] = value;
    } else if (value && typeof value === 'object') {
      const obj = value;
      
      if (obj['v8:item']) {
        const items = obj['v8:item'];
        if (Array.isArray(items) && items.length > 0) {
          const firstItem = items[0];
          if (firstItem && typeof firstItem === 'object' && 'v8:content' in firstItem) {
            properties[key] = firstItem['v8:content'];
          }
        } else if (items && typeof items === 'object' && 'v8:content' in items) {
          properties[key] = items['v8:content'];
        }
      } else if ('v8:Type' in obj) {
        try {
          const typeDef = TypeParser.parseFromObject(obj);
          properties[key] = TypeFormatter.formatTypeDisplay(typeDef);
          console.log(`  Parsed type for ${key}:`, properties[key]);
        } catch (error) {
          console.error(`  Error parsing type for ${key}:`, error.message);
          properties[key] = obj['v8:Type'];
        }
      } else {
        properties[key] = value;
      }
    }
  }
  
  return properties;
}

// Test 1: String type
console.log('Test 1: String type');
const stringAttr = {
  Name: 'StringAttribute',
  Synonym: {
    'v8:item': {
      'v8:lang': 'ru',
      'v8:content': 'String Attribute'
    }
  },
  Type: {
    'v8:Type': 'xs:string',
    'v8:StringQualifiers': {
      'v8:Length': 50,
      'v8:AllowedLength': 'Variable'
    }
  }
};
console.log('Result:', testFlattenProperties(stringAttr));
console.log('');

// Test 2: Reference type (simple string)
console.log('Test 2: Reference type (simple string)');
const refAttr1 = {
  Name: 'ProductReference',
  Synonym: {
    'v8:item': {
      'v8:lang': 'ru',
      'v8:content': 'Product Reference'
    }
  },
  Type: {
    'v8:Type': 'cfg:CatalogRef.Products'
  }
};
console.log('Result:', testFlattenProperties(refAttr1));
console.log('');

// Test 3: Reference type (with namespace - object with #text)
console.log('Test 3: Reference type (with namespace - object with #text)');
const refAttr2 = {
  Name: 'ProductReference',
  Synonym: {
    'v8:item': {
      'v8:lang': 'ru',
      'v8:content': 'Product Reference'
    }
  },
  Type: {
    'v8:Type': {
      '#text': 'cfg:CatalogRef.Products',
      '@_xmlns:cfg': 'http://v8.1c.ru/8.1/data/enterprise/current-config'
    }
  }
};
console.log('Result:', testFlattenProperties(refAttr2));
console.log('');
