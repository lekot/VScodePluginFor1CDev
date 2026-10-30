import {
  knownRootPropertyReferencesInXml,
  metadataReferenceFromType,
  metadataReferencesInSubsystemContent,
} from './semanticXmlMetadataReferences';
import type { XmlElementNode } from './semanticXmlAdapter';

export function metadataReferencesInXml(...roots: readonly XmlElementNode[]): string[] {
  const references = new Set<string>();
  for (const root of roots) {
    for (const reference of metadataReferencesInSubsystemContent(root.dom)) {
      references.add(reference);
    }
    for (const reference of knownRootPropertyReferencesInXml(root.dom).references) {
      references.add(reference.qualifiedName);
    }
    walk(root, (element) => {
      const metadataReference = metadataReferenceFromType(element.dom);
      if (metadataReference?.qualifiedName) {
        references.add(metadataReference.qualifiedName);
      }
    });
  }
  return [...references];
}

function walk(root: XmlElementNode, visit: (element: XmlElementNode) => void): void {
  visit(root);
  for (const child of root.children) {
    walk(child, visit);
  }
}
