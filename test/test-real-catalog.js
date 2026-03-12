const { XmlParser } = require('../out/src/parsers/xmlParser');
const path = require('path');

// Test parsing of real catalog file
const catalogPath = path.join(__dirname, '../structure_samples/Catalogs/Доклады.xml');

console.log('Testing XML parsing of real catalog...');
console.log('File:', catalogPath);
console.log('');

try {
  const parsed = XmlParser.parseFile(catalogPath);
  
  const catalog = parsed.MetaDataObject.Catalog;
  
  if (catalog.ChildObjects && catalog.ChildObjects.Attribute) {
    const attributes = Array.isArray(catalog.ChildObjects.Attribute) 
      ? catalog.ChildObjects.Attribute 
      : [catalog.ChildObjects.Attribute];
    
    // Find the "Автор" attribute
    const authorAttr = attributes.find(attr => attr.Properties && attr.Properties.Name === 'Автор');
    
    if (authorAttr) {
      console.log('Found "Автор" attribute:');
      console.log('  Name:', authorAttr.Properties.Name);
      console.log('  Type object:', JSON.stringify(authorAttr.Properties.Type, null, 2));
      console.log('  v8:Type value:', JSON.stringify(authorAttr.Properties.Type['v8:Type'], null, 2));
    }
  }
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
}
