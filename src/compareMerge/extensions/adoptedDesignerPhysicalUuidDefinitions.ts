import { elementChildren, parseXmlDocument, type XmlElement } from '../xml/xmlDom';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type IntroducedMetadataUuidDefinitions =
  | { readonly ok: true; readonly uuids: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Finds physical descriptor UUID definitions added by an adopted materialization. */
export function introducedAdoptedDescriptorUuidDefinitions(
  capturedTargetXml: Buffer,
  materializedXml: Buffer,
): IntroducedMetadataUuidDefinitions {
  const target = readDescriptorDefinitionCounts(capturedTargetXml);
  if (!target.ok) { return target; }
  const materialized = readDescriptorDefinitionCounts(materializedXml);
  if (!materialized.ok) { return materialized; }

  const introduced: string[] = [];
  for (const [uuid, count] of materialized.counts) {
    const previousCount = target.counts.get(uuid) ?? 0;
    if (count <= previousCount) { continue; }
    if (!isUsableUuid(uuid)) {
      return { ok: false, reason: `Материализованный descriptor добавляет некорректное physical UUID definition ${uuid}.` };
    }
    if (count > 1) {
      return { ok: false, reason: `Материализованный descriptor содержит повторное physical UUID definition ${uuid}.` };
    }
    introduced.push(uuid);
  }
  return { ok: true, uuids: introduced };
}

function readDescriptorDefinitionCounts(
  xml: Buffer,
): { readonly ok: true; readonly counts: ReadonlyMap<string, number> } | { readonly ok: false; readonly reason: string } {
  try {
    const envelope = parseXmlDocument(xml.toString('utf8')).root;
    if (expandedName(envelope) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`) {
      return { ok: false, reason: 'Adopted physical UUID proof требует MDClasses/MetaDataObject descriptor.' };
    }
    const roots = elementChildren(envelope).filter((element) => namespaceOf(element) === MDCLASSES_NAMESPACE);
    if (roots.length !== 1) {
      return { ok: false, reason: 'Adopted physical UUID proof требует ровно один MDClasses root object.' };
    }

    const counts = new Map<string, number>();
    const rootUuid = unqualifiedAttribute(roots[0]!, 'uuid');
    if (!rootUuid || !isUsableUuid(rootUuid)) {
      return { ok: false, reason: 'Adopted physical UUID proof обнаружил некорректный UUID root definition.' };
    }
    addUuid(counts, rootUuid);
    const descendants = collectChildDefinitions(roots[0]!, counts);
    if (descendants) { return { ok: false, reason: descendants }; }
    return { ok: true, counts };
  } catch (error) {
    return {
      ok: false,
      reason: `Не удалось разобрать adopted physical UUID definitions: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function collectChildDefinitions(parent: XmlElement, counts: Map<string, number>): string | undefined {
  const containers = elementChildren(parent).filter((element) =>
    element.localName === 'ChildObjects' && namespaceOf(element) === MDCLASSES_NAMESPACE,
  );
  if (containers.length > 1) { return 'Adopted physical UUID proof обнаружил повторные ChildObjects.'; }
  for (const child of containers.flatMap(elementChildren)) {
    if (namespaceOf(child) !== MDCLASSES_NAMESPACE) { continue; }
    const uuid = unqualifiedAttribute(child, 'uuid');
    if (uuid !== undefined) {
      addUuid(counts, uuid);
    }
    const nestedError = collectChildDefinitions(child, counts);
    if (nestedError) { return nestedError; }
  }
  return undefined;
}

function addUuid(counts: Map<string, number>, value: string): void {
  const normalized = normalizeUuid(value);
  counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
}

function expandedName(element: XmlElement): string {
  return `{${namespaceOf(element) ?? ''}}${element.localName}`;
}

function namespaceOf(element: XmlElement): string | undefined {
  const prefix = element.name.includes(':') ? element.name.slice(0, element.name.indexOf(':')) : '';
  const declaration = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const found = current.attributes.find((attribute) => attribute.name === declaration);
    if (found) { return found.value || undefined; }
    current = current.parent;
  }
  return undefined;
}

function unqualifiedAttribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

function isUsableUuid(value: string): boolean {
  return UUID_PATTERN.test(value) && normalizeUuid(value) !== ZERO_UUID;
}

function normalizeUuid(value: string): string { return value.toLowerCase(); }
