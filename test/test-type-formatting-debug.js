const { XMLWriter } = require('../dist/utils/XMLWriter');
const path = require('path');

async function testTypeFormatting() {
  console.log('Testing type formatting with debug...\n');

  // Test: Composite type
  const compositeFile = path.join(__dirname, '../structure_samples/ChartsOfCharacteristicTypes/ТелеграмПараметрыКонтекста.xml');
  console.log('Reading composite type from:', compositeFile);
  
  try {
    const properties = await XMLWriter.readProperties(compositeFile);
    console.log('Type property:', JSON.stringify(properties.Type, null, 2));
    console.log('Type property type:', typeof properties.Type);
    console.log('Is array:', Array.isArray(properties.Type));
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

testTypeFormatting().catch(console.error);
