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
import type { RoleRightsProjectionIssue } from '../adapters/roleRightsEffectiveProjection';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { ROLE_RIGHTS_NAMESPACE } from '../adapters/semanticXml/semanticXmlRights';
import { cloneWithNamespaces } from './adoptedDesignerXml';
import {
  isSupportedAdoptedDesignerDirection,
  type AdoptedDesignerDirection,
} from './adoptedDesignerProjection';

const OMITTED_DEFAULT_VERSIONS = new Set(['2.19', '2.20', '2.21']);
const SUPPORTED_RIGHTS_VERSIONS = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const ROOT_POLICY_NAMES = [
  'setForNewObjects',
  'setForAttributesByDefault',
  'independentRightsOfChildObjects',
] as const;

type RootPolicyName = typeof ROOT_POLICY_NAMES[number];

export interface AdoptedDesignerRightsProjectionInput {
  readonly direction: AdoptedDesignerDirection;
  readonly formatVersion: string;
  readonly baseRightsXml: Buffer;
  readonly targetRightsXml?: Buffer;
  readonly sourceRightsXml?: Buffer;
}

export type AdoptedDesignerRightsProjectionResult =
  | {
    readonly ok: true;
    readonly targetXml: Buffer;
    readonly sourceXml: Buffer;
    readonly issues: readonly RoleRightsProjectionIssue[];
  }
  | {
    readonly ok: false;
    readonly reason: string;
    readonly issues: readonly RoleRightsProjectionIssue[];
  };

export type AdoptedDesignerRightsMaterializationResult =
  | {
    readonly ok: true;
    readonly content: Buffer;
    readonly requiresRightsPropertyState: boolean;
    readonly issues: readonly RoleRightsProjectionIssue[];
  }
  | {
    readonly ok: false;
    readonly reason: string;
    readonly issues: readonly RoleRightsProjectionIssue[];
  };

interface RightsPolicy {
  readonly version?: string;
  readonly values: ReadonlyMap<RootPolicyName, boolean>;
  readonly fields: ReadonlyMap<RootPolicyName, readonly XmlElement[]>;
}

interface RightsObjectRecord {
  readonly key: string;
  readonly name: string;
  readonly element: XmlElement;
  readonly rights: RightsRecord[];
}

interface RightsRecord {
  readonly key: string;
  readonly objectName: string;
  readonly rightName: string;
  readonly object: RightsObjectRecord;
  readonly element: XmlElement;
  readonly value?: boolean;
  readonly simple: boolean;
  readonly issue?: string;
}

interface RightsSnapshot {
  readonly document: XmlDocument;
  readonly root: XmlElement;
  readonly policy: RightsPolicy;
  readonly objects: Map<string, RightsObjectRecord[]>;
  readonly rights: Map<string, RightsRecord[]>;
}

/**
 * Builds complete logical views for borrowed Designer Rights.xml files. The physical
 * extension files remain override documents: an omitted right inherits its captured
 * base value, while own-side omissions retain their own file's policy semantics.
 */
export function projectAdoptedDesignerRightsPair(
  input: AdoptedDesignerRightsProjectionInput,
): AdoptedDesignerRightsProjectionResult {
  const issues: RoleRightsProjectionIssue[] = [];
  const invalidInput = validateInput(input);
  if (invalidInput) { return failedProjection(invalidInput); }

  const targetAdopted = input.direction !== 'adopted-to-cf';
  const sourceAdopted = input.direction !== 'cf-to-adopted';
  if (!targetAdopted && !Buffer.isBuffer(input.targetRightsXml)) {
    return failedProjection('Для собственной целевой роли не подтверждён физический Rights.xml.', issues);
  }
  if (!sourceAdopted && !Buffer.isBuffer(input.sourceRightsXml)) {
    return failedProjection('Для собственной исходной роли не подтверждён физический Rights.xml.', issues);
  }

  try {
    const base = readSnapshot(input.baseRightsXml, input.formatVersion, issues);
    const targetPhysical = input.targetRightsXml
      ? readSnapshot(input.targetRightsXml, input.formatVersion, issues)
      : undefined;
    const sourcePhysical = input.sourceRightsXml
      ? readSnapshot(input.sourceRightsXml, input.formatVersion, issues)
      : undefined;

    if (targetPhysical) {
      comparePolicy(base, targetPhysical, issues);
      compareRestrictionTemplates(base, targetPhysical, targetAdopted, issues);
    }
    if (sourcePhysical) {
      comparePolicy(base, sourcePhysical, issues);
      compareRestrictionTemplates(base, sourcePhysical, sourceAdopted, issues);
    }
    if (targetAdopted) { checkUnresolvedAdoptedOmissions(base, targetPhysical, sourcePhysical, input.formatVersion, issues); }
    if (sourceAdopted) { checkUnresolvedAdoptedOmissions(base, sourcePhysical, targetPhysical, input.formatVersion, issues); }

    const targetXml = targetAdopted
      ? projectAdoptedSide(base, targetPhysical, input.baseRightsXml, input.formatVersion, issues)
      : Buffer.from(input.targetRightsXml!);
    const sourceXml = sourceAdopted
      ? projectAdoptedSide(base, sourcePhysical, input.baseRightsXml, input.formatVersion, issues)
      : Buffer.from(input.sourceRightsXml!);

    return { ok: true, targetXml, sourceXml, issues: deduplicateIssues(issues) };
  } catch (error) {
    const reason = errorMessage(error);
    addIssue(issues, { scope: 'file', reason });
    return failedProjection(reason, issues);
  }
}

/**
 * Converts the merged logical target back into the target's physical override shape.
 * Rights equal to the captured base effective value are represented by omission.
 */
export function materializeAdoptedDesignerRightsTarget(
  input: AdoptedDesignerRightsProjectionInput & { readonly mergedLogicalTarget: Buffer },
): AdoptedDesignerRightsMaterializationResult {
  const projected = projectAdoptedDesignerRightsPair(input);
  if (!projected.ok) {
    return { ok: false, reason: projected.reason, issues: projected.issues };
  }

  const issues = [...projected.issues];
  const targetAdopted = input.direction !== 'adopted-to-cf';
  try {
    const base = readSnapshot(input.baseRightsXml, input.formatVersion, issues);
    const merged = readSnapshot(input.mergedLogicalTarget, input.formatVersion, issues);

    if (!targetAdopted) {
      return {
        ok: true,
        content: Buffer.from(input.mergedLogicalTarget),
        requiresRightsPropertyState: false,
        issues: deduplicateIssues(issues),
      };
    }

    let target: RightsSnapshot;
    if (input.targetRightsXml) {
      target = readSnapshot(input.targetRightsXml, input.formatVersion, issues);
    } else {
      const targetDocument = createNewOverrideDocument(base);
      target = readDocumentSnapshot(targetDocument, input.formatVersion, issues);
    }

    const initialLogicalTarget = readSnapshot(projected.targetXml, input.formatVersion, issues);
    comparePolicy(base, merged, issues);
    materializeRights(base, target, initialLogicalTarget, merged, input.formatVersion, issues);

    return {
      ok: true,
      content: Buffer.from(serializeXmlDocument(target.document), 'utf8'),
      requiresRightsPropertyState: true,
      issues: deduplicateIssues(issues),
    };
  } catch (error) {
    const reason = errorMessage(error);
    addIssue(issues, { scope: 'file', reason });
    return { ok: false, reason, issues: deduplicateIssues(issues) };
  }
}

function validateInput(input: AdoptedDesignerRightsProjectionInput): string | undefined {
  if (!input || !isSupportedAdoptedDesignerDirection(input.direction)) {
    return 'Направление adopted Rights.xml projection не поддерживается.';
  }
  if (typeof input.formatVersion !== 'string' || input.formatVersion.trim() === '') {
    return 'Не указана версия формата Rights.xml.';
  }
  if (input.formatVersion !== input.formatVersion.trim() || !SUPPORTED_RIGHTS_VERSIONS.has(input.formatVersion)) {
    return `Версия формата Rights.xml «${input.formatVersion}» не поддерживается.`;
  }
  if (!Buffer.isBuffer(input.baseRightsXml)) {
    return 'Снимок базового Rights.xml должен быть Buffer.';
  }
  if (input.targetRightsXml !== undefined && !Buffer.isBuffer(input.targetRightsXml)) {
    return 'Физический целевой Rights.xml должен быть Buffer.';
  }
  if (input.sourceRightsXml !== undefined && !Buffer.isBuffer(input.sourceRightsXml)) {
    return 'Физический исходный Rights.xml должен быть Buffer.';
  }
  return undefined;
}

function projectAdoptedSide(
  base: RightsSnapshot,
  physical: RightsSnapshot | undefined,
  baseBytes: Buffer,
  formatVersion: string,
  issues: RoleRightsProjectionIssue[],
): Buffer {
  if (!physical) { return Buffer.from(baseBytes); }

  let logical = physical;
  overlayInheritedRootChildren(base, logical, issues);
  overlayInheritedObjectChildren(base, logical, issues);
  logical = readDocumentSnapshot(logical.document, formatVersion, issues);
  overlayInheritedRights(base, logical, formatVersion, issues);
  inheritRootPolicy(base, logical, issues);

  return Buffer.from(serializeXmlDocument(logical.document), 'utf8');
}

function overlayInheritedRootChildren(
  base: RightsSnapshot,
  logical: RightsSnapshot,
  issues: RoleRightsProjectionIssue[],
): void {
  const baseTemplates = direct(base.root, 'restrictionTemplate');
  const handledTemplateIdentities = new Set<string | undefined>();
  for (const child of elementChildren(base.root)) {
    if (isRightsElement(child, 'object') || ROOT_POLICY_NAMES.some((name) => isRightsElement(child, name))) { continue; }
    if (isRightsElement(child, 'restrictionTemplate')) {
      const identity = restrictionTemplateName(child);
      if (handledTemplateIdentities.has(identity)) { continue; }
      handledTemplateIdentities.add(identity);
      const inheritedGroup = baseTemplates.filter((template) => restrictionTemplateName(template) === identity);
      const matchingTemplates = elementChildren(logical.root).filter((candidate) =>
        isRightsElement(candidate, 'restrictionTemplate') && restrictionTemplateName(candidate) === identity,
      );
      if (matchingTemplates.length === 0) {
        for (const template of inheritedGroup) { appendClone(logical.root, template); }
        if (!identity || inheritedGroup.length > 1) {
          addIssue(issues, {
            scope: 'file',
            reason: 'Унаследованный шаблон RLS повреждён или повторяется; содержимое доступно только для чтения.',
          });
        }
      } else if (!identity || inheritedGroup.length > 1 || matchingTemplates.length > 1
        || !inheritedGroup.some((template) => sameXml(matchingTemplates[0]!, template))) {
        addIssue(issues, {
          scope: 'file',
          reason: 'Шаблон RLS в Rights.xml отличается или повторяется; содержимое доступно только для чтения.',
        });
      }
      continue;
    }
    const sameName = elementChildren(logical.root).filter((candidate) =>
      candidate.localName === child.localName && namespaceUriForName(candidate) === namespaceUriForName(child),
    );
    if (sameName.some((candidate) => !sameXml(candidate, child))) {
      addIssue(issues, {
        scope: 'file',
        reason: `Корневой узел Rights.xml «${child.localName}» отличается от унаследованного содержимого и доступен только для чтения.`,
      });
    }
    const baseCopies = elementChildren(base.root).filter((candidate) =>
      candidate.localName === child.localName && namespaceUriForName(candidate) === namespaceUriForName(child)
        && sameXml(candidate, child),
    ).length;
    const logicalCopies = sameName.filter((candidate) => sameXml(candidate, child)).length;
    if (logicalCopies < baseCopies) {
      appendClone(logical.root, child);
    }
  }
}

function overlayInheritedObjectChildren(
  base: RightsSnapshot,
  logical: RightsSnapshot,
  issues: RoleRightsProjectionIssue[],
): void {
  for (const baseObjects of base.objects.values()) {
    if (baseObjects.length !== 1) {
      const existing = logical.objects.get(baseObjects[0]!.key) ?? [];
      if (existing.length === 0) {
        for (const baseObject of baseObjects) { appendClone(logical.root, baseObject.element); }
      }
      continue;
    }
    const baseObject = baseObjects[0]!;
    const targetObjects = logical.objects.get(baseObject.key) ?? [];
    if (targetObjects.length > 1) { continue; }
    const targetObject = targetObjects[0] ?? ensureObject(logical, baseObject.name, issues);
    if (!targetObject) { continue; }
    for (const child of elementChildren(baseObject.element)) {
      if (isRightsElement(child, 'name') || isRightsElement(child, 'right')) { continue; }
      const existing = elementChildren(targetObject.element).filter((candidate) =>
        candidate.localName === child.localName && namespaceUriForName(candidate) === namespaceUriForName(child),
      );
      if (existing.some((candidate) => !sameXml(candidate, child))) {
        addIssue(issues, {
          scope: 'file',
          reason: `Неизвестное содержимое object «${baseObject.name}» отличается и доступно только для чтения.`,
        });
      }
      const baseCopies = elementChildren(baseObject.element).filter((candidate) =>
        candidate.localName === child.localName && namespaceUriForName(candidate) === namespaceUriForName(child)
          && sameXml(candidate, child),
      ).length;
      const logicalCopies = existing.filter((candidate) => sameXml(candidate, child)).length;
      if (logicalCopies < baseCopies) {
        appendClone(targetObject.element, child);
      }
    }
  }
}

function restrictionTemplateName(element: XmlElement): string | undefined {
  const names = direct(element, 'name');
  return names.length === 1 && isSimpleTextElement(names[0]!)
    ? normalize(textContent(names[0]!))
    : undefined;
}

function overlayInheritedRights(
  base: RightsSnapshot,
  logical: RightsSnapshot,
  formatVersion: string,
  issues: RoleRightsProjectionIssue[],
): void {
  for (const [key, baseRecords] of base.rights) {
    if (baseRecords.length !== 1) {
      const logicalRecords = logical.rights.get(key) ?? [];
      if (baseRecords.length > 1 && logicalRecords.length === 0) {
        for (const inherited of baseRecords) {
          const object = ensureObject(logical, inherited.objectName, issues);
          if (object) { appendClone(object.element, inherited.element); }
        }
      }
      continue;
    }
    const inherited = baseRecords[0]!;
    const logicalRecords = logical.rights.get(key) ?? [];
    if (logicalRecords.length > 0) {
      const logicalRight = logicalRecords[0]!;
      if (isNestedObject(inherited.objectName) && nestedPolicyDiffers(base.policy, logical.policy)) {
        pushRightIssue(issues, inherited.objectName, inherited.rightName,
          'Политика вложенных прав отличается; это вложенное право доступно только для чтения.');
      }
      if (logicalRecords.length > 1 || logicalRight.issue) { continue; }
      continue;
    }

    if (!inherited.simple || inherited.value === undefined || inherited.issue) {
      pushRightIssue(issues, inherited.objectName, inherited.rightName,
        inherited.issue ?? 'Унаследованное право содержит условные или неизвестные данные и доступно только для чтения.');
      const object = ensureObject(logical, inherited.objectName, issues);
      if (object) { appendClone(object.element, inherited.element); }
      continue;
    }

    const effective = effectiveValue(inherited, inherited.objectName, base.policy, formatVersion);
    if (effective === undefined) {
      pushRightIssue(issues, inherited.objectName, inherited.rightName,
        'Нельзя подтвердить унаследованное значение права по базовому XML и версии формата.');
      continue;
    }
    if (isNestedObject(inherited.objectName) && nestedPolicyDiffers(base.policy, logical.policy)) {
      pushRightIssue(issues, inherited.objectName, inherited.rightName,
        'Политика вложенных прав отличается; это вложенное право доступно только для чтения.');
    }

    const object = ensureObject(logical, inherited.objectName, issues);
    if (!object) { continue; }
    appendChild(object.element, createSimpleRight(logical.root, inherited.rightName, effective));
  }
}

function checkUnresolvedAdoptedOmissions(
  base: RightsSnapshot,
  adopted: RightsSnapshot | undefined,
  comparisonSide: RightsSnapshot | undefined,
  formatVersion: string,
  issues: RoleRightsProjectionIssue[],
): void {
  if (!comparisonSide) { return; }
  for (const [key, comparisonRecords] of comparisonSide.rights) {
    if (comparisonRecords.length !== 1 || (adopted?.rights.get(key)?.length ?? 0) > 0) { continue; }
    const comparisonRecord = comparisonRecords[0]!;
    if (comparisonRecord.issue) { continue; }
    const baseRecords = base.rights.get(key) ?? [];
    if (baseRecords.length > 1) { continue; }
    const inherited = effectiveValue(baseRecords[0], comparisonRecord.objectName, base.policy, formatVersion);
    if (inherited === undefined) {
      pushRightIssue(issues, comparisonRecord.objectName, comparisonRecord.rightName,
        'Пропуск в заимствованной стороне нельзя разрешить по базовой версии и политике; право доступно только для чтения.');
    }
  }
}

function inheritRootPolicy(
  base: RightsSnapshot,
  logical: RightsSnapshot,
  _issues: RoleRightsProjectionIssue[],
): void {
  for (const policyName of ROOT_POLICY_NAMES) {
    const inheritedValue = base.policy.values.get(policyName);
    if (inheritedValue === undefined) { continue; }
    const fields = logical.policy.fields.get(policyName) ?? [];
    if (fields.length === 1 && isSimpleTextElement(fields[0]!)) {
      setText(fields[0]!, String(inheritedValue));
      continue;
    }
    if (fields.length === 0) {
      appendChild(logical.root, createTextElement(logical.root, policyName, String(inheritedValue), logical.root));
    }
  }
}

function readSnapshot(source: Buffer, formatVersion: string, issues: RoleRightsProjectionIssue[]): RightsSnapshot {
  return readDocumentSnapshot(parseXmlDocument(source.toString('utf8')), formatVersion, issues);
}

function readDocumentSnapshot(
  document: XmlDocument,
  formatVersion: string,
  issues: RoleRightsProjectionIssue[],
): RightsSnapshot {
  if (document.root.localName !== 'Rights' || namespaceUriForName(document.root) !== ROLE_RIGHTS_NAMESPACE) {
    throw new Error('Корневой элемент Rights.xml использует неподдерживаемое пространство имён.');
  }
  const root = document.root;
  const versionAttribute = root.attributes.filter((attribute) => attribute.name === 'version');
  const version = versionAttribute.length === 1 ? versionAttribute[0]!.value.trim() : undefined;
  if (version && !SUPPORTED_RIGHTS_VERSIONS.has(version)) {
    throw new Error(`Версия Rights.xml «${version}» не поддерживается.`);
  }
  if (!version || version !== formatVersion) {
    addIssue(issues, {
      scope: 'file',
      reason: !version
        ? 'В корне Rights.xml отсутствует однозначная версия формата.'
        : `Версия Rights.xml «${version}» не совпадает с подтверждённой «${formatVersion}».`,
    });
  }

  const policyValues = new Map<RootPolicyName, boolean>();
  const policyFields = new Map<RootPolicyName, readonly XmlElement[]>();
  for (const policyName of ROOT_POLICY_NAMES) {
    const fields = direct(root, policyName);
    policyFields.set(policyName, fields);
    if (fields.length !== 1 || !isSimpleTextElement(fields[0]!)) {
      addIssue(issues, {
        scope: 'policy',
        policyName,
        reason: fields.length > 1
          ? `Флаг ${policyName} повторяется и доступен только для чтения.`
          : `Флаг ${policyName} отсутствует или имеет неизвестную структуру.`,
      });
      continue;
    }
    const value = readBoolean(textContent(fields[0]!).trim());
    if (value === undefined) {
      addIssue(issues, {
        scope: 'policy',
        policyName,
        reason: `Флаг ${policyName} должен иметь значение true или false.`,
      });
      continue;
    }
    policyValues.set(policyName, value);
  }

  const objects = new Map<string, RightsObjectRecord[]>();
  const rights = new Map<string, RightsRecord[]>();
  for (const objectElement of direct(root, 'object')) {
    const names = direct(objectElement, 'name');
    if (names.length !== 1 || !isSimpleTextElement(names[0]!)) {
      addIssue(issues, { scope: 'file', reason: 'Элемент object Rights.xml не содержит однозначное простое имя.' });
      continue;
    }
    const objectName = textContent(names[0]!).trim();
    if (!objectName) {
      addIssue(issues, { scope: 'file', reason: 'Элемент object Rights.xml содержит пустое имя.' });
      continue;
    }

    const objectKey = normalize(objectName);
    const object: RightsObjectRecord = {
      key: objectKey,
      name: objectName,
      element: objectElement,
      rights: [],
    };
    const matchingObjects = objects.get(objectKey) ?? [];
    matchingObjects.push(object);
    objects.set(objectKey, matchingObjects);

    for (const rightElement of direct(objectElement, 'right')) {
      const rightNames = direct(rightElement, 'name');
      const valueElements = direct(rightElement, 'value');
      if (rightNames.length !== 1 || !isSimpleTextElement(rightNames[0]!)) {
        addIssue(issues, { scope: 'file', reason: `Право объекта ${objectName} не содержит однозначное имя.` });
        continue;
      }
      const rightName = textContent(rightNames[0]!).trim();
      if (!rightName) {
        addIssue(issues, { scope: 'file', reason: `Право объекта ${objectName} содержит пустое имя.` });
        continue;
      }

      const rawValue = valueElements.length === 1 && isSimpleTextElement(valueElements[0]!)
        ? readBoolean(textContent(valueElements[0]!).trim())
        : undefined;
      const simple = valueElements.length === 1
        && isSimpleRight(rightElement, rightNames[0]!, valueElements[0]!);
      let issue: string | undefined;
      if (valueElements.length !== 1 || rawValue === undefined) {
        issue = 'Значение права должно быть однозначным true или false.';
      } else if (!simple) {
        issue = 'Право содержит RLS, условные или неизвестные данные и доступно только для чтения.';
      }

      const key = rightsKey(objectName, rightName);
      const record: RightsRecord = {
        key,
        objectName,
        rightName,
        object,
        element: rightElement,
        ...(rawValue !== undefined ? { value: rawValue } : {}),
        simple,
        ...(issue ? { issue } : {}),
      };
      object.rights.push(record);
      const matchingRights = rights.get(key) ?? [];
      matchingRights.push(record);
      rights.set(key, matchingRights);
    }
  }

  for (const [key, matchingObjects] of objects) {
    if (matchingObjects.length < 2) { continue; }
    const affectedRights = new Set(matchingObjects.flatMap((object) => object.rights.map((right) => right.key)));
    if (affectedRights.size === 0) {
      addIssue(issues, { scope: 'file', reason: `Имя объекта прав «${matchingObjects[0]!.name}» повторяется.` });
      continue;
    }
    for (const rightKey of affectedRights) {
      const record = (rights.get(rightKey) ?? [])[0];
      if (record) {
        pushRightIssue(issues, record.objectName, record.rightName, 'Имя объекта прав повторяется; соответствие права неоднозначно.');
      }
    }
    void key;
  }

  for (const matchingRights of rights.values()) {
    if (matchingRights.length > 1) {
      const record = matchingRights[0]!;
      pushRightIssue(issues, record.objectName, record.rightName, 'Одно и то же право объекта повторяется; соответствие неоднозначно.');
      continue;
    }
    const record = matchingRights[0]!;
    if (record.issue) { pushRightIssue(issues, record.objectName, record.rightName, record.issue); }
  }

  return {
    document,
    root,
    policy: {
      ...(version ? { version } : {}),
      values: policyValues,
      fields: policyFields,
    },
    objects,
    rights,
  };
}

function comparePolicy(
  base: RightsSnapshot,
  side: RightsSnapshot,
  issues: RoleRightsProjectionIssue[],
): void {
  for (const policyName of ROOT_POLICY_NAMES) {
    const baseValue = base.policy.values.get(policyName);
    const sideValue = side.policy.values.get(policyName);
    if (baseValue !== undefined && sideValue !== undefined && baseValue !== sideValue) {
      addIssue(issues, {
        scope: 'policy',
        policyName,
        reason: `Флаг ${policyName} отличается от унаследованной политики и доступен только для чтения.`,
      });
    }
  }
}

function compareRestrictionTemplates(
  base: RightsSnapshot,
  side: RightsSnapshot,
  adoptedSide: boolean,
  issues: RoleRightsProjectionIssue[],
): void {
  const baseTemplates = direct(base.root, 'restrictionTemplate');
  const sideTemplates = direct(side.root, 'restrictionTemplate');
  if (adoptedSide) {
    for (const template of sideTemplates) {
      const identity = restrictionTemplateName(template);
      const matching = baseTemplates.filter((candidate) => restrictionTemplateName(candidate) === identity);
      if (!identity || matching.length !== 1 || !sameXml(matching[0]!, template)) {
        addIssue(issues, {
          scope: 'file',
          reason: 'Дополнительный или изменённый шаблон RLS в Rights.xml доступен только для чтения.',
        });
      }
    }
    return;
  }

  const identities = new Set([
    ...baseTemplates.map(restrictionTemplateName),
    ...sideTemplates.map(restrictionTemplateName),
  ]);
  for (const identity of identities) {
    const baseMatches = baseTemplates.filter((template) => restrictionTemplateName(template) === identity);
    const sideMatches = sideTemplates.filter((template) => restrictionTemplateName(template) === identity);
    if (!identity || baseMatches.length !== 1 || sideMatches.length !== 1 || !sameXml(baseMatches[0]!, sideMatches[0]!)) {
      addIssue(issues, {
        scope: 'file',
        reason: 'Изменён или неоднозначен шаблон RLS в собственной роли; содержимое доступно только для чтения.',
      });
    }
  }
}

function materializeRights(
  base: RightsSnapshot,
  target: RightsSnapshot,
  initialLogicalTarget: RightsSnapshot,
  merged: RightsSnapshot,
  formatVersion: string,
  issues: RoleRightsProjectionIssue[],
): void {
  const keys = new Set([
    ...base.rights.keys(),
    ...target.rights.keys(),
    ...initialLogicalTarget.rights.keys(),
    ...merged.rights.keys(),
  ]);
  for (const key of keys) {
    const baseRecords = base.rights.get(key) ?? [];
    const targetRecords = target.rights.get(key) ?? [];
    const initialRecords = initialLogicalTarget.rights.get(key) ?? [];
    const mergedRecords = merged.rights.get(key) ?? [];
    if (baseRecords.length > 1 || targetRecords.length > 1 || initialRecords.length > 1 || mergedRecords.length > 1) { continue; }

    const baseRecord = baseRecords[0];
    const targetRecord = targetRecords[0];
    const initialRecord = initialRecords[0];
    const mergedRecord = mergedRecords[0];
    const objectName = baseRecord?.objectName ?? targetRecord?.objectName ?? initialRecord?.objectName ?? mergedRecord?.objectName;
    const rightName = baseRecord?.rightName ?? targetRecord?.rightName ?? initialRecord?.rightName ?? mergedRecord?.rightName;
    if (!objectName || !rightName) { continue; }

    if (hasDuplicateObject(base, objectName) || hasDuplicateObject(target, objectName) || hasDuplicateObject(merged, objectName)) {
      pushRightIssue(issues, objectName, rightName, 'Имя объекта прав повторяется; соответствие права неоднозначно.');
      continue;
    }

    const malformed = baseRecord?.issue ?? targetRecord?.issue ?? initialRecord?.issue ?? mergedRecord?.issue;
    if (malformed) { continue; }

    const baseEffective = effectiveValue(baseRecord, objectName, base.policy, formatVersion);
    const initialEffective = effectiveValue(initialRecord, objectName, base.policy, formatVersion);
    const desired = mergedRecord
      ? effectiveValue(mergedRecord, objectName, base.policy, formatVersion)
      : omittedDefault(objectName, base.policy, formatVersion);

    if (desired !== undefined && desired === initialEffective) { continue; }
    if (desired === undefined || initialEffective === undefined) {
      pushRightIssue(issues, objectName, rightName,
        'Нельзя подтвердить изменение права относительно исходного логического target; право доступно только для чтения.');
      continue;
    }

    if (!baseRecord && targetRecord) {
      if (!mergedRecord) {
        removeChild(targetRecord.object.element, targetRecord.element);
      } else if (desired !== undefined && desired !== targetRecord.value) {
        if (baseEffective !== undefined && desired === baseEffective) {
          removeChild(targetRecord.object.element, targetRecord.element);
        } else {
          replaceWithSimpleRight(target, targetRecord, rightName, desired);
        }
      }
      continue;
    }

    if (baseEffective === undefined || desired === undefined) {
      pushRightIssue(issues, objectName, rightName,
        'Нельзя определить эффективное значение права без предположения о значении пропуска.');
      continue;
    }

    if (desired === baseEffective) {
      if (targetRecord) { removeChild(targetRecord.object.element, targetRecord.element); }
      continue;
    }

    if (targetRecord) {
      replaceWithSimpleRight(target, targetRecord, rightName, desired);
      continue;
    }
    const object = ensureObject(target, objectName, issues);
    if (object) { appendChild(object.element, createSimpleRight(target.root, rightName, desired)); }
  }
}

function createNewOverrideDocument(base: RightsSnapshot): XmlDocument {
  const document = cloneDocument(base.document);
  document.prolog = []; document.epilog = []; document.root.attributes = document.root.attributes.filter((attribute) => attribute.name === 'version' || attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:'));
  document.root.children = document.root.children.filter((child) =>
    child.kind === 'element' && ROOT_POLICY_NAMES.some((name) => isRightsElement(child, name)),
  );
  for (const child of document.root.children) {
    if (child.kind === 'element') { child.parent = document.root; }
  }
  return document;
}

function effectiveValue(
  record: RightsRecord | undefined,
  objectName: string,
  policy: RightsPolicy,
  formatVersion: string,
): boolean | undefined {
  if (record) {
    return record.simple && record.value !== undefined && !record.issue ? record.value : undefined;
  }
  return omittedDefault(objectName, policy, formatVersion);
}

function omittedDefault(
  objectName: string,
  policy: RightsPolicy,
  formatVersion: string,
): boolean | undefined {
  if (!OMITTED_DEFAULT_VERSIONS.has(formatVersion) || objectName.split('.').length !== 2) { return undefined; }
  return policy.values.get('setForNewObjects');
}

function ensureObject(
  snapshot: RightsSnapshot,
  objectName: string,
  issues: RoleRightsProjectionIssue[],
): RightsObjectRecord | undefined {
  const key = normalize(objectName);
  const matching = snapshot.objects.get(key) ?? [];
  if (matching.length > 1) {
    addIssue(issues, { scope: 'file', reason: `Нельзя однозначно дополнить повторяющийся object «${objectName}».` });
    return undefined;
  }
  if (matching.length === 1) { return matching[0]; }

  const element = createElementLike(snapshot.root, 'object');
  const record: RightsObjectRecord = { key, name: objectName, element, rights: [] };
  appendChild(snapshot.root, element);
  appendChild(element, createTextElement(snapshot.root, 'name', objectName, element));
  snapshot.objects.set(key, [record]);
  return record;
}

function hasDuplicateObject(snapshot: RightsSnapshot, objectName: string): boolean {
  return (snapshot.objects.get(normalize(objectName))?.length ?? 0) > 1;
}

function replaceWithSimpleRight(
  snapshot: RightsSnapshot,
  existing: RightsRecord,
  rightName: string,
  value: boolean,
): void {
  const replacement = createSimpleRight(snapshot.root, rightName, value);
  replaceChild(existing.object.element, existing.element, replacement);
  const updated: RightsRecord = {
    key: existing.key,
    objectName: existing.objectName,
    rightName,
    object: existing.object,
    element: replacement,
    value,
    simple: true,
  };
  const records = snapshot.rights.get(existing.key) ?? [];
  const index = records.indexOf(existing);
  if (index >= 0) { records[index] = updated; }
  else { records.push(updated); }
  const objectIndex = existing.object.rights.indexOf(existing);
  if (objectIndex >= 0) { existing.object.rights[objectIndex] = updated; }
}

function createSimpleRight(root: XmlElement, rightName: string, value: boolean): XmlElement {
  const right = createElementLike(root, 'right');
  appendChild(right, createTextElement(root, 'name', rightName, right));
  appendChild(right, createTextElement(root, 'value', String(value), right));
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
  };
}

function appendClone(parent: XmlElement, source: XmlElement): void {
  const clone = cloneWithNamespaces(source);
  clone.attributes = clone.attributes.filter((attribute) => {
    if (attribute.name !== 'xmlns' && !attribute.name.startsWith('xmlns:')) { return true; }
    if (source.attributes.some((sourceAttribute) => sourceAttribute.name === attribute.name)) { return true; }
    const prefix = attribute.name === 'xmlns' ? '' : attribute.name.slice('xmlns:'.length);
    const inheritedNamespace = namespaceUriForName(parent, prefix ? `${prefix}:namespaceProbe` : 'namespaceProbe');
    return inheritedNamespace !== attribute.value;
  });
  appendChild(parent, clone);
}

function appendChild(parent: XmlElement, child: XmlElement): void {
  child.parent = parent;
  parent.children.push(child);
}

function replaceChild(parent: XmlElement, existing: XmlElement, replacement: XmlElement): void {
  const index = parent.children.indexOf(existing);
  if (index < 0) { return; }
  replacement.parent = parent;
  parent.children[index] = replacement;
}

function removeChild(parent: XmlElement, child: XmlElement): void {
  const index = parent.children.indexOf(child);
  if (index >= 0) { parent.children.splice(index, 1); }
}

function setText(element: XmlElement, value: string): void {
  const firstText = element.children.find((child) => child.kind === 'text' || child.kind === 'cdata');
  if (firstText && (firstText.kind === 'text' || firstText.kind === 'cdata')) {
    firstText.text = value;
    element.children = element.children.filter((child) => child === firstText || child.kind === 'comment' || child.kind === 'processingInstruction');
    return;
  }
  element.children = [{ kind: 'text', text: value }];
}

function cloneDocument(document: XmlDocument): XmlDocument {
  const root = cloneXmlElement(document.root);
  return {
    ...document,
    root,
  };
}

function direct(parent: XmlElement, localName: string): XmlElement[] {
  return elementChildren(parent).filter((element) => isRightsElement(element, localName));
}

function isRightsElement(element: XmlElement, localName: string): boolean {
  return element.localName === localName && namespaceUriForName(element) === ROLE_RIGHTS_NAMESPACE;
}

function isSimpleRight(right: XmlElement, name: XmlElement, value: XmlElement): boolean {
  const children = elementChildren(right);
  return onlyNamespaceAttributes(right)
    && onlyWhitespaceText(right.children)
    && children.length === 2
    && children[0] === name
    && children[1] === value
    && direct(right, 'name').length === 1
    && direct(right, 'value').length === 1
    && isSimpleTextElement(name)
    && isSimpleTextElement(value);
}

function isSimpleTextElement(element: XmlElement): boolean {
  return onlyNamespaceAttributes(element)
    && element.children.every((child) => child.kind === 'text' || child.kind === 'cdata');
}

function onlyNamespaceAttributes(element: XmlElement): boolean {
  return element.attributes.every((attribute) => attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:'));
}

function onlyWhitespaceText(children: readonly XmlChildNode[]): boolean {
  return children.every((child) => child.kind === 'element' || (child.kind === 'text' && child.text.trim() === ''));
}

function sameXml(left: XmlElement, right: XmlElement): boolean {
  return captureXmlSubtree(left) === captureXmlSubtree(right);
}

function nestedPolicyDiffers(left: RightsPolicy, right: RightsPolicy): boolean {
  return left.values.get('setForAttributesByDefault') !== right.values.get('setForAttributesByDefault')
    || left.values.get('independentRightsOfChildObjects') !== right.values.get('independentRightsOfChildObjects');
}

function isNestedObject(objectName: string): boolean {
  return objectName.split('.').length > 2;
}

function readBoolean(value: string): boolean | undefined {
  if (value === 'true') { return true; }
  if (value === 'false') { return false; }
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

function pushRightIssue(
  issues: RoleRightsProjectionIssue[],
  objectQualifiedName: string,
  rightName: string,
  reason: string,
): void {
  addIssue(issues, { scope: 'right', objectQualifiedName, rightName, reason });
}

function addIssue(issues: RoleRightsProjectionIssue[], issue: RoleRightsProjectionIssue): void {
  issues.push(issue);
}

function deduplicateIssues(issues: readonly RoleRightsProjectionIssue[]): RoleRightsProjectionIssue[] {
  const result = new Map<string, RoleRightsProjectionIssue>();
  for (const issue of issues) {
    const key = [issue.scope, issue.objectQualifiedName, issue.rightName, issue.policyName, issue.reason].join('\u0000');
    result.set(key, issue);
  }
  return [...result.values()];
}

function failedProjection(reason: string, issues: readonly RoleRightsProjectionIssue[] = []): AdoptedDesignerRightsProjectionResult {
  return {
    ok: false,
    reason,
    issues: deduplicateIssues([...issues, { scope: 'file', reason }]),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
