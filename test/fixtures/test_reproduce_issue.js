const { DesignerParser } = require('../src/parsers/designerParser');
const { MetadataType } = require('../src/models/treeNode');
const path = require('path');

async function testTwoAttributesIssue() {
    console.log('Testing two attributes issue...');
    
    const configPath = path.join(__dirname, 'designer-config');
    
    try {
        const rootNode = await DesignerParser.parse(configPath);
        console.log('Root node parsed successfully');
        
        // Find the document with two attributes
        const documentNode = rootNode.children
            .find(child => child.children && 
                child.children.find(doc => doc.name === 'TestDocumentWithTwoAttributes'));
        
        if (!documentNode) {
            console.error('TestDocumentWithTwoAttributes not found');
            return;
        }
        
        console.log('Found document:', documentNode.name);
        
        // Load children for the document
        const children = await DesignerParser.loadChildrenForElement(
            configPath,
            'Documents',
            'TestDocumentWithTwoAttributes'
        );
        
        console.log('Children loaded:', children.length);
        
        // Find attributes node
        const attributesNode = children.find(c => c.id === 'Attributes');
        if (!attributesNode) {
            console.error('Attributes node not found');
            return;
        }
        
        console.log('Attributes node found with', attributesNode.children?.length || 0, 'children');
        
        // Check each attribute
        if (attributesNode.children && attributesNode.children.length > 0) {
            attributesNode.children.forEach((attr, index) => {
                console.log(`Attribute ${index + 1}:`);
                console.log(`  Name: ${attr.name}`);
                console.log(`  Type: ${attr.type}`);
                console.log(`  Properties:`, Object.keys(attr.properties || {}));
                console.log(`  Full properties:`, attr.properties);
            });
        } else {
            console.error('No attributes found');
        }
        
    } catch (error) {
        console.error('Error:', error);
    }
}

testTwoAttributesIssue();