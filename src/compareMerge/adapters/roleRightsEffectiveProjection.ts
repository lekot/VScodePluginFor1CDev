import {
  captureXmlSubtree,
  cloneXmlElement,
  elementChildren,
  parseXmlDocument,
  serializeXmlDocument,
  textContent,
  type XmlChildNode,
  type XmlDocument,
  type XmlElement,
} from '../xml/xmlDom';
import { namespaceUriForName } from './semanticXml/semanticXmlIdentity';
import { ROLE_RIGHTS_NAMESPACE } from './semanticXml/semanticXmlRights';

const OMITTED_RIGHT_FORMATS = new Set(['2.19', '2.20', '2.21']);
const ROOT_POLICY_NAMES = [
  'setForNewObjects',
  'setForAttributesByDefault',
  'independentRightsOfChildObjects',
] as const;

export interface RoleRightsProjectionIssue {
  readonly scope: 'right' | 'policy' | 'file';
  readonly objectQualifiedName?: string;
  readonly rightName?: string;
  readonly policyName?: typeof ROOT_POLICY_NAMES[number];
  readonly reason: string;
}

export interface RoleRightsPairProjection {
  /** Compare-only source view; callers keep physical input bytes and witnesses unchanged. */
  readonly comparisonSourceXml: string;
  readonly issues: readonly RoleRightsProjectionIssue[];
}

interface RightsPolicy {
  readonly version?: string;
  readonly supportsOmittedDefault: boolean;
  readonly values: ReadonlyMap<typeof ROOT_POLICY_NAMES[number], boolean>;
}

interface RightsObjectRecord {
  readonly name: string;
  readonly element: XmlElement;
  duplicate: boolean;
}

interface RightsRecord {
  readonly key: string;
  readonly objectName: string;
  readonly rightName: string;
  readonly object: RightsObjectRecord;
  element: XmlElement;
  value?: boolean;
  issue?: string;
  readonly simple: boolean;
}

interface RightsSnapshot {
  readonly document: XmlDocument;
  readonly root: XmlElement;
  readonly policy: RightsPolicy;
  readonly objects: Map<string, RightsObjectRecord>;
  readonly rights: Map<string, RightsRecord>;
}

/**
 * Makes source Rights.xml comparable under the target's root default without changing
 * either physical artifact. Only top-level `Type.Name` omissions are interpreted.
 */
export function projectRoleRightsPair(input: {
  readonly targetXml: string;
  readonly sourceXml: string;
}): RoleRightsPairProjection {
  let target: RightsSnapshot;
  let source: RightsSnapshot;
  try {
    target = readSnapshot(input.targetXml);
    source = readSnapshot(input.sourceXml);
  } catch (error) {
    return {
      comparisonSourceXml: input.sourceXml,
      issues: [{ scope: 'file', reason: error instanceof Error ? error.message : String(error) }],
    };
  }

  const issues: RoleRightsProjectionIssue[] = [];
  for (const name of ROOT_POLICY_NAMES) {
    if (target.policy.values.get(name) !== source.policy.values.get(name)) {
      issues.push({
        scope: 'policy',
        policyName: name,
        reason: `Флаг ${name} задаёт политику для набора прав и доступен только для чтения в этом переносе.`,
      });
    }
  }

  const keys = new Set([...target.rights.keys(), ...source.rights.keys()]);
  for (const key of keys) {
    const targetRight = target.rights.get(key);
    const sourceRight = source.rights.get(key);
    const objectName = targetRight?.objectName ?? sourceRight?.objectName;
    const rightName = targetRight?.rightName ?? sourceRight?.rightName;
    if (!objectName || !rightName) {continue;}

    if (targetRight?.object.duplicate || sourceRight?.object.duplicate) {
      pushRightIssue(issues, objectName, rightName, 'Имя объекта прав повторяется; соответствие права неоднозначно.');
      continue;
    }
    const rightIssue = targetRight?.issue ?? sourceRight?.issue;
    if (rightIssue) {
      pushRightIssue(issues, objectName, rightName, rightIssue);
      continue;
    }

    const nestedPolicyChanged = objectName.split('.').length > 2
      && (target.policy.values.get('setForAttributesByDefault') !== source.policy.values.get('setForAttributesByDefault')
        || target.policy.values.get('independentRightsOfChildObjects') !== source.policy.values.get('independentRightsOfChildObjects'));
    if (nestedPolicyChanged && !sameRightXml(targetRight?.element, sourceRight?.element)) {
      pushRightIssue(issues, objectName, rightName, 'Политика реквизитов или независимых прав подчинённых объектов отличается; это вложенное право доступно только для чтения.');
      continue;
    }

    if (targetRight && sourceRight && targetRight.value !== undefined && sourceRight.value !== undefined) {
      if (!targetRight.simple || !sourceRight.simple) {
        if (!sameRightXml(targetRight.element, sourceRight.element)) {
          pushRightIssue(issues, objectName, rightName, 'Право содержит RLS или неизвестные данные; оно доступно только для чтения.');
        }
        continue;
      }
      if (targetRight.value === sourceRight.value) {
        replaceSourceRight(source, sourceRight, targetRight.element);
      }
      continue;
    }

    const targetValue = effectiveValue(targetRight, objectName, target.policy);
    const sourceValue = effectiveValue(sourceRight, objectName, source.policy);
    const targetDefault = omittedDefault(objectName, target.policy);
    if (targetValue === undefined || sourceValue === undefined || targetDefault === undefined) {
      if (!sameRightXml(targetRight?.element, sourceRight?.element)) {
        pushRightIssue(issues, objectName, rightName,
          'Для этого права нельзя подтвердить значение пропуска по версии и области объекта; оно доступно только для чтения.');
      }
      continue;
    }

    if (targetRight && !targetRight.simple || sourceRight && !sourceRight.simple) {
      if (!sameRightXml(targetRight?.element, sourceRight?.element)) {
        pushRightIssue(issues, objectName, rightName, 'Право содержит RLS или неизвестные данные; оно доступно только для чтения.');
      }
      continue;
    }

    if (targetValue === sourceValue) {
      if (targetRight) {
        replaceSourceRight(source, sourceRight, targetRight.element);
      } else {
        removeSourceRight(source, sourceRight);
      }
    } else if (sourceValue === targetDefault) {
      removeSourceRight(source, sourceRight);
    } else {
      writeSourceRight(source, sourceRight, objectName, rightName, sourceValue);
    }
  }

  return {
    comparisonSourceXml: serializeXmlDocument(source.document),
    issues: deduplicateIssues(issues),
  };
}

function readSnapshot(xml: string): RightsSnapshot {
  const document = parseXmlDocument(xml);
  if (document.root.localName !== 'Rights' || namespaceUriForName(document.root) !== ROLE_RIGHTS_NAMESPACE) {
    throw new Error('Корневой элемент Rights.xml использует неподдерживаемое пространство имён.');
  }
  const root = document.root;
  const version = root.attributes.find((attribute) => attribute.name === 'version')?.value.trim();
  const policyValues = new Map<typeof ROOT_POLICY_NAMES[number], boolean>();
  for (const name of ROOT_POLICY_NAMES) {
    const fields = direct(root, name);
    if (fields.length !== 1) {continue;}
    const value = readBoolean(textContent(fields[0]!).trim());
    if (value !== undefined) {policyValues.set(name, value);}
  }

  const objects = new Map<string, RightsObjectRecord>();
  const rights = new Map<string, RightsRecord>();
  for (const objectElement of direct(root, 'object')) {
    const names = direct(objectElement, 'name');
    if (names.length !== 1 || !isTextOnly(names[0]!)) {continue;}
    const objectName = textContent(names[0]!).trim();
    if (!objectName) {continue;}
    const key = normalize(objectName);
    const priorObject = objects.get(key);
    if (priorObject) {priorObject.duplicate = true;}
    const object = priorObject ?? { name: objectName, element: objectElement, duplicate: false };
    if (!priorObject) {objects.set(key, object);}

    for (const rightElement of direct(objectElement, 'right')) {
      const rightNames = direct(rightElement, 'name');
      const values = direct(rightElement, 'value');
      if (rightNames.length !== 1 || values.length !== 1 || !isTextOnly(rightNames[0]!) || !isTextOnly(values[0]!)) {continue;}
      const rightName = textContent(rightNames[0]!).trim();
      if (!rightName) {continue;}
      const rightKey = rightsKey(objectName, rightName);
      const rawValue = readBoolean(textContent(values[0]!).trim());
      const previous = rights.get(rightKey);
      const issue = previous
        ? 'Одно и то же право объекта повторяется; соответствие неоднозначно.'
        : rawValue === undefined ? 'Значение права должно быть строго true или false.' : undefined;
      const record: RightsRecord = {
        key: rightKey,
        objectName,
        rightName,
        object,
        element: rightElement,
        ...(rawValue !== undefined ? { value: rawValue } : {}),
        ...(issue ? { issue } : {}),
        simple: isSimpleRight(rightElement, rightNames[0]!, values[0]!),
      };
      rights.set(rightKey, record);
    }
  }

  return {
    document,
    root,
    policy: { version, supportsOmittedDefault: version !== undefined && OMITTED_RIGHT_FORMATS.has(version), values: policyValues },
    objects,
    rights,
  };
}

function effectiveValue(record: RightsRecord | undefined, objectName: string, policy: RightsPolicy): boolean | undefined {
  if (record?.value !== undefined) {return record.value;}
  if (record?.issue) {return undefined;}
  return omittedDefault(objectName, policy);
}

function omittedDefault(objectName: string, policy: RightsPolicy): boolean | undefined {
  if (!policy.supportsOmittedDefault || objectName.split('.').length !== 2) {return undefined;}
  return policy.values.get('setForNewObjects');
}

function replaceSourceRight(source: RightsSnapshot, existing: RightsRecord | undefined, target: XmlElement): void {
  const sourceObject = existing?.object ?? ensureSourceObject(source, parentObjectName(target));
  const clone = cloneInNamespace(target, source.root);
  const current = existing?.element;
  if (current) {
    replaceChild(sourceObject.element, current, clone);
  } else {
    sourceObject.element.children.push(clone);
    clone.parent = sourceObject.element;
  }
  const targetName = direct(target.parent!, 'name')[0];
  const targetObjectName = targetName ? textContent(targetName).trim() : existing?.objectName;
  const targetRightName = direct(target, 'name')[0];
  const rightName = targetRightName ? textContent(targetRightName).trim() : existing?.rightName;
  if (targetObjectName && rightName) {
    const key = rightsKey(targetObjectName, rightName);
    const value = readBoolean(textContent(direct(target, 'value')[0] ?? target).trim());
    source.rights.set(key, {
      key, objectName: targetObjectName, rightName, object: sourceObject, element: clone,
      ...(value !== undefined ? { value } : {}), simple: true,
    });
  }
}

function parentObjectName(right: XmlElement): string {
  const object = right.parent;
  const name = object ? direct(object, 'name')[0] : undefined;
  return name ? textContent(name).trim() : '';
}

function removeSourceRight(source: RightsSnapshot, existing: RightsRecord | undefined): void {
  if (!existing) {return;}
  const siblings = existing.object.element.children;
  const index = siblings.indexOf(existing.element);
  if (index >= 0) {siblings.splice(index, 1);}
  source.rights.delete(existing.key);
}

function writeSourceRight(
  source: RightsSnapshot,
  existing: RightsRecord | undefined,
  objectName: string,
  rightName: string,
  value: boolean,
): void {
  const object = existing?.object ?? ensureSourceObject(source, objectName);
  const replacement = createSimpleRight(source.root, rightName, value);
  if (existing) {
    replaceChild(object.element, existing.element, replacement);
  } else {
    object.element.children.push(replacement);
    replacement.parent = object.element;
  }
  source.rights.set(rightsKey(objectName, rightName), {
    key: rightsKey(objectName, rightName), objectName, rightName, object,
    element: replacement, value, simple: true,
  });
}

function ensureSourceObject(source: RightsSnapshot, objectName: string): RightsObjectRecord {
  const key = normalize(objectName);
  const current = source.objects.get(key);
  if (current) {return current;}
  const object = createElementLike(source.root, 'object');
  object.children.push(createTextElement(object, 'name', objectName, object));
  source.root.children.push(object);
  object.parent = source.root;
  const record: RightsObjectRecord = { name: objectName, element: object, duplicate: false };
  source.objects.set(key, record);
  return record;
}

function createSimpleRight(root: XmlElement, rightName: string, value: boolean): XmlElement {
  const right = createElementLike(root, 'right');
  right.children.push(createTextElement(right, 'name', rightName, right));
  right.children.push(createTextElement(right, 'value', String(value), right));
  return right;
}

function createTextElement(root: XmlElement, localName: string, value: string, parent: XmlElement): XmlElement {
  const element = createElementLike(root, localName);
  element.parent = parent;
  element.children.push({ kind: 'text', text: value });
  return element;
}

function createElementLike(root: XmlElement, localName: string): XmlElement {
  const prefix = prefixOf(root.name);
  return {
    kind: 'element',
    name: prefix ? `${prefix}:${localName}` : localName,
    localName,
    attributes: [],
    children: [],
    parent: root,
  };
}

function cloneInNamespace(element: XmlElement, root: XmlElement): XmlElement {
  const clone = cloneXmlElement(element);
  const prefix = prefixOf(root.name);
  const rename = (current: XmlElement, parent?: XmlElement): void => {
    current.parent = parent;
    if (current.localName === 'right' || current.localName === 'name' || current.localName === 'value') {
      current.name = prefix ? `${prefix}:${current.localName}` : current.localName;
    }
    for (const child of elementChildren(current)) {rename(child, current);}
  };
  rename(clone);
  return clone;
}

function replaceChild(parent: XmlElement, existing: XmlElement, replacement: XmlElement): void {
  const index = parent.children.indexOf(existing);
  if (index < 0) {return;}
  replacement.parent = parent;
  parent.children[index] = replacement;
}

function isSimpleRight(right: XmlElement, name: XmlElement, value: XmlElement): boolean {
  return onlyNamespaceAttributes(right)
    && onlyWhitespaceText(right.children)
    && elementChildren(right).length === 2
    && elementChildren(right)[0] === name
    && elementChildren(right)[1] === value
    && direct(right, 'name').length === 1
    && direct(right, 'value').length === 1
    && onlyNamespaceAttributes(name) && onlyNamespaceAttributes(value)
    && isTextOnly(name) && isTextOnly(value);
}

function onlyNamespaceAttributes(element: XmlElement): boolean {
  return element.attributes.every((attribute) => attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:'));
}

function isTextOnly(element: XmlElement): boolean {
  return onlyNamespaceAttributes(element) && element.children.every((child) => child.kind === 'text' || child.kind === 'cdata');
}

function onlyWhitespaceText(children: readonly XmlChildNode[]): boolean {
  return children.every((child) => child.kind === 'element' || (child.kind === 'text' && child.text.trim() === ''));
}

function sameRightXml(left?: XmlElement, right?: XmlElement): boolean {
  if (!left || !right) {return left === right;}
  return captureXmlSubtree(left) === captureXmlSubtree(right);
}

function direct(parent: XmlElement, name: string): XmlElement[] {
  return elementChildren(parent).filter((element) =>
    element.localName === name && namespaceUriForName(element) === ROLE_RIGHTS_NAMESPACE,
  );
}

function readBoolean(value: string): boolean | undefined {
  if (value === 'true') {return true;}
  if (value === 'false') {return false;}
  return undefined;
}

function rightsKey(objectName: string, rightName: string): string {
  return `${normalize(objectName)}\u0000${normalize(rightName)}`;
}

function normalize(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('en-US');
}

function prefixOf(name: string): string {
  const separator = name.indexOf(':');
  return separator < 0 ? '' : name.slice(0, separator);
}

function pushRightIssue(issues: RoleRightsProjectionIssue[], objectQualifiedName: string, rightName: string, reason: string): void {
  issues.push({ scope: 'right', objectQualifiedName, rightName, reason });
}

function deduplicateIssues(issues: readonly RoleRightsProjectionIssue[]): RoleRightsProjectionIssue[] {
  const result = new Map<string, RoleRightsProjectionIssue>();
  for (const issue of issues) {
    const key = [issue.scope, issue.objectQualifiedName, issue.rightName, issue.policyName].join('\u0000');
    result.set(key, issue);
  }
  return [...result.values()];
}
