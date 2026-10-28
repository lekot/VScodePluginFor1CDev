import type { XmlElement } from '../../xml/xmlDom';
import { attributeByLocalName, hasCfeMetadataMarker, semanticXmlIdentityKey } from './semanticXmlIdentity';
import { DESCRIPTOR_OBJECT_NAMES } from './semanticXmlPolicy';
import type { SemanticXmlKind } from './semanticXmlValidator';

export interface SemanticIdentityNode {
  name: string;
  children: readonly SemanticIdentityNode[];
  text?: string;
  dom: XmlElement;
  parent?: SemanticIdentityNode;
}

export function isProtectedLeaf(
  left: SemanticIdentityNode | undefined,
  right: SemanticIdentityNode | undefined,
  parent: SemanticIdentityNode,
  kind: SemanticXmlKind
): boolean {
  const element = right ?? left;
  if (!element) {
    return false;
  }
  const name = localName(element.name);
  if (kind === 'predefinedXml' && name === 'Name' && localName(parent.name) === 'Item') {
    return true;
  }
  if (kind === 'metadataXml' && name === 'Name' && localName(parent.name) === 'Properties') {
    const object = parent.parent;
    return Boolean(object && (attributeByLocalName(object.dom, 'uuid') || DESCRIPTOR_OBJECT_NAMES.has(localName(object.name))));
  }
  return false;
}

export function isProtectedIdentityMismatch(left: SemanticIdentityNode, right: SemanticIdentityNode, kind: SemanticXmlKind): boolean {
  if (localName(left.name) !== localName(right.name)) {
    return true;
  }
  if (kind === 'formXml') {
    const leftName = attributeByLocalName(left.dom, 'name') ?? directChildText(left, 'Name');
    const rightName = attributeByLocalName(right.dom, 'name') ?? directChildText(right, 'Name');
    return leftName !== rightName;
  }
  if (kind === 'predefinedXml' && localName(left.name) === 'Item') {
    return directChildText(left, 'Name') !== directChildText(right, 'Name');
  }
  if (kind === 'metadataXml' && (attributeByLocalName(left.dom, 'uuid') || DESCRIPTOR_OBJECT_NAMES.has(localName(left.name)))) {
    return propertiesName(left) !== propertiesName(right);
  }
  return false;
}

export function findIdentityMismatches(
  left: SemanticIdentityNode,
  right: SemanticIdentityNode,
  kind: SemanticXmlKind
): string[] {
  const problems: string[] = [];
  if (kind === 'metadataXml') {
    const leftObjects = left.children.filter((child) => isDescriptorObject(child));
    const rightObjects = right.children.filter((child) => isDescriptorObject(child));
    if (leftObjects.length > 0 || rightObjects.length > 0) {
      if (leftObjects.length !== 1 || rightObjects.length !== 1) {
        problems.push('Дескриптор должен содержать один объект метаданных с обеих сторон.');
      } else if (
        localName(leftObjects[0]!.name) !== localName(rightObjects[0]!.name) ||
        propertiesName(leftObjects[0]!) !== propertiesName(rightObjects[0]!) ||
        ((hasCfeMetadataMarker(leftObjects[0]!.dom) || hasCfeMetadataMarker(rightObjects[0]!.dom)) &&
          attributeByLocalName(leftObjects[0]!.dom, 'uuid') !== attributeByLocalName(rightObjects[0]!.dom, 'uuid'))
      ) {
        problems.push('Корневой объект метаданных изменил идентичность или имя; такое изменение нельзя выполнять через XML merge.');
      }
    }
  }

  const leftByIdentity = new Map<string, SemanticIdentityNode>();
  walk(left, (element) => {
    const identity = stableIdentity(element, kind);
    if (identity) {
      leftByIdentity.set(identity, element);
    }
  });
  walk(right, (element) => {
    const identity = stableIdentity(element, kind);
    if (!identity) {
      return;
    }
    const matching = leftByIdentity.get(identity);
    if (matching && isProtectedIdentityMismatch(matching, element, kind)) {
      problems.push(identityMismatchMessage(kind));
    }
  });
  return [...new Set(problems)];
}

export function identityMismatchCode(kind: SemanticXmlKind): string {
  return kind === 'formXml' ? 'XML_FORM_IDENTITY_MISMATCH' : kind === 'predefinedXml' ? 'XML_PREDEFINED_IDENTITY_MISMATCH' : 'XML_METADATA_IDENTITY_MISMATCH';
}

export function identityMismatchMessage(kind: SemanticXmlKind): string {
  if (kind === 'formXml') {
    return 'Элемент формы с тем же ID имеет другое имя или тип; безопасное сопоставление невозможно.';
  }
  if (kind === 'predefinedXml') {
    return 'Предопределённый элемент с тем же UUID имеет другое имя; безопасное переименование не поддерживается.';
  }
  return 'Объект метаданных с тем же UUID имеет другое имя или тип; безопасное сопоставление невозможно.';
}

function stableIdentity(element: SemanticIdentityNode, kind: SemanticXmlKind): string | undefined {
  if (kind === 'formXml' && isFormNamedIdentity(element)) {
    const id = attributeByLocalName(element.dom, 'id');
    if (!id) {
      return undefined;
    }
    const name = localName(element.name);
    const scope = name === 'Attribute' ? 'attribute' : name === 'Command' ? 'command' : name === 'Parameter' ? 'parameter' : 'visual';
    const ownershipScope = isInsideBaseForm(element) ? 'base' : 'form';
    return ownershipScope + ':' + scope + ':id=' + id;
  }
  if (kind === 'predefinedXml' && localName(element.name) === 'Item') {
    const id = attributeByLocalName(element.dom, 'id');
    return id ? 'id=' + id : semanticXmlIdentityKey(element.dom, element.parent?.dom, kind);
  }
  if (kind === 'metadataXml') {
    const uuid = attributeByLocalName(element.dom, 'uuid');
    return uuid ? 'uuid=' + uuid : undefined;
  }
  return undefined;
}

function isFormNamedIdentity(element: SemanticIdentityNode): boolean {
  const name = localName(element.name);
  return Boolean(attributeByLocalName(element.dom, 'id') && attributeByLocalName(element.dom, 'name') && (
    ['Attribute', 'Command', 'Parameter'].includes(name) || isVisualFormItem(element)
  ));
}

function isVisualFormItem(element: SemanticIdentityNode): boolean {
  const name = localName(element.name);
  return Boolean(attributeByLocalName(element.dom, 'id') && (
    attributeByLocalName(element.dom, 'name') ||
    ['Item', 'InputField', 'Table', 'UsualGroup', 'Button', 'LabelField', 'Decoration', 'CheckBoxField', 'RadioButtonField'].includes(name)
  ));
}

function isInsideBaseForm(element: SemanticIdentityNode): boolean {
  let current = element.parent;
  while (current) {
    if (localName(current.name) === 'BaseForm') {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isDescriptorObject(element: SemanticIdentityNode): boolean {
  return DESCRIPTOR_OBJECT_NAMES.has(localName(element.name)) || Boolean(attributeByLocalName(element.dom, 'uuid'));
}

function propertiesName(element: SemanticIdentityNode): string | undefined {
  const properties = element.children.find((child) => localName(child.name) === 'Properties');
  return properties?.children.find((child) => localName(child.name) === 'Name')?.text?.trim();
}

function directChildText(element: SemanticIdentityNode, name: string): string | undefined {
  return element.children.find((child) => localName(child.name) === name)?.text?.trim();
}

function walk(root: SemanticIdentityNode, visit: (element: SemanticIdentityNode) => void): void {
  visit(root);
  for (const child of root.children) {
    walk(child, visit);
  }
}

function localName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}
