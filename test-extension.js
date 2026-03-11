// Test script to verify metadata parsing works
const { MetadataParser } = require('./dist/parsers/metadataParser');
const path = require('path');

async function test() {
  console.log('Testing metadata parser...');
  
  const samplesPath = path.join(__dirname, 'structure_samples');
  console.log('Samples path:', samplesPath);
  
  try {
    const rootNode = await MetadataParser.parseFromWorkspace(samplesPath);
    
    if (rootNode) {
      console.log('✅ Parsing successful!');
      console.log('Root node:', rootNode.name, '- Type:', rootNode.type);
      console.log('Children count:', rootNode.children?.length || 0);
      
      if (rootNode.children && rootNode.children.length > 0) {
        console.log('\nFirst 5 children:');
        rootNode.children.slice(0, 5).forEach(child => {
          console.log(`  - ${child.name} (${child.type})`);
        });
      }
    } else {
      console.log('❌ No root node returned');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

test();
