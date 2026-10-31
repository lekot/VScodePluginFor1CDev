import { elementChildren, type XmlElement } from '../xml/xmlDom';
import {
  attach,
  attribute,
  cloneWithNamespaces,
  direct as xmlDirect,
  makeElement,
  prefixForNamespace,
} from './adoptedDesignerXml';
import {
  addIssue,
  childText,
  direct,
  inMetadataNamespace,
  same,
} from './adoptedDesignerMetadataXml';
import { projectAdoptedProperties } from './adoptedDesignerLogicalProperties';
import { projectAdoptedMetadataOrder } from './adoptedDesignerOrder';
import type { AdoptedDesignerProjectionIssue } from './adoptedDesignerProjection';
import type { AdoptedDesignerTypeIdResolver } from './adoptedDesignerTypeId';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface AdoptedDesignerChildProjectionInput {
  readonly adoptedParent: XmlElement;
  readonly logicalParent: XmlElement;
  readonly baseOrderParent: XmlElement;
  readonly side: 'target' | 'source';
  readonly formatVersion: string;
  readonly issues: AdoptedDesignerProjectionIssue[];
  readonly parentKey: string;
  readonly typeIdResolver: AdoptedDesignerTypeIdResolver;
  readonly stateMap: (owner: XmlElement, side: 'target' | 'source', ownerKey: string, issues: AdoptedDesignerProjectionIssue[]) => Map<string, string>;
}

export function projectAdoptedDesignerChildren(input: AdoptedDesignerChildProjectionInput): void {
  const { adoptedParent, logicalParent, side, formatVersion, issues, parentKey, typeIdResolver, stateMap } = input;
  if (xmlDirect(adoptedParent, 'ChildObjects').some((node) => !inMetadataNamespace(node))) {
    addIssue(issues, side, parentKey, 'ChildObjects', 'ChildObjects использует посторонний XML namespace и не проецируется.');
  }
  const adoptedContainer = direct(adoptedParent, 'ChildObjects')[0];
  if (!adoptedContainer) { return; }
  const logicalContainers = direct(logicalParent, 'ChildObjects');
  if (logicalContainers.length > 1) {
    addIssue(issues, side, parentKey, 'ChildObjects', 'В base повторяется ChildObjects; вложенные элементы не проецируются.');
    return;
  }
  let logicalContainer = logicalContainers[0];
  const seenAnchors = new Set<string>();
  const seenLocalUuids = new Set<string>();
  for (const overlayChild of elementChildren(adoptedContainer)) {
    if (!inMetadataNamespace(overlayChild)) {
      addIssue(issues, side, parentKey, 'ChildObjects', `ChildObjects содержит ${overlayChild.localName} в постороннем XML namespace; узел не сопоставлен.`);
      continue;
    }
    const childType = overlayChild.localName;
    if (childType === 'Form') { continue; }
    const properties = direct(overlayChild, 'Properties')[0];
    if (!properties) {
      addIssue(issues, side, parentKey, childType, `ChildObjects/${childType} отсутствует Properties.`);
      continue;
    }
    const localUuid = attribute(overlayChild, 'uuid') ?? '';
    if (localUuid && seenLocalUuids.has(localUuid.toLowerCase())) {
      addIssue(issues, side, `uuid=${localUuid.toLowerCase()}`, undefined, `Локальный UUID ${localUuid} повторяется в ChildObjects.`);
      continue;
    }
    if (localUuid) { seenLocalUuids.add(localUuid.toLowerCase()); }
    const belonging = childText(properties, 'ObjectBelonging');
    const anchor = childText(properties, 'ExtendedConfigurationObject');
    const name = childText(properties, 'Name');
    if (belonging === 'Adopted' || anchor !== undefined) {
      if (belonging !== 'Adopted' || !anchor) {
        addIssue(issues, side, localUuid ? `uuid=${localUuid.toLowerCase()}` : parentKey, undefined, `Adopted ${childType} не содержит однозначный ExtendedConfigurationObject.`);
        continue;
      }
      const anchorKey = `${childType.toLowerCase()}\0${anchor.toLowerCase()}`;
      if (seenAnchors.has(anchorKey)) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, undefined, `Для ${childType} повторяется anchor ${anchor}.`);
        continue;
      }
      seenAnchors.add(anchorKey);
      if (!localUuid || same(localUuid, anchor)) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, undefined, 'Adopted child требует локальный UUID, отличный от CF anchor UUID.');
        continue;
      }
      const originalBaseContainers = direct(input.baseOrderParent, 'ChildObjects');
      if (originalBaseContainers.length !== 1) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, undefined,
          `В исходном base отсутствует однозначный ChildObjects для adopted ${childType} anchor ${anchor}.`);
        continue;
      }
      const originalBaseMatches = elementChildren(originalBaseContainers[0]!).filter((candidate) => inMetadataNamespace(candidate)
        && candidate.localName === childType
        && same(attribute(candidate, 'uuid'), anchor));
      if (originalBaseMatches.length !== 1) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, undefined, originalBaseMatches.length === 0
          ? `Для adopted ${childType} отсутствует child исходного base с точным anchor UUID ${anchor}.`
          : `Anchor UUID ${anchor} неоднозначен среди ${childType} исходного base.`);
        continue;
      }
      if (!logicalContainer) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, undefined, `В logical base отсутствует ChildObjects для adopted ${childType} anchor ${anchor}.`);
        continue;
      }
      const matches = elementChildren(logicalContainer).filter((candidate) => inMetadataNamespace(candidate)
        && candidate.localName === childType
        && same(attribute(candidate, 'uuid'), anchor));
      if (matches.length !== 1) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, undefined, matches.length === 0
          ? `Для adopted ${childType} отсутствует logical child с точным anchor UUID ${anchor}.`
          : `Anchor UUID ${anchor} неоднозначен среди logical ${childType}.`);
        continue;
      }
      const baseChild = matches[0]!;
      const baseProperties = direct(baseChild, 'Properties')[0];
      const baseName = baseProperties ? childText(baseProperties, 'Name') : undefined;
      if (!name || !same(name, baseName)) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, 'Name', 'Имя adopted child отличается от child точного anchor UUID.');
        continue;
      }
      if (localUuid && elementChildren(logicalContainer).some((sibling) => sibling !== baseChild
        && same(attribute(sibling, 'uuid'), localUuid))) {
        addIssue(issues, side, `uuid=${localUuid.toLowerCase()}`, undefined, 'Локальный UUID adopted child конфликтует с другим child target.');
        continue;
      }
      if (!baseProperties) {
        addIssue(issues, side, `uuid=${anchor.toLowerCase()}`, undefined, 'В base adopted child отсутствует Properties.');
        continue;
      }
      projectAdoptedProperties({
        target: baseProperties,
        overlay: properties,
        states: stateMap(overlayChild, side, `uuid=${anchor.toLowerCase()}`, issues),
        side,
        ownerKey: `uuid=${anchor.toLowerCase()}`,
        formatVersion,
        issues,
        typeIdResolver,
      });
      projectAdoptedDesignerChildren({
        ...input,
        adoptedParent: overlayChild,
        logicalParent: baseChild,
        baseOrderParent: originalBaseMatches[0]!,
        parentKey: `uuid=${anchor.toLowerCase()}`,
      });
      continue;
    }
    // An own child is a complete local object. Keep its local identity and payload.
    if (!localUuid || !name) {
      addIssue(issues, side, parentKey, undefined, `Собственный child ${childType} не имеет UUID или Name.`);
      continue;
    }
    const collision = logicalContainer && elementChildren(logicalContainer).find((candidate) => candidate.localName === childType
      && same(attribute(candidate, 'uuid'), localUuid));
    if (collision) {
      addIssue(issues, side, `uuid=${localUuid.toLowerCase()}`, undefined, `Собственный child UUID ${localUuid} конфликтует с base child.`);
      continue;
    }
    const sameName = logicalContainer && elementChildren(logicalContainer).find((candidate) => candidate.localName === childType
      && same(childText(direct(candidate, 'Properties')[0] ?? candidate, 'Name'), name));
    if (sameName) {
      addIssue(issues, side, `uuid=${localUuid.toLowerCase()}`, undefined, `Собственный child ${childType}.${name} конфликтует по имени с base child.`);
      continue;
    }
    const own = cloneWithNamespaces(overlayChild);
    if (!logicalContainer) {
      const prefix = prefixForNamespace(logicalParent, MDCLASSES_NAMESPACE, 'md');
      logicalContainer = makeElement(`${prefix}:ChildObjects`);
      attach(logicalParent, logicalContainer);
    }
    attach(logicalContainer, own);
  }
  projectAdoptedMetadataOrder({
    baseParent: input.baseOrderParent,
    physicalParent: adoptedParent,
    logicalParent,
    side,
    ownerKey: parentKey,
    issues,
  });
}
