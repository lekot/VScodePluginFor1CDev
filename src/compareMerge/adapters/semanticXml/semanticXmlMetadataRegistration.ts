import type { CompareTreeNode } from '../../compareTreeTypes';
import { getMetadataTypeDescriptorByRootTag } from '../../../constants/metadataTypeDescriptors';
import type { MergeFileWitness } from '../../merge/mergePreview';
import { applyXmlPatch, hashXmlText, type XmlPatchPayload } from '../../xml/xmlPatch';
import { captureXmlSubtree } from '../../xml/xmlDom';
import type { XmlElementNode } from './semanticXmlAdapter';
import type { Location } from './semanticXmlLocation';
import { childLocation } from './semanticXmlLocation';
import { localXmlName, namespaceUriForName } from './semanticXmlIdentity';
import type { AdapterCompareInput, ExecutableCandidateFactory } from '../mergeAdapter';

export interface MissingMetadataRegistrationInput {
  container: XmlElementNode;
  parentLocation: Location;
  targetFilePath: string;
  nodeIdPrefix: string;
  canMerge: (element: XmlElementNode) => boolean;
  buildCandidate: (input: {
    element: XmlElementNode;
    location: Location;
    destinationParent: Location;
    sourceOrder: number;
  }) => CompareTreeNode;
  buildReadOnly: (element: XmlElementNode, location: Location) => CompareTreeNode;
}

export interface MetadataRegistrationCandidateInput {
  element: XmlElementNode;
  location: Location;
  destinationParent: Location;
  sourceOrder: number;
  input: AdapterCompareInput;
  nodeIdPrefix: string;
  targetFilePath: string;
  targetUri: string;
  expectedOldHash: string;
  sourceId: string;
  snapshotId: string;
  sourceWitnesses: readonly MergeFileWitness[];
  semanticContext: XmlPatchPayload['semanticContext'];
  candidateFactories: Map<string, ExecutableCandidateFactory>;
}

export function canSynthesizeMetadataChildObjects(input: {
  leftOwner: XmlElementNode;
  rightOwner: XmlElementNode;
  container: XmlElementNode;
  leftRoot: XmlElementNode;
  rightRoot: XmlElementNode;
  kind: string;
}): boolean {
  const namespace = namespaceUriForName(input.leftRoot.dom) ?? '';
  const validNamespace = namespace === '' || namespace === 'http://v8.1c.ru/8.3/MDClasses';
  return input.kind === 'metadataXml' && validNamespace &&
    (namespaceUriForName(input.rightRoot.dom) ?? '') === namespace &&
    localXmlName(input.leftRoot.name) === 'MetaDataObject' &&
    localXmlName(input.rightRoot.name) === 'MetaDataObject' &&
    input.leftOwner.parent === input.leftRoot && input.rightOwner.parent === input.rightRoot &&
    (namespaceUriForName(input.leftOwner.dom) ?? '') === namespace &&
    (namespaceUriForName(input.rightOwner.dom) ?? '') === namespace &&
    localXmlName(input.leftOwner.name) === localXmlName(input.rightOwner.name) &&
    getMetadataTypeDescriptorByRootTag(localXmlName(input.leftOwner.name))?.structure.hasChildObjects === true &&
    !input.leftOwner.children.some((child) => localXmlName(child.name) === 'ChildObjects') &&
    input.rightOwner.children.filter((child) => localXmlName(child.name) === 'ChildObjects').length === 1 &&
    input.container.parent === input.rightOwner && localXmlName(input.container.name) === 'ChildObjects' &&
    (namespaceUriForName(input.container.dom) ?? '') === namespace &&
    input.container.children.some((child) => ['Form', 'Template', 'Command'].includes(localXmlName(child.name)));
}

/** Displays an absent ChildObjects as a non-selectable group with individually gated registrations. */
export function missingMetadataRegistrationContainer(input: MissingMetadataRegistrationInput): CompareTreeNode {
  const destinationParent: Location = {
    pointer: input.parentLocation.pointer + '/ChildObjects[0]',
    displayPath: input.parentLocation.displayPath + '/ChildObjects',
    identityKey: undefined,
  };
  const ordinals = new Map<string, number>();
  const children = input.container.children.map((element) => {
    const name = localXmlName(element.name);
    const ordinal = ordinals.get(name) ?? 0;
    ordinals.set(name, ordinal + 1);
    const location = childLocation(destinationParent, element, String(ordinal));
    return input.canMerge(element)
      ? input.buildCandidate({
          element,
          location,
          destinationParent,
          sourceOrder: input.container.children.indexOf(element),
        })
      : input.buildReadOnly(element, location);
  });
  const id = input.nodeIdPrefix + ':element:' + encodeURIComponent(destinationParent.pointer);
  return {
    id,
    label: 'Контейнер объектов',
    kind: 'xmlElement',
    status: 'rightOnly',
    rightValue: captureXmlSubtree(input.container.dom),
    mergeable: false,
    payloadRef: 'xmlPatch:' + destinationParent.pointer,
    mergeState: {
      state: 'readOnly',
      reason: 'Целевой контейнер отсутствует; выбирайте отдельные связанные регистрации.',
      targetFilePath: input.targetFilePath,
    },
    children,
  };
}

export function metadataRegistrationLabel(element: XmlElementNode): string {
  const label = element.text?.trim();
  const prefix = localXmlName(element.name);
  const russianPrefix = prefix === 'Form' ? 'Форма' : prefix === 'Template' ? 'Макет' : prefix === 'Command' ? 'Команда' : prefix;
  return label ? `${russianPrefix}: ${label}` : russianPrefix;
}

export function metadataRegistrationNodeId(nodeIdPrefix: string, location: Location): string {
  return nodeIdPrefix + ':registration:' + encodeURIComponent(location.pointer);
}

export function metadataRegistrationCandidateNode(input: MetadataRegistrationCandidateInput): CompareTreeNode {
  const id = metadataRegistrationNodeId(input.nodeIdPrefix, input.location);
  const patch: XmlPatchPayload = {
    kind: 'insertNode',
    target: {
      filePath: input.targetUri,
      pointer: input.location.pointer,
      displayPath: input.location.displayPath,
      identityKey: input.location.identityKey,
    },
    destinationParent: {
      filePath: input.targetUri,
      pointer: input.destinationParent.pointer,
      displayPath: input.destinationParent.displayPath,
    },
    createDestinationChildObjects: true,
    insertPosition: 'append',
    insertOrder: input.sourceOrder,
    semanticKind: 'metadataXml',
    expectedOldHash: input.expectedOldHash,
    newHash: '',
    replacementXml: captureXmlSubtree(input.element.dom),
    sourceWitnesses: input.sourceWitnesses,
    semanticContext: input.semanticContext,
  };
  patch.newHash = hashXmlText(applyXmlPatch(input.input.snapshots.left, patch));
  const candidateFactory: ExecutableCandidateFactory = async () => ({
    ok: true,
    candidate: {
      kind: 'xmlNodeInsert',
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      nodeId: id,
      targetUri: input.targetUri,
      expectedOldHash: input.expectedOldHash,
      newHash: patch.newHash,
      xmlPatch: patch,
    },
  });
  input.candidateFactories.set(id, candidateFactory);
  return {
    id,
    label: metadataRegistrationLabel(input.element),
    kind: 'xmlElement',
    status: 'rightOnly',
    rightValue: patch.replacementXml,
    mergeable: true,
    payloadRef: 'xmlPatch:' + input.location.pointer,
    mergeState: { state: 'ready', targetFilePath: input.targetFilePath },
    children: [],
  };
}
