const { XmlParser } = require('../out/src/parsers/xmlParser');
const path = require('path');

// Test full parsing of catalog with reference attribute
const catalogPath = path.join(__dirname, 'fixtures/designer-config/Catalogs/TestCatalogWithReferenceAttribute.xml');

console.log('Testing XML parsing of catalog with reference attribute...');
console.log('File:', catalogPath);
console.log('');

try {
  const parsed = XmlParser.parseFile(catalogPath);
  console.log('Raw parsed XML structure:');
  
  const catalog = parsed.MetaDataObject.Catalog;
  console.log('Catalog Properties:', JSON.stringify(catalog.Properties, null, 2));
  
  if (catalog.ChildObjects && catalog.ChildObjects.Attribute) {
    const attributes = Array.isArray(catalog.ChildObjects.Attribute) 
      ? catalog.ChildObjects.Attribute 
      : [catalog.ChildObjects.Attribute];
    
    console.log('\nAttributes:');
    attributes.forEach((attr, index) => {
      console.log(`\nAttribute ${index + 1}:`);
      console.log('  Properties:', JSON.stringify(attr.Properties, null, 2));
      console.log('  Type object:', JSON.stringify(attr.Properties.Type, null, 2));
    });
  }
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
}DesignerParser.parseMetadataFile(catalogPath)
  .then(result => {
    console.log('Parsed result:');
    console.log('Name:', result.name);
    console.log('Type:', result.type);
    console.log('');
    
    if (result.children && result.children.length > 0) {
      console.log('Children:');
      result.children.forEach((child, index) => {
        console.log(`\nChild ${index + 1}:`);
        console.log('  Name:', child.name);
        console.log('  Type:', child.type);
        console.log('  Properties:', JSON.stringify(child.properties, null, 4));
      });
    }
  })
  .catch(error => {
    console.error('Error:', error.message);
    console.error(error.stack);
  });
