const { TypeParser } = require('../out/src/parsers/typeParser');
const { TypeFormatter } = require('../out/src/utils/typeFormatter');

// Test reference type parsing
const referenceTypeObject = {
  'v8:Type': 'cfg:CatalogRef.Products'
};

console.log('Testing reference type parsing...');
console.log('Input:', JSON.stringify(referenceTypeObject, null, 2));

try {
  const typeDef = TypeParser.parseFromObject(referenceTypeObject);
  console.log('Parsed TypeDefinition:', JSON.stringify(typeDef, null, 2));
  
  const formatted = TypeFormatter.formatTypeDisplay(typeDef);
  console.log('Formatted display:', formatted);
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
}
