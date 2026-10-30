import type { CompareTreeNode } from '../../compareTreeTypes';
import { captureXmlSubtree } from '../../xml/xmlDom';
import type { Location } from './semanticXmlLocation';
import { childLocation } from './semanticXmlLocation';
import { localXmlName, semanticXmlIdentityKey } from './semanticXmlIdentity';
import { elementDisplayName } from './semanticXmlAdapterLabels';
import type { XmlElementNode } from './semanticXmlAdapter';
import type { SemanticXmlKind } from './semanticXmlValidator';

export function readOnlyContainerGroup(input: {
  element: XmlElementNode;
  location: Location;
  kind: SemanticXmlKind;
  status: 'leftOnly' | 'rightOnly';
  depth: number;
  options: { nodeIdPrefix: string; targetFilePath: string };
  isSelectableChild: (child: XmlElementNode) => boolean;
  projectChild: (child: XmlElementNode, location: Location, selectable: boolean) => CompareTreeNode;
}): CompareTreeNode {
  const children = input.element.children.map((child) => {
    const location = childLocation(input.location, child, childSelector(child, input.element, input.kind));
    return input.projectChild(child, location, input.isSelectableChild(child));
  });
  return {
    id: input.options.nodeIdPrefix + ':group:' + encodeURIComponent(input.location.pointer),
    label: elementDisplayName(input.element),
    kind: 'xmlElement',
    status: input.status,
    leftValue: input.status === 'leftOnly' ? captureXmlSubtree(input.element.dom) : undefined,
    rightValue: input.status === 'rightOnly' ? captureXmlSubtree(input.element.dom) : undefined,
    mergeable: false,
    payloadRef: 'xmlPatch:' + input.location.pointer,
    mergeState: {
      state: 'readOnly',
      reason: 'Выбирайте отдельные XML-элементы; общий контейнер может включать несвязанные данные.',
      targetFilePath: input.options.targetFilePath,
    },
    children,
  };
}

function childSelector(element: XmlElementNode, parent: XmlElementNode, kind: SemanticXmlKind): string {
  const identity = semanticXmlIdentityKey(element.dom, parent.dom, kind);
  if (identity) {
    return identity;
  }
  const sameName = parent.children.filter((child) => localXmlName(child.name) === localXmlName(element.name));
  return String(sameName.indexOf(element));
}
