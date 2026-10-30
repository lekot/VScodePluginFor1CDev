import type { CompareTreeNode } from '../compareTreeTypes';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { buildXmlAddress, elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { parseXmlAddressPointer, type XmlAddressSegment } from '../xml/xmlAddress';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface AdoptedTemplateTypeGuard {
  readonly changedPaths: readonly (readonly XmlAddressSegment[])[];
  readonly reason: string;
}

/** A type change requires a linked body bundle, which the adopted route does not yet capture. */
export function createAdoptedTemplateTypeGuard(
  targetXml: string,
  sourceXml: string,
): AdoptedTemplateTypeGuard | undefined {
  const targetTypes = templateTypeValues(targetXml);
  const sourceTypes = templateTypeValues(sourceXml);
  const keys = new Set([...targetTypes.keys(), ...sourceTypes.keys()]);
  const changedPaths: XmlAddressSegment[][] = [];
  for (const key of keys) {
    if (targetTypes.get(key)?.value === sourceTypes.get(key)?.value) { continue; }
    const target = targetTypes.get(key);
    const source = sourceTypes.get(key);
    if (target) { changedPaths.push(target.path); }
    if (source) { changedPaths.push(source.path); }
  }
  if (changedPaths.length === 0) { return undefined; }
  return {
    changedPaths,
    reason: 'Изменение TemplateType доступно только вместе с проверенным пакетом тела макета; adopted-перенос такого пакета пока не поддерживается.',
  };
}

/** Blocks scalar and ancestor/subtree XML operations that could change a selected TemplateType. */
export function adoptedTemplateTypeGuardReason(
  node: CompareTreeNode,
  guard: AdoptedTemplateTypeGuard | undefined,
): string | undefined {
  if (!guard || !node.payloadRef?.startsWith('xmlPatch:')) { return undefined; }
  let candidatePath: XmlAddressSegment[];
  try {
    candidatePath = parseXmlAddressPointer(node.payloadRef.slice('xmlPatch:'.length));
  } catch {
    return undefined;
  }
  return guard.changedPaths.some((changedPath) => pathsOverlap(candidatePath, changedPath))
    ? guard.reason
    : undefined;
}

function templateTypeValues(xml: string): Map<string, { value: string; path: XmlAddressSegment[] }> {
  const result = new Map<string, { value: string; path: XmlAddressSegment[] }>();
  const root = parseXmlDocument(xml).root;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.localName === 'TemplateType' && namespaceUriForName(current) === MDCLASSES_NAMESPACE) {
      const pointer = buildXmlAddress('adopted-template-type.xml', current).pointer;
      result.set(pointer, { value: textContent(current), path: parseXmlAddressPointer(pointer) });
    }
    pending.push(...elementChildren(current));
  }
  return result;
}

function pathsOverlap(left: readonly XmlAddressSegment[], right: readonly XmlAddressSegment[]): boolean {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    if (left[index]!.localName !== right[index]!.localName || left[index]!.selector !== right[index]!.selector) {
      return false;
    }
  }
  return true;
}
