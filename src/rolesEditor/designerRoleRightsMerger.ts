import { XMLValidator } from 'fast-xml-parser';
import { getRoleRightByKey, getRoleRightByXmlName, ROLE_RIGHTS_REGISTRY } from './roleRightsRegistry';
import { createEmptyObjectRights, type RightsMap } from './models/roleModel';

const MD_CLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

interface XmlNode {
  readonly name: string;
  readonly localName: string;
  readonly namespaceUri: string;
  readonly namespaceBindings: ReadonlyMap<string, string>;
  readonly start: number;
  readonly openEnd: number;
  readonly selfClosing: boolean;
  readonly parent?: XmlNode;
  readonly children: XmlNode[];
  closeStart: number;
  end: number;
}

interface XmlPatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export type DesignerRoleRightChanges = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

function findMarkupEnd(xml: string, start: number): number {
  let quote = '';
  let subsetDepth = 0;
  for (let index = start + 1; index < xml.length; index++) {
    const char = xml[index]!;
    if (quote) {
      if (char === quote) {quote = '';}
      continue;
    }
    if (char === '"' || char === "'") {quote = char; continue;}
    if (xml.startsWith('<!DOCTYPE', start) && char === '[') {subsetDepth++; continue;}
    if (xml.startsWith('<!DOCTYPE', start) && char === ']') {subsetDepth--; continue;}
    if (char === '>' && subsetDepth === 0) {return index + 1;}
  }
  throw new Error('Malformed Designer Role.xml: unterminated markup.');
}

function localName(name: string): string {
  const separator = name.lastIndexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}

function namespaceDeclarations(markup: string, inherited?: ReadonlyMap<string, string>): Map<string, string> {
  const bindings = new Map(inherited ?? [['xml', 'http://www.w3.org/XML/1998/namespace'], ['', '']]);
  const declaration = /\sxmlns(?::([\w.-]+))?\s*=\s*(["'])(.*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(markup)) !== null) {
    const prefix = match[1] ?? '';
    bindings.set(prefix, decodeXmlText(match[3] ?? ''));
  }
  return bindings;
}

function namespaceUri(name: string, bindings: ReadonlyMap<string, string>): string {
  const separator = name.indexOf(':');
  return separator < 0 ? (bindings.get('') ?? '') : (bindings.get(name.slice(0, separator)) ?? '');
}

function parseXmlNodes(xml: string): XmlNode[] {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let index = 0;

  while (index < xml.length) {
    const start = xml.indexOf('<', index);
    if (start < 0) {break;}
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end < 0) {throw new Error('Malformed Designer Role.xml: unterminated comment.');}
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) {throw new Error('Malformed Designer Role.xml: unterminated CDATA.');}
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      if (end < 0) {throw new Error('Malformed Designer Role.xml: unterminated processing instruction.');}
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!', start)) {
      index = findMarkupEnd(xml, start);
      continue;
    }

    const end = findMarkupEnd(xml, start);
    const markup = xml.slice(start, end);
    if (/^<\s*\//.test(markup)) {
      const name = /^<\s*\/\s*([^\s>]+)/.exec(markup)?.[1];
      if (!name) {throw new Error('Malformed Designer Role.xml: invalid closing tag.');}
      let node: XmlNode | undefined;
      while (stack.length > 0) {
        const candidate = stack.pop()!;
        if (candidate.name === name) {node = candidate; break;}
      }
      if (!node) {throw new Error(`Malformed Designer Role.xml: unmatched closing tag ${name}.`);}
      node.closeStart = start;
      node.end = end;
      index = end;
      continue;
    }

    const name = /^<\s*([^\s/>]+)/.exec(markup)?.[1];
    if (!name) {throw new Error('Malformed Designer Role.xml: invalid opening tag.');}
    const selfClosing = /\/\s*>$/.test(markup);
    const parent = stack[stack.length - 1];
    const bindings = namespaceDeclarations(markup, parent?.namespaceBindings);
    const node: XmlNode = {
      name,
      localName: localName(name),
      namespaceUri: namespaceUri(name, bindings),
      namespaceBindings: bindings,
      start,
      openEnd: end,
      selfClosing,
      parent,
      children: [],
      closeStart: selfClosing ? end : -1,
      end,
    };
    if (parent) {parent.children.push(node);} else {roots.push(node);}
    if (!selfClosing) {stack.push(node);}
    index = end;
  }

  if (stack.length > 0) {throw new Error(`Malformed Designer Role.xml: unclosed tag ${stack[stack.length - 1]!.name}.`);}
  return roots;
}

function walk(nodes: readonly XmlNode[], predicate: (node: XmlNode) => boolean): XmlNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) {return node;}
    const nested = walk(node.children, predicate);
    if (nested) {return nested;}
  }
  return undefined;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readSimpleText(xml: string, node: XmlNode): string {
  if (node.selfClosing) {return '';}
  const raw = xml.slice(node.openEnd, node.closeStart);
  if (raw.includes('<')) {return '';}
  return decodeXmlText(raw).trim();
}

function parseXmlBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Read Designer rights from the 1C MDClasses namespace only. This shares the
 * same namespace-aware token tree used by the lossless XML merger.
 */
export function extractDesignerRoleRightsXml(sourceXml: string): RightsMap {
  if (!sourceXml.trim()) {return {};}
  const validation = XMLValidator.validate(sourceXml);
  if (validation !== true) {
    const detail = typeof validation === 'object' ? validation.err.msg : 'Malformed XML';
    throw new Error(`Cannot parse Designer Role.xml rights: invalid source XML: ${detail}`);
  }

  const roots = parseXmlNodes(sourceXml);
  const { role, rights: rightsSection } = findRoleRights(roots);
  if (!rightsSection) {return {};}

  const knownTypes = new Set(ROLE_RIGHTS_REGISTRY.flatMap((right) => right.applicableTo));
  const result: RightsMap = {};
  for (const typeNode of rightsSection.children) {
    const typeName = typeNode.localName;
    if (typeNode.namespaceUri !== role.namespaceUri || !knownTypes.has(typeName)) {continue;}
    for (const objectNode of typeNode.children) {
      if (objectNode.localName !== 'Object' || objectNode.namespaceUri !== role.namespaceUri) {continue;}
      const objectName = getObjectName(sourceXml, objectNode, role.namespaceUri);
      if (!objectName) {continue;}
      const objectRights = createEmptyObjectRights();
      for (const rightNode of objectNode.children) {
        if (rightNode.namespaceUri !== role.namespaceUri) {continue;}
        const descriptor = getRoleRightByXmlName(rightNode.localName);
        if (!descriptor || !descriptor.applicableTo.includes(typeName)) {continue;}
        objectRights[descriptor.key] = parseXmlBoolean(readSimpleText(sourceXml, rightNode));
      }
      if (Object.values(objectRights).some((value) => value === true)) {
        result[`${typeName}.${objectName}`] = objectRights;
      }
    }
  }
  return result;
}

function findDirect(nodes: readonly XmlNode[], name: string, namespace: string): XmlNode | undefined {
  return nodes.find((node) => node.localName === name && node.namespaceUri === namespace);
}

function findRoleRights(roots: readonly XmlNode[]): { role: XmlNode; rights?: XmlNode } {
  const role = walk(roots, (node) => node.localName === 'Role' && node.namespaceUri === MD_CLASSES_NAMESPACE)
    ?? walk(roots, (node) => node.localName === 'Role' && node.namespaceUri === '');
  if (!role) {throw new Error('Designer Role.xml does not contain a Role element.');}
  const rights = findDirect(role.children, 'Rights', role.namespaceUri)
    ?? findDirect(role.children, 'ObjectRights', role.namespaceUri);
  return { role, rights };
}

function getObjectName(xml: string, object: XmlNode, namespace: string): string | undefined {
  const name = findDirect(object.children, 'Name', namespace);
  return name ? readSimpleText(xml, name) : undefined;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function prefixOf(name: string): string {
  const separator = name.indexOf(':');
  return separator < 0 ? '' : name.slice(0, separator + 1);
}

function preferredPrefix(parent: XmlNode): string {
  return prefixOf(parent.name);
}

function lineIndent(xml: string, offset: number): string | undefined {
  const lineStart = Math.max(xml.lastIndexOf('\n', offset - 1), xml.lastIndexOf('\r', offset - 1)) + 1;
  const before = xml.slice(lineStart, offset);
  return /^[\t ]*$/.test(before) ? before : undefined;
}

function indentationUnit(xml: string, parent: XmlNode, parentIndent: string): string {
  for (const child of parent.children) {
    const childIndent = lineIndent(xml, child.start);
    if (childIndent !== undefined && childIndent.startsWith(parentIndent) && childIndent.length > parentIndent.length) {
      return childIndent.slice(parentIndent.length);
    }
  }
  return xml.includes('\t') ? '\t' : '  ';
}

function insertionPatch(xml: string, parent: XmlNode, blocks: readonly string[]): XmlPatch {
  const newline = xml.includes('\r\n') ? '\r\n' : '\n';
  const closeOffset = parent.selfClosing ? parent.openEnd : parent.closeStart;
  const parentIndent = lineIndent(xml, parent.start) ?? '';
  const childIndent = parentIndent + indentationUnit(xml, parent, parentIndent);
  const closeIndent = lineIndent(xml, closeOffset);
  if (parent.selfClosing) {
    const openTag = xml.slice(parent.start, parent.openEnd).replace(/\/\s*>$/, '>');
    const content = blocks.map((block) => `${childIndent}${block}`).join(newline);
    const replacement = `${openTag}${newline}${content}${newline}${parentIndent}</${parent.name}>`;
    return { start: parent.start, end: parent.openEnd, replacement };
  }
  if (closeIndent !== undefined) {
    const lineStart = closeOffset - closeIndent.length;
    const content = blocks.map((block) => `${childIndent}${block}`).join(newline);
    return { start: lineStart, end: lineStart, replacement: `${content}${newline}` };
  }
  return { start: closeOffset, end: closeOffset, replacement: blocks.join('') };
}

function rightTag(parent: XmlNode, xmlName: string, value: boolean): string {
  const prefix = preferredPrefix(parent);
  const name = `${prefix}${xmlName}`;
  return `<${name}>${value ? 'true' : 'false'}</${name}>`;
}

function objectBlock(
  typeNode: XmlNode,
  objectName: string,
  changes: Readonly<Record<string, boolean>>,
): string {
  const prefix = preferredPrefix(typeNode);
  const objectTag = `${prefix}Object`;
  const nameTag = `${prefix}Name`;
  const rights = Object.entries(changes).map(([key, value]) => {
    const descriptor = getRoleRightByKey(key);
    if (!descriptor) {throw new Error(`Unrecognized 1C role right key: ${key}`);}
    return rightTag(typeNode, descriptor.xmlName, value);
  }).join('');
  return `<${objectTag}><${nameTag}>${xmlEscape(objectName)}</${nameTag}>${rights}</${objectTag}>`;
}

function applyPatches(xml: string, patches: readonly XmlPatch[]): string {
  const ordered = [...patches].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = xml;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const patch of ordered) {
    if (patch.end > lastStart) {throw new Error('Overlapping Designer rights XML changes.');}
    result = `${result.slice(0, patch.start)}${patch.replacement}${result.slice(patch.end)}`;
    lastStart = patch.start;
  }
  return result;
}

/**
 * Apply only explicitly changed rights to an existing Designer Role.xml.
 * Source markup outside those right values and any newly inserted right nodes is retained verbatim.
 */
export function mergeDesignerRoleRightsXml(sourceXml: string, changes: DesignerRoleRightChanges): string {
  if (!sourceXml.trim()) {throw new Error('Designer Role.xml source is empty.');}
  const validation = XMLValidator.validate(sourceXml);
  if (validation !== true) {
    const detail = typeof validation === 'object' ? validation.err.msg : 'Malformed XML';
    throw new Error(`Cannot preserve Designer Role.xml rights: invalid source XML: ${detail}`);
  }
  if (Object.keys(changes).length === 0) {return sourceXml;}

  const roots = parseXmlNodes(sourceXml);
  const { role, rights } = findRoleRights(roots);
  const patches: XmlPatch[] = [];
  const pendingByType = new Map<string, Array<{ name: string; changes: Readonly<Record<string, boolean>> }>>();

  for (const [objectFullName, rightChanges] of Object.entries(changes)) {
    const separator = objectFullName.indexOf('.');
    if (separator <= 0 || separator === objectFullName.length - 1) {
      throw new Error(`Invalid root metadata object address in role rights: ${objectFullName}`);
    }
    const typeName = objectFullName.slice(0, separator);
    const objectName = objectFullName.slice(separator + 1);
    const applicableChanges: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(rightChanges)) {
      const descriptor = getRoleRightByKey(key);
      if (!descriptor || !descriptor.applicableTo.includes(typeName)) {
        throw new Error(`Role right «${key}» is not applicable to metadata type «${typeName}».`);
      }
      applicableChanges[key] = value;
    }
    if (Object.keys(applicableChanges).length === 0) {continue;}

    const typeNode = rights && findDirect(rights.children, typeName, role.namespaceUri);
    if (!typeNode) {
      const pending = pendingByType.get(typeName) ?? [];
      pending.push({ name: objectName, changes: applicableChanges });
      pendingByType.set(typeName, pending);
      continue;
    }
    const objectNode = typeNode.children
      .filter((child) => child.localName === 'Object' && child.namespaceUri === role.namespaceUri)
      .find((candidate) => getObjectName(sourceXml, candidate, role.namespaceUri) === objectName);
    if (!objectNode) {
      const pending = pendingByType.get(typeName) ?? [];
      pending.push({ name: objectName, changes: applicableChanges });
      pendingByType.set(typeName, pending);
      continue;
    }

    const additions: string[] = [];
    for (const [key, value] of Object.entries(applicableChanges)) {
      const descriptor = getRoleRightByKey(key)!;
      const existing = findDirect(objectNode.children, descriptor.xmlName, role.namespaceUri);
      if (!existing) {
        additions.push(rightTag(objectNode, descriptor.xmlName, value));
        continue;
      }
      if (existing.selfClosing) {
        const opening = sourceXml.slice(existing.start, existing.openEnd).replace(/\/\s*>$/, '>');
        patches.push({
          start: existing.start,
          end: existing.openEnd,
          replacement: `${opening}${value ? 'true' : 'false'}</${existing.name}>`,
        });
        continue;
      }
      const inner = sourceXml.slice(existing.openEnd, existing.closeStart);
      if (inner.includes('<')) {
        throw new Error(`Cannot update complex Designer right element ${existing.name} without losing nested XML.`);
      }
      const whitespace = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      patches.push({
        start: existing.openEnd,
        end: existing.closeStart,
        replacement: `${whitespace?.[1] ?? ''}${value ? 'true' : 'false'}${whitespace?.[3] ?? ''}`,
      });
    }
    if (additions.length > 0) {patches.push(insertionPatch(sourceXml, objectNode, additions));}
  }

  if (pendingByType.size > 0) {
    if (!rights) {
      const prefix = prefixOf(role.name);
      const rightsName = `${prefix}Rights`;
      const typeBlocks = [...pendingByType.entries()].map(([typeName, objects]) => {
        const typeTag = `${prefix}${typeName}`;
        const objectXml = objects.map(({ name, changes: objectChanges }) => {
          const objectTag = `${prefix}Object`;
          const nameTag = `${prefix}Name`;
          const rightsXml = Object.entries(objectChanges).map(([key, value]) => {
            const descriptor = getRoleRightByKey(key)!;
            const rightName = `${prefix}${descriptor.xmlName}`;
            return `<${rightName}>${value ? 'true' : 'false'}</${rightName}>`;
          }).join('');
          return `<${objectTag}><${nameTag}>${xmlEscape(name)}</${nameTag}>${rightsXml}</${objectTag}>`;
        }).join('');
        return `<${typeTag}>${objectXml}</${typeTag}>`;
      }).join('');
      patches.push(insertionPatch(sourceXml, role, [`<${rightsName}>${typeBlocks}</${rightsName}>`]));
    } else {
      const typeBlocks = [...pendingByType.entries()].map(([typeName, objects]) => {
        const existingType = findDirect(rights.children, typeName, role.namespaceUri);
        if (existingType) {
          const objectsXml = objects.map(({ name, changes: objectChanges }) => objectBlock(existingType, name, objectChanges));
          patches.push(insertionPatch(sourceXml, existingType, objectsXml));
          return undefined;
        }
        const prefix = preferredPrefix(rights);
        const typeTag = `${prefix}${typeName}`;
        const objectXml = objects.map(({ name, changes: objectChanges }) => {
          const objectTag = `${prefix}Object`;
          const nameTag = `${prefix}Name`;
          const rightsXml = Object.entries(objectChanges).map(([key, value]) => {
            const descriptor = getRoleRightByKey(key)!;
            const rightName = `${prefix}${descriptor.xmlName}`;
            return `<${rightName}>${value ? 'true' : 'false'}</${rightName}>`;
          }).join('');
          return `<${objectTag}><${nameTag}>${xmlEscape(name)}</${nameTag}>${rightsXml}</${objectTag}>`;
        }).join('');
        return `<${typeTag}>${objectXml}</${typeTag}>`;
      }).filter((block): block is string => block !== undefined);
      if (typeBlocks.length > 0) {patches.push(insertionPatch(sourceXml, rights, typeBlocks));}
    }
  }

  return applyPatches(sourceXml, patches);
}
