import type { XmlElementKindInput, XmlElementNode } from './semanticXmlAdapter';
import type { SemanticXmlKind } from './semanticXmlValidator';
import { isSupportedAttributeNamespace, isSupportedElementNamespace } from './semanticXmlPolicy';
import { localXmlName, namespaceUriForName } from './semanticXmlIdentity';
import { elementChildren, textContent, type XmlElement } from '../../xml/xmlDom';

export function wrapXmlElement(dom: XmlElement, parent?: XmlElementNode): XmlElementNode {
  const result: XmlElementNode = {
    name: dom.name,
    attributes: Object.fromEntries(dom.attributes.map((attribute) => [attribute.name, attribute.value])),
    children: [],
    text: textContent(dom),
    dom,
    parent,
  };
  (result.children as XmlElementNode[]).push(...elementChildren(dom).map((child) => wrapXmlElement(child, result)));
  return result;
}

export function isFormEventElement(element: XmlElementNode): boolean {
  return localXmlName(element.name) === 'Event' && localXmlName(element.parent?.name ?? '') === 'Events';
}

export function unsupportedSubtreeReason(
  root: XmlElementNode,
  parent: XmlElementNode | undefined,
  depth: number,
  kind: SemanticXmlKind,
  knownComplexElement?: (input: XmlElementKindInput) => boolean
): string | undefined {
  return visit(root, parent, depth, kind, knownComplexElement);
}

export function hasUnsupportedChangedAttributes(left: XmlElement, right: XmlElement): boolean {
  const leftValues = new Map(left.attributes.map((attribute) => [attribute.name, attribute.value]));
  const rightValues = new Map(right.attributes.map((attribute) => [attribute.name, attribute.value]));
  const names = new Set([...leftValues.keys(), ...rightValues.keys()]);
  for (const name of names) {
    const leftNamespace = namespaceUriForName(left, name, true);
    const rightNamespace = namespaceUriForName(right, name, true);
    if (leftValues.get(name) === rightValues.get(name) && leftNamespace === rightNamespace) {
      continue;
    }
    if (leftNamespace !== rightNamespace) {
      return true;
    }
    if (leftValues.has(name) && !isSupportedAttributeNamespace(left, name)) {
      return true;
    }
    if (rightValues.has(name) && !isSupportedAttributeNamespace(right, name)) {
      return true;
    }
  }
  return false;
}

function visit(
  element: XmlElementNode,
  parent: XmlElementNode | undefined,
  depth: number,
  kind: SemanticXmlKind,
  knownComplexElement?: (input: XmlElementKindInput) => boolean
): string | undefined {
  if (!isSupportedElementNamespace(element.dom)) {
    return 'XML-раздел содержит элемент из неподдерживаемого пространства имён и доступен только для чтения.';
  }
  for (const attribute of element.dom.attributes) {
    if (!isSupportedAttributeNamespace(element.dom, attribute.name)) {
      return 'XML-раздел содержит атрибут из неподдерживаемого пространства имён и доступен только для чтения.';
    }
  }
  if (kind === 'formXml' && isFormEventElement(element)) {
    return 'Обработчик события зависит от BSL-модуля формы; без проверки модуля перенос этого раздела доступен только для чтения.';
  }
  if (element.children.length > 0 && !knownComplexElement?.({ element, parent, depth })) {
    return 'Структура XML не подтверждена: содержит неподдерживаемый вложенный раздел и доступна только для чтения.';
  }
  for (const child of element.children) {
    const reason = visit(child, element, depth + 1, kind, knownComplexElement);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}
