const { TypeParser } = require('../out/src/parsers/typeParser');
const { TypeFormatter } = require('../out/src/utils/typeFormatter');

// Test reference type parsing with namespace (as it comes from XML parser)
const referenceTypeObjectWithNamespace = {
  'v8:Type': {
    '#text': 'cfg:CatalogRef.Products',
    '@_xmlns:cfg': 'http://v8.1c.ru/8.1/data/enterprise/current-config'
  }
};

console.log('Testing reference type parsing with namespace...');
console.log('Input:', JSON.stringify(referenceTypeObjectWithNamespace, null, 2));

try {
  const typeDef = TypeParser.parseFromObject(referenceTypeObjectWithNamespace);
  console.log('Parsed TypeDefinition:', JSON.stringify(typeDef, null, 2));
  
  const formatted = TypeFormatter.formatTypeDisplay(typeDef);
  console.log('Formatted display:', formatted);
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
}
