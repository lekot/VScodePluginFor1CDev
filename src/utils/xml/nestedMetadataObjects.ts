import { INLINE_METADATA_CHILD_TYPES } from '../../constants/inlineMetadataChildren';
import type { MetadataObjectPathSegment } from '../../types/metadataObjectPath';

export interface NamedMetadataChild {
  type: string;
  name: string;
  value: Record<string, unknown>;
}

function localName(key: string): string {
  return key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
}

function records(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function valuesByLocalName(record: Record<string, unknown>, expectedName: string): unknown[] {
  return Object.entries(record)
    .filter(([key]) => localName(key) === expectedName)
    .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

function firstRecordByLocalName(record: Record<string, unknown>, expectedName: string): Record<string, unknown> | undefined {
  return records(valuesByLocalName(record, expectedName))[0];
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? textValue(value[0]) : '';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('#text' in record) {
      return textValue(record['#text']);
    }
  }
  return '';
}

export function getMetadataElementName(element: Record<string, unknown>): string {
  const properties = firstRecordByLocalName(element, 'Properties');
  if (!properties) {
    return '';
  }
  for (const [key, value] of Object.entries(properties)) {
    if (localName(key) === 'Name') {
      return textValue(value);
    }
  }
  return '';
}

function rootContainer(parsed: unknown): Record<string, unknown> | undefined {
  const rootRecords = records(parsed);
  const firstRoot = rootRecords[0];
  if (!firstRoot) {
    return undefined;
  }
  const metadataObjects = records(valuesByLocalName(firstRoot, 'MetaDataObject'));
  return metadataObjects[0] ?? firstRoot;
}

function namedElements(
  container: Record<string, unknown>,
  segment: MetadataObjectPathSegment,
): Record<string, unknown>[] {
  return valuesByLocalName(container, segment.type)
    .flatMap((value) => records(value))
    .filter((element) => getMetadataElementName(element) === segment.name);
}

function childObjects(element: Record<string, unknown>): Record<string, unknown> | undefined {
  return firstRecordByLocalName(element, 'ChildObjects');
}

/** Resolve an exact root-to-leaf metadata path. Every child segment is scoped to its parent's ChildObjects. */
export function findMetadataElementByPath(
  parsed: unknown,
  nestedPath: readonly MetadataObjectPathSegment[],
): Record<string, unknown> {
  if (nestedPath.length < 2) {
    throw new Error('A nested metadata selector must include a root object and at least one child.');
  }

  const root = rootContainer(parsed);
  if (!root) {
    throw new Error(`Metadata root "${nestedPath[0].type}.${nestedPath[0].name}" not found.`);
  }

  const rootMatches = namedElements(root, nestedPath[0]);
  if (rootMatches.length === 0) {
    throw new Error(`Metadata root "${nestedPath[0].type}.${nestedPath[0].name}" not found.`);
  }
  if (rootMatches.length > 1) {
    throw new Error(`Metadata root "${nestedPath[0].type}.${nestedPath[0].name}" is ambiguous.`);
  }

  let selected = rootMatches[0];
  for (const segment of nestedPath.slice(1)) {
    const children = childObjects(selected);
    if (!children) {
      throw new Error(`ChildObjects not found before "${segment.type}.${segment.name}".`);
    }
    const matches = namedElements(children, segment);
    if (matches.length === 0) {
      throw new Error(`Nested element "${segment.type}.${segment.name}" not found inside its parent.`);
    }
    if (matches.length > 1) {
      throw new Error(`Nested element "${segment.type}.${segment.name}" is ambiguous inside its parent.`);
    }
    selected = matches[0];
  }
  return selected;
}

/** Read the direct, supported named inline children of an exact metadata path. */
export function listNamedMetadataChildren(
  parsed: unknown,
  parentPath: readonly MetadataObjectPathSegment[],
): NamedMetadataChild[] {
  const parent = parentPath.length === 1
    ? findMetadataRootByPath(parsed, parentPath)
    : findMetadataElementByPath(parsed, parentPath);
  if (!parent) {
    throw new Error(`Metadata object "${parentPath[0]?.type}.${parentPath[0]?.name}" not found.`);
  }
  const allowedTypes = INLINE_METADATA_CHILD_TYPES[parentPath[parentPath.length - 1].type] ?? [];
  const children = childObjects(parent);
  if (!children) {
    return [];
  }

  const result: NamedMetadataChild[] = [];
  for (const type of allowedTypes) {
    for (const value of valuesByLocalName(children, type)) {
      for (const child of records(value)) {
        const name = getMetadataElementName(child);
        if (name) {
          result.push({ type, name, value: child });
        }
      }
    }
  }
  return result;
}

/** Find the root metadata element corresponding to a root-to-leaf selector. */
export function findMetadataRootByPath(
  parsed: unknown,
  nestedPath: readonly MetadataObjectPathSegment[],
): Record<string, unknown> {
  const root = rootContainer(parsed);
  const segment = nestedPath[0];
  const matches = root ? namedElements(root, segment) : [];
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Metadata root "${segment.type}.${segment.name}" not found.`
      : `Metadata root "${segment.type}.${segment.name}" is ambiguous.`);
  }
  return matches[0];
}
