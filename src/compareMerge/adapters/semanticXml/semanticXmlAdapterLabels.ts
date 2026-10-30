import type { AdapterCompareInput } from '../mergeAdapter';
import type { XmlElementNode } from './semanticXmlAdapter';
import { localXmlName } from './semanticXmlIdentity';

export function childText(element: XmlElementNode | undefined, childName: string): string | undefined {
  return element?.children.find((child) => localXmlName(child.name) === childName)?.text;
}

export function elementDisplayName(element: XmlElementNode): string {
  if (localXmlName(element.name) === 'Event' && localXmlName(element.parent?.name ?? '') === 'Events') {
    const eventName = element.attributes.name ?? element.attributes.Name;
    return eventName ? 'Событие: ' + eventName : 'Событие';
  }
  const properties = element.children.find((child) => localXmlName(child.name) === 'Properties');
  return childText(element, 'Name') ??
    childText(properties, 'Name') ??
    element.attributes.name ??
    element.attributes.Name ??
    element.attributes.id ??
    element.attributes.ID ??
    element.attributes.uuid ??
    element.attributes.UUID ??
    element.name;
}

export function linkedEventHandlerAllowed(element: XmlElementNode, input: AdapterCompareInput): boolean {
  const handlerName = element.text?.trim();
  if (!handlerName) {
    return false;
  }
  const capabilities = input.linkedDesignerContext?.formEventHandlers
    .filter((handler) => handler.name === handlerName) ?? [];
  return capabilities.length === 1 &&
    (capabilities[0]!.targetHasHandler || Boolean(capabilities[0]!.incomingRoutineNodeId));
}

export function linkedMetadataRegistrationAllowed(element: XmlElementNode, input: AdapterCompareInput): boolean {
  const kind = localXmlName(element.name);
  const name = element.text?.trim().normalize('NFC');
  if (!name || !['Form', 'Template', 'Command'].includes(kind)) {
    return false;
  }
  const capabilities = input.linkedDesignerContext?.registrations
    .filter((registration) => registration.kind === kind && registration.name.normalize('NFC') === name && registration.packageId.trim().length > 0) ?? [];
  return capabilities.length === 1;
}

export function linkedDefaultObjectFormAllowed(element: XmlElementNode, input: AdapterCompareInput): boolean {
  const value = element.text?.trim();
  const propertyName = localXmlName(element.name);
  if (!value) {
    return false;
  }
  const capabilities = input.linkedDesignerContext?.defaultObjectForms
    .filter((form) => form.propertyName === propertyName && form.value === value
      && (form.targetFormComplete || Boolean(form.packageId?.trim()))) ?? [];
  return capabilities.length === 1;
}
