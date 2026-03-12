const { XMLWriter } = require('../out/src/utils/XMLWriter');
const path = require('path');

async function testTypeFormatting() {
  console.log('Testing type formatting...\n');

  // Test 1: CatalogRef type
  const catalogFile = path.join(__dirname, '../structure_samples/InformationRegisters/СообщенияПользователям.xml');
  console.log('Test 1: Reading CatalogRef type from:', catalogFile);
  
  try {
    const properties = await XMLWriter.readProperties(catalogFile);
    console.log('Properties:', JSON.stringify(properties, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }

  console.log('\n---\n');

  // Test 2: Composite type
  const compositeFile = path.join(__dirname, '../structure_samples/ChartsOfCharacteristicTypes/ТелеграмПараметрыКонтекста.xml');
  console.log('Test 2: Reading composite type from:', compositeFile);
  
  try {
    const properties = await XMLWriter.readProperties(compositeFile);
    console.log('Properties:', JSON.stringify(properties, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testTypeFormatting().catch(console.error);
