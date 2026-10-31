import * as path from 'path';

import type { MergeFileWitness } from '../merge/mergePreview';
import { MISSING_TARGET_HASH } from '../merge/mergePreview';
import { captureMergePath } from '../merge/mergeSnapshot';
import { requiredLinkedDesignerBodyPath } from '../linkedDesignerPackageRules';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';
import type { ExtensionAdoptedRowProof } from './extensionAdoptedSemanticContext';
import type { ExtensionAdoptedUuidSnapshot } from './adoptedDesignerUuidContext';
import { proveRegisteredOwnFormDescriptorUuid } from './adoptedDesignerUuidContext';
import type { ExtensionLinkedDesignerPackage } from './extensionLinkedDesignerPackages';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;

export interface CapturedAdoptedOwnFormIdentity {
  readonly ownership: 'own';
  readonly type: 'Form';
  readonly name: string;
  readonly uuid: string;
}

/** Host-created recipe required to admit an ordinary Form adapter selection in an adopted row. */
export interface CapturedAdoptedOwnFormSelection {
  readonly rowId: string;
  readonly targetRelativePath: string;
  readonly sourceRelativePath: string;
  readonly targetHash: string;
  readonly sourceHash: string;
  readonly targetIdentity: CapturedAdoptedOwnFormIdentity;
  readonly sourceIdentity: CapturedAdoptedOwnFormIdentity;
  readonly requiredWitnesses: readonly MergeFileWitness[];
}

export interface ExtensionAdoptedOwnFormBlocker {
  readonly name: string;
  readonly relativePath: string;
  readonly reason: string;
}

export interface ExtensionAdoptedOwnFormPackageProof {
  readonly packageId: string;
  readonly descriptorSourceRelativePath: string;
  readonly dependencyWitnesses: readonly MergeFileWitness[];
  readonly descriptorUuidWitnesses: readonly MergeFileWitness[];
}

export interface CapturedAdoptedOwnFormMatch {
  readonly recipe: CapturedAdoptedOwnFormSelection;
  readonly targetXml: Buffer;
  readonly sourceXml: Buffer;
}

export interface ExtensionAdoptedOwnFormPreparation {
  readonly ownFormRegistrations: { readonly target: readonly string[]; readonly source: readonly string[] };
  readonly packageProofs: readonly ExtensionAdoptedOwnFormPackageProof[];
  readonly matchedForms: readonly CapturedAdoptedOwnFormMatch[];
  readonly descriptorWitnesses: readonly MergeFileWitness[];
  readonly blockers: readonly ExtensionAdoptedOwnFormBlocker[];
}

interface CapturedOwnForm {
  readonly name: string;
  readonly descriptorRelativePath: string;
  readonly bodyRelativePath: string;
  readonly descriptor: Buffer;
  readonly body: Buffer;
  readonly identity: CapturedAdoptedOwnFormIdentity;
  readonly descriptorWitness: MergeFileWitness;
  readonly bodyWitness: MergeFileWitness;
  readonly ownerWitness: MergeFileWitness;
}

interface FormRegistrationSet {
  readonly names: readonly string[];
  readonly error?: string;
}

export async function prepareExtensionAdoptedOwnForms(input: {
  readonly row: ExtensionTransferRow;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly proof: Extract<ExtensionAdoptedRowProof, { readonly ok: true }>;
  readonly uuidSnapshot: ExtensionAdoptedUuidSnapshot;
  readonly linkedPackages: readonly ExtensionLinkedDesignerPackage[];
  readonly configurationWitnesses: readonly MergeFileWitness[];
}): Promise<ExtensionAdoptedOwnFormPreparation> {
  const targetOwner = input.row.target!;
  const sourceOwner = input.row.incoming!;
  const targetRegistrations = readFormRegistrations(targetOwner);
  const sourceRegistrations = readFormRegistrations(sourceOwner);
  const baseRegistrations = readFormRegistrations(input.proof.baseObject);
  const otherBaseRegistrations = input.proof.otherBaseObject ? readFormRegistrations(input.proof.otherBaseObject) : undefined;
  const blockers: ExtensionAdoptedOwnFormBlocker[] = [];
  if (targetRegistrations.error) { blockers.push(blocker('', targetOwner.descriptorRelativePath ?? '', targetRegistrations.error)); }
  if (sourceRegistrations.error) { blockers.push(blocker('', sourceOwner.descriptorRelativePath ?? '', sourceRegistrations.error)); }
  if (baseRegistrations.error) { blockers.push(blocker('', input.proof.baseObject.descriptorRelativePath ?? '', baseRegistrations.error)); }
  if (otherBaseRegistrations?.error) { blockers.push(blocker('', input.proof.otherBaseObject!.descriptorRelativePath ?? '', otherBaseRegistrations.error)); }
  if (targetRegistrations.error || sourceRegistrations.error || baseRegistrations.error || otherBaseRegistrations?.error) {
    return emptyPreparation(blockers);
  }

  const targetNames = new Map(targetRegistrations.names.map((name) => [normalizeName(name), name]));
  const sourceNames = new Map(sourceRegistrations.names.map((name) => [normalizeName(name), name]));
  const baseNames = new Set(baseRegistrations.names.map(normalizeName));
  const otherBaseNames = otherBaseRegistrations ? new Set(otherBaseRegistrations.names.map(normalizeName)) : undefined;
  const targetAllowlist: string[] = [];
  const sourceAllowlist: string[] = [];
  const packageProofs: ExtensionAdoptedOwnFormPackageProof[] = [];
  const matchedForms: CapturedAdoptedOwnFormMatch[] = [];
  const descriptorWitnesses: MergeFileWitness[] = [];
  const allNames = new Set([...targetNames.keys(), ...sourceNames.keys()]);

  for (const key of allNames) {
    const targetName = targetNames.get(key);
    const sourceName = sourceNames.get(key);
    if (baseNames.has(key) || otherBaseNames?.has(key)) {
      if (targetName && isAdoptedCfeOwner(input.targetRoot, targetOwner)) {
        const target = await captureOwnForm(input.targetRoot, targetOwner, targetName);
        if (target.ok && target.value.identity.ownership === 'own') {
          blockers.push(blocker(targetName, target.value.descriptorRelativePath,
            'Имя Form зарегистрировано в proven base; физическая own Form не может подменить унаследованную регистрацию.'));
        }
      }
      if (sourceName && isAdoptedCfeOwner(input.incomingRoot, sourceOwner)) {
        const source = await captureOwnForm(input.incomingRoot, sourceOwner, sourceName);
        if (source.ok && source.value.identity.ownership === 'own') {
          blockers.push(blocker(sourceName, source.value.descriptorRelativePath,
            'Имя Form зарегистрировано в proven base; физическая own Form не может подменить унаследованную регистрацию.'));
        }
      }
      continue;
    }

    const baseAbsence = await captureBaseAbsence(input.proof, key, [targetName, sourceName].filter((name): name is string => Boolean(name)));
    if (!baseAbsence.ok) {
      blockers.push(blocker(targetName ?? sourceName ?? '', baseAbsence.relativePath, baseAbsence.reason));
      continue;
    }
    descriptorWitnesses.push(...baseAbsence.witnesses);

    const targetCapture = targetName ? await captureOwnForm(input.targetRoot, targetOwner, targetName) : undefined;
    const sourceCapture = sourceName ? await captureOwnForm(input.incomingRoot, sourceOwner, sourceName) : undefined;
    if (targetCapture && !targetCapture.ok) {
      blockers.push(blocker(targetName!, targetCapture.relativePath, targetCapture.reason));
      continue;
    }
    if (sourceCapture && !sourceCapture.ok) {
      blockers.push(blocker(sourceName!, sourceCapture.relativePath, sourceCapture.reason));
      if (targetCapture?.ok) { targetAllowlist.push(targetCapture.value.name); }
      continue;
    }
    const targetForm = targetCapture?.ok ? targetCapture.value : undefined;
    const sourceForm = sourceCapture?.ok ? sourceCapture.value : undefined;
    if (targetForm && sourceForm) {
      if (!sameOwnFormIdentity(targetForm.identity, sourceForm.identity)) {
        blockers.push(blocker(sourceForm.name, sourceForm.descriptorRelativePath,
          'Target/source own Form имеют разные exact type, name или UUID; форма остаётся scoped read-only.'));
        continue;
      }
      targetAllowlist.push(targetForm.name);
      sourceAllowlist.push(sourceForm.name);
      const witnesses = dedupeWitnesses([
        ...input.configurationWitnesses,
        targetForm.ownerWitness,
        sourceForm.ownerWitness,
        targetForm.descriptorWitness,
        sourceForm.descriptorWitness,
        targetForm.bodyWitness,
        sourceForm.bodyWitness,
        ...baseAbsence.witnesses,
      ]);
      matchedForms.push({
        recipe: {
          rowId: input.row.id,
          targetRelativePath: targetForm.bodyRelativePath,
          sourceRelativePath: sourceForm.bodyRelativePath,
          targetHash: targetForm.bodyWitness.expectedHash,
          sourceHash: sourceForm.bodyWitness.expectedHash,
          targetIdentity: targetForm.identity,
          sourceIdentity: sourceForm.identity,
          requiredWitnesses: witnesses,
        },
        targetXml: Buffer.from(targetForm.body),
        sourceXml: Buffer.from(sourceForm.body),
      });
      descriptorWitnesses.push(targetForm.ownerWitness, sourceForm.ownerWitness, targetForm.descriptorWitness, sourceForm.descriptorWitness);
      continue;
    }
    if (targetForm) {
      targetAllowlist.push(targetForm.name);
      descriptorWitnesses.push(targetForm.ownerWitness, targetForm.descriptorWitness);
      continue;
    }
    if (!sourceForm) { continue; }

    const packageMatches = input.linkedPackages.filter((candidate) => candidate.action === 'copy'
      && candidate.kind === 'Form' && normalizeName(candidate.name) === key);
    if (packageMatches.length !== 1) {
      blockers.push(blocker(sourceForm.name, sourceForm.descriptorRelativePath,
        packageMatches.length === 0
          ? 'Новая own Form не имеет полного связанного registration/descriptor/body package; перенос доступен только для чтения.'
          : 'Новый own Form связан с неоднозначными Designer packages; перенос доступен только для чтения.'));
      continue;
    }
    const packageRecipe = packageMatches[0]!;
    const packageCapture = validateCapturedPackage(packageRecipe, sourceForm);
    if (!packageCapture.ok) {
      blockers.push(blocker(sourceForm.name, packageCapture.relativePath, packageCapture.reason));
      continue;
    }
    const uuidProof = proveRegisteredOwnFormDescriptorUuid(input.uuidSnapshot, {
      sourceId: input.incomingRoot.sourceId,
      relativePath: sourceForm.descriptorRelativePath,
      name: sourceForm.name,
      uuid: sourceForm.identity.uuid,
      descriptorContent: sourceForm.descriptor,
      formatVersion: input.incomingRoot.formatVersion ?? '',
    });
    if (!uuidProof.ok) {
      blockers.push(blocker(sourceForm.name, sourceForm.descriptorRelativePath, uuidProof.reason));
      continue;
    }
    sourceAllowlist.push(sourceForm.name);
    packageProofs.push({
      packageId: packageRecipe.packageId,
      descriptorSourceRelativePath: sourceForm.descriptorRelativePath,
      dependencyWitnesses: dedupeWitnesses([
        ...input.configurationWitnesses,
        witnessFor(input.targetRoot, targetOwner),
        witnessFor(input.incomingRoot, sourceOwner),
        ...baseAbsence.witnesses,
      ]),
      descriptorUuidWitnesses: uuidProof.witnesses,
    });
    descriptorWitnesses.push(sourceForm.ownerWitness, sourceForm.descriptorWitness, sourceForm.bodyWitness);
  }

  return {
    ownFormRegistrations: { target: uniqueNames(targetAllowlist), source: uniqueNames(sourceAllowlist) },
    packageProofs,
    matchedForms,
    descriptorWitnesses: dedupeWitnesses(descriptorWitnesses),
    blockers,
  };
}

/** Allows only the exact host-captured matched own Form body recipe for adopted rows. */
export function matchesCapturedAdoptedOwnFormSelection(
  row: ExtensionTransferRow,
  selection: {
    readonly nodeId: string;
    readonly rowId: string;
    readonly kind: string;
    readonly targetRelativePath: string;
    readonly sourceRelativePath: string;
    readonly targetHash: string;
    readonly sourceHash: string;
    readonly dependencyWitnesses?: readonly MergeFileWitness[];
    readonly adoptedOwnForm?: CapturedAdoptedOwnFormSelection;
  },
): boolean {
  const recipe = selection.adoptedOwnForm;
  if (!recipe || selection.kind !== 'formXml' || selection.rowId !== row.id || recipe.rowId !== row.id
    || !row.target || !row.incoming || recipe.targetIdentity.ownership !== 'own' || recipe.sourceIdentity.ownership !== 'own'
    || recipe.targetIdentity.type !== 'Form' || recipe.sourceIdentity.type !== 'Form'
    || !sameOwnFormIdentity(recipe.targetIdentity, recipe.sourceIdentity)
    || !samePath(recipe.targetRelativePath, selection.targetRelativePath)
    || !samePath(recipe.sourceRelativePath, selection.sourceRelativePath)
    || recipe.targetHash !== selection.targetHash || recipe.sourceHash !== selection.sourceHash
    || !recipe.requiredWitnesses.length) { return false; }
  const supplied = new Map((selection.dependencyWitnesses ?? []).map((item) => [witnessKey(item), normalizeHash(item.expectedHash)]));
  return recipe.requiredWitnesses.every((witness) => supplied.get(witnessKey(witness)) === normalizeHash(witness.expectedHash));
}

async function captureOwnForm(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  name: string,
): Promise<{ readonly ok: true; readonly value: CapturedOwnForm } | { readonly ok: false; readonly relativePath: string; readonly reason: string }> {
  const relativePath = nestedFormDescriptorPath(owner, name);
  if (!owner.descriptorRelativePath || !owner.descriptorHash || !owner.descriptorContent || !owner.sidecarRelativePath) {
    return { ok: false, relativePath: owner.descriptorRelativePath ?? relativePath, reason: `Для ${owner.qualifiedName} отсутствует owner descriptor или sidecar.` };
  }
  const ownerCapture = await captureIndexedFile(root, owner.descriptorRelativePath, owner.descriptorHash);
  if (!ownerCapture.ok) { return { ok: false, relativePath: owner.descriptorRelativePath, reason: ownerCapture.reason }; }
  const ownerForms = readFormRegistrationsFromBytes(ownerCapture.content, owner);
  if (ownerForms.error || ownerForms.names.filter((candidate) => normalizeName(candidate) === normalizeName(name)).length !== 1) {
    return { ok: false, relativePath: owner.descriptorRelativePath, reason: ownerForms.error ?? `Form ${name} не имеет единственной exact регистрации у owner.` };
  }
  const descriptorFiles = owner.sidecarFiles.filter((file) => samePath(file.relativePath, relativePath));
  if (descriptorFiles.length !== 1) {
    return { ok: false, relativePath, reason: `Registered Form ${name} не имеет единственного nested descriptor.` };
  }
  const descriptorCapture = await captureIndexedFile(root, relativePath, descriptorFiles[0]!.hash);
  if (!descriptorCapture.ok) { return { ok: false, relativePath, reason: descriptorCapture.reason }; }
  const identity = parseOwnFormDescriptor(descriptorCapture.content, name, root.formatVersion ?? '');
  if (!identity) { return { ok: false, relativePath, reason: `Nested descriptor ${relativePath} не является exact own Form identity/version.` }; }
  const bodyRelativePath = requiredLinkedDesignerBodyPath('Form', relativePath, descriptorCapture.content);
  if (!bodyRelativePath) { return { ok: false, relativePath, reason: `Невозможно вывести Form.xml для ${relativePath}.` }; }
  const bodyFiles = owner.sidecarFiles.filter((file) => samePath(file.relativePath, bodyRelativePath));
  if (bodyFiles.length !== 1) { return { ok: false, relativePath: bodyRelativePath, reason: `Form ${name} не имеет единственного физического Form.xml.` }; }
  const bodyCapture = await captureIndexedFile(root, bodyRelativePath, bodyFiles[0]!.hash);
  if (!bodyCapture.ok) { return { ok: false, relativePath: bodyRelativePath, reason: bodyCapture.reason }; }
  if (!validStandaloneFormBody(bodyCapture.content, root.formatVersion ?? '')) {
    return { ok: false, relativePath: bodyRelativePath, reason: `Form.xml ${bodyRelativePath} имеет неверную namespace/version или содержит BaseForm.` };
  }
  return {
    ok: true,
    value: {
      name,
      descriptorRelativePath: relativePath,
      bodyRelativePath,
      descriptor: descriptorCapture.content,
      body: bodyCapture.content,
      identity,
      descriptorWitness: descriptorCapture.witness,
      bodyWitness: bodyCapture.witness,
      ownerWitness: ownerCapture.witness,
    },
  };
}

async function captureBaseAbsence(
  proof: Extract<ExtensionAdoptedRowProof, { readonly ok: true }>,
  normalizedName: string,
  displayNames: readonly string[],
): Promise<{ readonly ok: true; readonly witnesses: readonly MergeFileWitness[] } | { readonly ok: false; readonly relativePath: string; readonly reason: string }> {
  const bases = [
    { root: proof.baseRoot, owner: proof.baseObject },
    ...(proof.otherBaseRoot && proof.otherBaseObject ? [{ root: proof.otherBaseRoot, owner: proof.otherBaseObject }] : []),
  ];
  const witnesses: MergeFileWitness[] = [];
  for (const { root, owner } of bases) {
    if (!owner.descriptorRelativePath || !owner.descriptorHash || !owner.descriptorContent || !owner.sidecarRelativePath) {
      return { ok: false, relativePath: owner.descriptorRelativePath ?? '', reason: `Captured CF base owner не имеет descriptor для проверки отсутствия Form ${displayNames.join('/')}.` };
    }
    const ownerCapture = await captureIndexedFile(root, owner.descriptorRelativePath, owner.descriptorHash);
    if (!ownerCapture.ok) { return { ok: false, relativePath: owner.descriptorRelativePath, reason: ownerCapture.reason }; }
    const registrations = readFormRegistrationsFromBytes(ownerCapture.content, owner);
    if (registrations.error) { return { ok: false, relativePath: owner.descriptorRelativePath, reason: registrations.error }; }
    if (registrations.names.some((name) => normalizeName(name) === normalizedName)) {
      return { ok: false, relativePath: owner.descriptorRelativePath, reason: `Form ${displayNames.join('/')} зарегистрирована в captured CF base.` };
    }
    for (const displayName of [...new Set(displayNames)]) {
      const descriptorRelativePath = nestedFormDescriptorPath(owner, displayName);
      const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, descriptorRelativePath), { retainContent: false }).catch(() => undefined);
      if (!snapshot || snapshot.state !== 'missing') {
        return { ok: false, relativePath: descriptorRelativePath, reason: `В captured CF base существует nested descriptor ${descriptorRelativePath} без registration; own Form package неоднозначен.` };
      }
      witnesses.push({ sourceId: root.sourceId, relativePath: descriptorRelativePath, expectedHash: MISSING_TARGET_HASH, kind: 'file' });
    }
    witnesses.push(ownerCapture.witness);
  }
  return { ok: true, witnesses: dedupeWitnesses(witnesses) };
}

async function captureIndexedFile(
  root: ExtensionMetadataIndex,
  relativePath: string,
  expectedHash: string,
): Promise<{ readonly ok: true; readonly content: Buffer; readonly witness: MergeFileWitness } | { readonly ok: false; readonly reason: string }> {
  try {
    const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, relativePath), { retainContent: true });
    if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined || normalizeHash(snapshot.hash) !== normalizeHash(expectedHash)) {
      return { ok: false, reason: `Физический файл ${relativePath} отсутствует или изменился после индексации.` };
    }
    const content = Buffer.from(snapshot.contentBase64, 'base64');
    return { ok: true, content, witness: { sourceId: root.sourceId, relativePath, expectedHash: normalizeHash(snapshot.hash), kind: 'file' } };
  } catch (error) {
    return { ok: false, reason: `Не удалось захватить ${relativePath}: ${errorMessage(error)}` };
  }
}

function readFormRegistrations(owner: ExtensionIndexedObject): FormRegistrationSet {
  if (!owner.descriptorContent) { return { names: [], error: `Descriptor ${owner.descriptorRelativePath ?? owner.qualifiedName} недоступен.` }; }
  return readFormRegistrationsFromBytes(owner.descriptorContent, owner);
}

function readFormRegistrationsFromBytes(content: Buffer, owner: ExtensionIndexedObject): FormRegistrationSet {
  try {
    const descriptors = registeredFormsFromOwner(content, owner);
    return descriptors;
  } catch (error) {
    return { names: [], error: `Не удалось разобрать Form registration у ${owner.qualifiedName}: ${errorMessage(error)}` };
  }
}

function registeredFormsFromOwner(content: Buffer, owner: ExtensionIndexedObject): FormRegistrationSet {
  const root = parseXmlDocument(content.toString('utf8')).root;
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {
    return { names: [], error: 'Owner descriptor должен иметь MDClasses/MetaDataObject root.' };
  }
  const ownerObjects = elementChildren(root).filter((item) => namespaceUriForName(item) === MDCLASSES_NAMESPACE);
  if (ownerObjects.length !== 1) { return { names: [], error: 'Owner descriptor должен содержать ровно один MDClasses root object.' }; }
  const expectedType = owner.descriptorRootTag ?? owner.metadataType;
  const properties = elementChildren(ownerObjects[0]!).filter((item) => item.localName === 'Properties'
    && namespaceUriForName(item) === MDCLASSES_NAMESPACE);
  const namesInProperties = properties.length === 1
    ? elementChildren(properties[0]!).filter((item) => item.localName === 'Name' && namespaceUriForName(item) === MDCLASSES_NAMESPACE)
    : [];
  if (ownerObjects[0]!.localName !== expectedType || properties.length !== 1 || namesInProperties.length !== 1
    || textContent(namesInProperties[0]!).trim().normalize('NFC') !== owner.name.trim().normalize('NFC')
    || Boolean(owner.identity?.uuid && (attribute(ownerObjects[0]!, 'uuid') ?? '').toLowerCase() !== owner.identity.uuid.toLowerCase())) {
    return { names: [], error: 'Captured owner descriptor не совпадает с exact indexed root identity.' };
  }
  const containers = elementChildren(ownerObjects[0]!).filter((item) => item.localName === 'ChildObjects');
  if (containers.length > 1 || containers.some((item) => namespaceUriForName(item) !== MDCLASSES_NAMESPACE)) {
    return { names: [], error: 'Owner descriptor имеет неоднозначный MDClasses/ChildObjects.' };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const child of containers[0] ? elementChildren(containers[0]) : []) {
    if (child.localName !== 'Form' || namespaceUriForName(child) !== MDCLASSES_NAMESPACE) { continue; }
    const name = textContent(child).trim();
    const key = normalizeName(name);
    if (!name || /[\\/\0]/u.test(name) || name === '.' || name === '..' || elementChildren(child).length > 0 || seen.has(key)) {
      return { names: [], error: `Form registration ${name || '(empty)'} пустая, повторная или неоднозначная.` };
    }
    seen.add(key);
    names.push(name);
  }
  const metadataType = owner.descriptorRootTag ?? owner.metadataType;
  if (owner.metadataType !== metadataType) { return { names: [], error: 'Owner descriptor root type не совпадает с metadata index.' }; }
  return { names };
}

function parseOwnFormDescriptor(content: Buffer, name: string, formatVersion: string): CapturedAdoptedOwnFormIdentity | undefined {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE
      || attribute(root, 'version') !== formatVersion) { return undefined; }
    const roots = elementChildren(root);
    if (roots.length !== 1 || roots[0]!.localName !== 'Form' || namespaceUriForName(roots[0]!) !== MDCLASSES_NAMESPACE) { return undefined; }
    const form = roots[0]!;
    const uuid = attribute(form, 'uuid')?.trim() ?? '';
    if (!UUID_PATTERN.test(uuid) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(uuid)) { return undefined; }
    const properties = elementChildren(form).filter((item) => item.localName === 'Properties' && namespaceUriForName(item) === MDCLASSES_NAMESPACE);
    if (properties.length !== 1) { return undefined; }
    const propertyChildren = elementChildren(properties[0]!);
    const names = propertyChildren.filter((item) => item.localName === 'Name' && namespaceUriForName(item) === MDCLASSES_NAMESPACE);
    if (names.length !== 1 || textContent(names[0]!).trim().normalize('NFC') !== name.trim().normalize('NFC')) { return undefined; }
    if (propertyChildren.some((item) => item.localName === 'ObjectBelonging' || item.localName === 'ExtendedConfigurationObject')) { return undefined; }
    return { ownership: 'own', type: 'Form', name: textContent(names[0]!).trim(), uuid: uuid.toLowerCase() };
  } catch {
    return undefined;
  }
}

function validStandaloneFormBody(content: Buffer, formatVersion: string): boolean {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (root.localName !== 'Form' || namespaceUriForName(root) !== LOGFORM_NAMESPACE || attribute(root, 'version') !== formatVersion) { return false; }
    return !containsNamedElement(root, 'BaseForm');
  } catch {
    return false;
  }
}

function containsNamedElement(element: ReturnType<typeof parseXmlDocument>['root'], localName: string): boolean {
  if (element.localName === localName) { return true; }
  return elementChildren(element).some((child) => containsNamedElement(child, localName));
}

function validateCapturedPackage(
  recipe: ExtensionLinkedDesignerPackage,
  source: CapturedOwnForm,
): { readonly ok: true } | { readonly ok: false; readonly relativePath: string; readonly reason: string } {
  const descriptor = recipe.members.filter((member) => samePath(member.sourceRelativePath ?? '', source.descriptorRelativePath));
  const body = recipe.members.filter((member) => samePath(member.sourceRelativePath ?? '', source.bodyRelativePath));
  if (descriptor.length !== 1 || body.length !== 1
    || !descriptor[0]!.content || !body[0]!.content
    || normalizeHash(descriptor[0]!.sourceHash ?? '') !== normalizeHash(source.descriptorWitness.expectedHash)
    || normalizeHash(body[0]!.sourceHash ?? '') !== normalizeHash(source.bodyWitness.expectedHash)
    || !descriptor[0]!.content.equals(source.descriptor)
    || !body[0]!.content.equals(source.body)) {
    return { ok: false, relativePath: source.descriptorRelativePath, reason: 'Linked Form package не совпадает с одним captured own descriptor и Form.xml.' };
  }
  if (recipe.members.some((member) => member.expectedTargetHash !== MISSING_TARGET_HASH)) {
    return { ok: false, relativePath: source.descriptorRelativePath, reason: 'Target уже содержит файл нового own Form package.' };
  }
  return { ok: true };
}

function nestedFormDescriptorPath(owner: ExtensionIndexedObject, name: string): string {
  const sidecar = owner.sidecarRelativePath?.replace(/\\/gu, '/').replace(/\/$/u, '');
  return sidecar ? `${sidecar}/Forms/${name}.xml` : `${owner.descriptorRelativePath ?? ''}#Forms/${name}.xml`;
}

function witnessFor(root: ExtensionMetadataIndex, owner: ExtensionIndexedObject): MergeFileWitness {
  return {
    sourceId: root.sourceId,
    relativePath: owner.descriptorRelativePath ?? '',
    expectedHash: normalizeHash(owner.descriptorHash ?? ''),
    kind: 'file',
  };
}

function blocker(name: string, relativePath: string, reason: string): ExtensionAdoptedOwnFormBlocker {
  return { name, relativePath, reason };
}

function emptyPreparation(blockers: readonly ExtensionAdoptedOwnFormBlocker[]): ExtensionAdoptedOwnFormPreparation {
  return {
    ownFormRegistrations: { target: [], source: [] }, packageProofs: [], matchedForms: [], descriptorWitnesses: [], blockers,
  };
}

function uniqueNames(names: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const name of names) { byKey.set(normalizeName(name), name); }
  return [...byKey.values()];
}

function sameOwnFormIdentity(left: CapturedAdoptedOwnFormIdentity, right: CapturedAdoptedOwnFormIdentity): boolean {
  return left.ownership === 'own' && right.ownership === 'own' && left.type === right.type
    && left.name.trim().normalize('NFC') === right.name.trim().normalize('NFC')
    && normalizeUuid(left.uuid) === normalizeUuid(right.uuid);
}

function attribute(element: ReturnType<typeof parseXmlDocument>['root'], name: string): string | undefined {
  return element.attributes.find((item) => item.name === name)?.value;
}

function normalizeName(value: string): string { return value.trim().normalize('NFC').toLocaleLowerCase('en-US'); }
function normalizeUuid(value: string): string { return value.toLowerCase(); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function normalizePath(value: string): string { const normalized = value.replace(/\\/gu, '/').normalize('NFC'); return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized; }
function samePath(left: string, right: string): boolean { return normalizePath(left) === normalizePath(right); }
function witnessKey(witness: MergeFileWitness): string { return `${witness.sourceId}\0${normalizePath(witness.relativePath)}\0${witness.kind ?? 'file'}`; }
function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const output = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    const key = witnessKey(witness);
    const previous = output.get(key);
    if (previous && normalizeHash(previous.expectedHash) !== normalizeHash(witness.expectedHash)) {
      throw new Error(`Conflicting own Form witnesses for ${witness.sourceId}:${witness.relativePath}.`);
    }
    output.set(key, { ...witness, expectedHash: witness.expectedHash === MISSING_TARGET_HASH ? witness.expectedHash : normalizeHash(witness.expectedHash) });
  }
  return [...output.values()];
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isAdoptedCfeOwner(root: ExtensionMetadataIndex, owner: ExtensionIndexedObject): boolean {
  return root.rootKind === 'cfe' && owner.identity?.ownership === 'adopted';
}
