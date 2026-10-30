import { elementChildren, type XmlElement } from '../xml/xmlDom';
import { flattenExtendedType, hasExtendedPropertyMarker, isPlainTypeDescription } from './adoptedDesignerType';
import { attach, cloneWithNamespaces, direct as xmlDirect, expandedName, replace, xmlEqual } from './adoptedDesignerXml';
import type { AdoptedDesignerProjectionIssue } from './adoptedDesignerProjection';
import type { AdoptedDesignerTypeIdResolver } from './adoptedDesignerTypeId';

const OWNERSHIP_MARKERS = new Set(['ObjectBelonging', 'ExtendedConfigurationObject']);
const PROPERTY_STATES = new Set(['Notify', 'MultiState', 'Extended']);
const LINKED_PROPERTIES = new Set(['Module', 'ObjectModule', 'ManagerModule', 'RecordSetModule', 'ValueManagerModule']);
const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const INVALID_PROPERTY_STATE = '\u0000invalid';

function direct(parent: XmlElement, name: string): XmlElement[] {
  return xmlDirect(parent, name).filter((element) => expandedName(element) === `{${MDCLASSES_NAMESPACE}}${name}`);
}

/** Projects selected adopted property values into the base-owned logical descriptor. */
export function projectAdoptedProperties(input: {
  readonly target: XmlElement;
  readonly overlay: XmlElement;
  readonly states: ReadonlyMap<string, string>;
  readonly side: 'target' | 'source';
  readonly ownerKey: string;
  readonly formatVersion: string;
  readonly issues: AdoptedDesignerProjectionIssue[];
  readonly typeIdResolver: AdoptedDesignerTypeIdResolver;
}): void {
  const { target, overlay, states, side, ownerKey, formatVersion, issues, typeIdResolver } = input;
  for (const candidate of elementChildren(overlay)) {
    if (!inMetadataNamespace(candidate)) {
      addIssue(issues, side, ownerKey, candidate.localName, `Свойство ${candidate.localName} использует посторонний XML namespace и не проецируется.`);
    }
  }
  const names = new Set([...elementChildren(target), ...elementChildren(overlay)].map((element) => element.localName));
  for (const name of names) {
    if (OWNERSHIP_MARKERS.has(name) || name === 'Name') { continue; }
    const baseNodes = direct(target, name);
    const overlayNodes = direct(overlay, name);
    if (baseNodes.length > 1 || overlayNodes.length > 1) {
      addIssue(issues, side, ownerKey, name, `Свойство ${name} повторяется; его adopted overlay не проецируется.`);
      continue;
    }
    if (overlayNodes.length === 0) { continue; }
    const baseNode = baseNodes[0];
    const overlayNode = overlayNodes[0]!;
    if (baseNode && xmlEqual(baseNode, overlayNode)) { continue; }
    if (states.get('*') === INVALID_PROPERTY_STATE) {
      addIssue(issues, side, ownerKey, name, `PropertyState владельца неоднозначен; ${name} не проецируется.`);
      continue;
    }
    const state = states.get(name);
    if (LINKED_PROPERTIES.has(name) || state === 'Extended') {
      addIssue(issues, side, ownerKey, name, `Свойство ${name} связано с отдельным файлом; для него нужен linked-artifact transfer.`);
      continue;
    }
    if (name === 'Type') {
      if (state === 'Notify' && hasExtendedPropertyMarker(overlayNode)) {
        addIssue(issues, side, ownerKey, name, 'ExtendedProperty требует PropertyState=MultiState; Notify не может переносить wrapper без flattening.');
        continue;
      }
      if (state === 'Notify') {
        if (!isPlainTypeDescription(overlayNode)) {
          addIssue(issues, side, ownerKey, name, 'Notify replacement Type не является поддержанным обычным TypeDescription.');
          continue;
        }
        replaceOrAppendMetadata(target, cloneWithNamespaces(overlayNode));
        continue;
      }
      if (state === 'MultiState') {
        let typeIdError: string | undefined;
        const flattened = flattenExtendedType(baseNode, overlayNode, formatVersion, (typeId) => {
          const resolution = typeIdResolver.resolve(typeId);
          if (resolution.reason) { typeIdError = resolution.reason; return undefined; }
          return resolution.qualifiedName;
        });
        if (flattened) { replaceOrAppendMetadata(target, flattened); }
        else {
          const reason = typeIdError
            ? `ExtendedProperty содержит неподдержанный TypeId: ${typeIdError}`
            : 'ExtendedProperty не имеет поддержанной TypeDescription/квалификаторной формы.';
          addIssue(issues, side, ownerKey, name, reason);
        }
        continue;
      }
      addIssue(issues, side, ownerKey, name, 'Изменённый Type требует PropertyState=Notify либо ExtendedProperty с MultiState.');
      continue;
    }
    if (state === 'MultiState') {
      addIssue(issues, side, ownerKey, name, `MultiState не поддержан для свойства ${name}.`);
      continue;
    }
    if (state !== undefined && !PROPERTY_STATES.has(state)) {
      addIssue(issues, side, ownerKey, name, `Неизвестный PropertyState=${state} у ${name}.`);
      continue;
    }
    replaceOrAppendMetadata(target, cloneWithNamespaces(overlayNode));
  }
}

function replaceOrAppendMetadata(parent: XmlElement, replacement: XmlElement): void {
  const existing = direct(parent, replacement.localName);
  if (existing.length > 1) { throw new Error(`Metadata XML contains duplicate ${replacement.localName} nodes.`); }
  if (existing[0]) { replace(parent, existing[0], replacement); }
  else { attach(parent, replacement); }
}

function inMetadataNamespace(element: XmlElement): boolean {
  return expandedName(element) === `{${MDCLASSES_NAMESPACE}}${element.localName}`;
}

function addIssue(
  issues: AdoptedDesignerProjectionIssue[],
  side: 'target' | 'source',
  identityKey: string,
  propertyName: string | undefined,
  reason: string,
): void {
  issues.push({ side, identityKey, ...(propertyName ? { propertyName } : {}), reason });
}
