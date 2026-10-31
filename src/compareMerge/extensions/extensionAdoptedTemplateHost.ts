import { createHash } from 'crypto';
import * as path from 'path';

import { parseCfeObjectIdentity, type CfeObjectIdentity } from '../../extensionSupport/cfeProject/ownership';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { captureMergePath } from '../merge/mergeSnapshot';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { requiredLinkedDesignerBodyPath } from '../linkedDesignerPackageRules';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';
import type { ExtensionAdoptedDirection, ExtensionAdoptedRowProof } from './extensionAdoptedSemanticContext';
import type { AdoptedDesignerIdentity } from './adoptedDesignerProjection';
import {
  projectExtensionAdoptedDescriptor,
  type AdoptedSemanticArtifactCapture,
} from './extensionAdoptedSemanticBridge';
import {
  type CapturedAdoptedTemplateProjectionInput,
  projectCapturedAdoptedTemplateBundle,
  type CapturedAdoptedTemplateOwnerProof,
  type CapturedAdoptedTemplatePhysicalSide,
} from './extensionAdoptedTemplateCapture';
import {
  type CapturedAdoptedTemplateBundle,
} from './extensionAdoptedTemplateBridge';

const MD_CLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const SUPPORTED_TEMPLATE_TYPES = new Set([
  'TextDocument', 'BinaryData', 'SpreadsheetDocument', 'DataCompositionSchema', 'ActiveDocument',
]);

export interface ExtensionAdoptedPreparedTemplateArtifact {
  readonly metadataType: 'Template' | 'CommonTemplate';
  readonly qualifiedName: string;
  readonly targetRelativePath: string;
  readonly sourceRelativePath: string;
  readonly targetHash: string;
  readonly sourceHash: string;
  readonly targetXml: Buffer;
  readonly sourceXml: Buffer;
  readonly recipe: CapturedAdoptedTemplateBundle;
  readonly bodyEffect: boolean;
  readonly requiredWitnesses: readonly MergeFileWitness[];
}

export interface ExtensionAdoptedTemplateBlocker {
  readonly targetRelativePath: string;
  readonly sourceRelativePath?: string;
  readonly reason: string;
}

export interface ExtensionAdoptedTemplatePreparation {
  readonly artifacts: readonly ExtensionAdoptedPreparedTemplateArtifact[];
  readonly blockers: readonly ExtensionAdoptedTemplateBlocker[];
}

/**
 * Captures only root CommonTemplate objects or nested Template registrations present on
 * target, source, and both captured base owners. The caller supplies the row's existing
 * owner/base captures and common-configuration witnesses; this helper never resolves a
 * second adopted row context.
 */
export async function prepareExtensionAdoptedTemplatesForRow(input: {
  readonly row: ExtensionTransferRow;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly direction: ExtensionAdoptedDirection;
  readonly proof: Extract<ExtensionAdoptedRowProof, { readonly ok: true }>;
  readonly ownerCaptures: CapturedAdoptedTemplateOwnerProof;
  readonly configurationWitnesses: readonly MergeFileWitness[];
}): Promise<ExtensionAdoptedTemplatePreparation> {
  const artifacts: ExtensionAdoptedPreparedTemplateArtifact[] = [];
  const blockers: ExtensionAdoptedTemplateBlocker[] = [];
  const targetOwner = input.row.target;
  const sourceOwner = input.row.incoming;
  const baseOwner = input.proof.baseObject;
  const sourceBaseOwner = input.proof.otherBaseObject ?? baseOwner;
  if (!targetOwner || !sourceOwner) { return { artifacts, blockers }; }

  if (input.targetRoot.formatVersion !== input.incomingRoot.formatVersion
      || !input.targetRoot.formatVersion
      || input.targetRoot.formatVersion !== input.proof.baseRoot.formatVersion
      || input.proof.otherBaseRoot && input.proof.otherBaseRoot.formatVersion !== input.targetRoot.formatVersion) {
    return {
      artifacts,
      blockers: [{
        targetRelativePath: targetOwner.descriptorRelativePath ?? input.row.qualifiedName,
        sourceRelativePath: sourceOwner.descriptorRelativePath,
        reason: 'Версии Designer Template не совпадают с уже доказанным форматом adopted owner row.',
      }],
    };
  }

  const ownerCapturesMatch = sameOwnerCapture(input.ownerCaptures.target, targetOwner)
    && sameOwnerCapture(input.ownerCaptures.source, sourceOwner)
    && sameOwnerCapture(input.ownerCaptures.targetBase, baseOwner)
    && sameOwnerCapture(input.ownerCaptures.sourceBase, sourceBaseOwner);
  if (!ownerCapturesMatch) {
    return {
      artifacts,
      blockers: [{
        targetRelativePath: targetOwner.descriptorRelativePath ?? input.row.qualifiedName,
        sourceRelativePath: sourceOwner.descriptorRelativePath,
        reason: 'Переданные owner captures не совпадают с уже разрешёнными target/source/base объектами.',
      }],
    };
  }

  if (targetOwner.metadataType === 'CommonTemplate' || sourceOwner.metadataType === 'CommonTemplate') {
    if (targetOwner.metadataType !== 'CommonTemplate' || sourceOwner.metadataType !== 'CommonTemplate'
        || baseOwner.metadataType !== 'CommonTemplate' || sourceBaseOwner.metadataType !== 'CommonTemplate') {
      return {
        artifacts,
        blockers: [{
          targetRelativePath: targetOwner.descriptorRelativePath ?? input.row.qualifiedName,
          sourceRelativePath: sourceOwner.descriptorRelativePath,
          reason: 'Root CommonTemplate должен совпадать по типу во всех captured sides и обеих базах.',
        }],
      };
    }
    const result = await prepareTemplateBundle({
      metadataType: 'CommonTemplate',
      qualifiedName: input.row.qualifiedName,
      targetRoot: input.targetRoot,
      sourceRoot: input.incomingRoot,
      targetOwner,
      sourceOwner,
      targetBaseOwner: baseOwner,
      sourceBaseOwner,
      targetBaseRoot: input.proof.baseRoot,
      sourceBaseRoot: input.proof.otherBaseRoot ?? input.proof.baseRoot,
      targetDescriptor: input.ownerCaptures.target,
      sourceDescriptor: input.ownerCaptures.source,
      targetBaseDescriptor: input.ownerCaptures.targetBase,
      sourceBaseDescriptor: input.ownerCaptures.sourceBase,
      direction: input.direction,
      formatVersion: input.targetRoot.formatVersion,
      configurationWitnesses: input.configurationWitnesses,
    });
    if ('reason' in result) {
      blockers.push({ targetRelativePath: input.ownerCaptures.target.witness.relativePath,
        sourceRelativePath: input.ownerCaptures.source.witness.relativePath, reason: result.reason });
    } else if (result.artifact) { artifacts.push(result.artifact); }
    return { artifacts, blockers };
  }

  const targetRegistrations = readTemplateRegistrations(input.ownerCaptures.target, targetOwner, input.targetRoot.formatVersion!);
  const sourceRegistrations = readTemplateRegistrations(input.ownerCaptures.source, sourceOwner, input.incomingRoot.formatVersion!);
  const targetBaseRegistrations = readTemplateRegistrations(input.ownerCaptures.targetBase, baseOwner, input.proof.baseRoot.formatVersion!);
  const sourceBaseRegistrations = readTemplateRegistrations(input.ownerCaptures.sourceBase, sourceBaseOwner,
    (input.proof.otherBaseRoot ?? input.proof.baseRoot).formatVersion!);
  const registrationFailure = [targetRegistrations, sourceRegistrations, targetBaseRegistrations, sourceBaseRegistrations]
    .find((result) => !result.ok);
  if (registrationFailure && !registrationFailure.ok) {
    return {
      artifacts,
      blockers: [{
        targetRelativePath: registrationFailure.relativePath,
        sourceRelativePath: sourceOwner.descriptorRelativePath,
        reason: registrationFailure.reason,
      }],
    };
  }

  const targetNames = targetRegistrations.ok ? targetRegistrations.names : [];
  const sourceNames = sourceRegistrations.ok ? sourceRegistrations.names : [];
  const targetBaseNames = targetBaseRegistrations.ok ? targetBaseRegistrations.names : [];
  const sourceBaseNames = sourceBaseRegistrations.ok ? sourceBaseRegistrations.names : [];
  const baseSet = new Set(targetBaseNames.filter((name) => sourceBaseNames.includes(name)));
  const intersection = targetNames.filter((name) => sourceNames.includes(name) && baseSet.has(name));
  for (const name of intersection) {
    const targetPath = nestedTemplatePath(targetOwner, name);
    const sourcePath = nestedTemplatePath(sourceOwner, name);
    const targetBasePath = nestedTemplatePath(baseOwner, name);
    const sourceBasePath = nestedTemplatePath(sourceBaseOwner, name);
    if (!targetPath || !sourcePath || !targetBasePath || !sourceBasePath) {
      blockers.push({
        targetRelativePath: targetPath ?? targetOwner.descriptorRelativePath ?? input.row.qualifiedName,
        sourceRelativePath: sourcePath,
        reason: `Не удалось вывести точный registered Template descriptor path для ${name}.`,
      });
      continue;
    }
    const [targetDescriptor, sourceDescriptor, targetBaseDescriptor, sourceBaseDescriptor] = await Promise.all([
      captureNestedDescriptor(input.targetRoot, targetOwner, targetPath, 'Template', name),
      captureNestedDescriptor(input.incomingRoot, sourceOwner, sourcePath, 'Template', name),
      captureNestedDescriptor(input.proof.baseRoot, baseOwner, targetBasePath, 'Template', name),
      captureNestedDescriptor(input.proof.otherBaseRoot ?? input.proof.baseRoot, sourceBaseOwner, sourceBasePath, 'Template', name),
    ]);
    const failed = [targetDescriptor, sourceDescriptor, targetBaseDescriptor, sourceBaseDescriptor]
      .find((capture) => !capture.ok);
    if (failed && !failed.ok) {
      blockers.push({ targetRelativePath: targetPath, sourceRelativePath: sourcePath, reason: failed.reason });
      continue;
    }
    if (!targetDescriptor.ok || !sourceDescriptor.ok || !targetBaseDescriptor.ok || !sourceBaseDescriptor.ok) { continue; }
    const result = await prepareTemplateBundle({
      metadataType: 'Template',
      qualifiedName: `${input.row.qualifiedName}.Template.${name}`,
      targetRoot: input.targetRoot,
      sourceRoot: input.incomingRoot,
      targetOwner,
      sourceOwner,
      targetBaseOwner: baseOwner,
      sourceBaseOwner,
      targetBaseRoot: input.proof.baseRoot,
      sourceBaseRoot: input.proof.otherBaseRoot ?? input.proof.baseRoot,
      targetDescriptor: targetDescriptor.capture,
      sourceDescriptor: sourceDescriptor.capture,
      targetBaseDescriptor: targetBaseDescriptor.capture,
      sourceBaseDescriptor: sourceBaseDescriptor.capture,
      direction: input.direction,
      formatVersion: input.targetRoot.formatVersion,
      configurationWitnesses: input.configurationWitnesses,
      ownerProof: input.ownerCaptures,
    });
    if ('reason' in result) {
      blockers.push({ targetRelativePath: targetPath, sourceRelativePath: sourcePath, reason: result.reason });
    } else if (result.artifact) { artifacts.push(result.artifact); }
  }
  return { artifacts, blockers };
}

async function prepareTemplateBundle(input: {
  readonly metadataType: 'Template' | 'CommonTemplate';
  readonly qualifiedName: string;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly sourceRoot: ExtensionMetadataIndex;
  readonly targetOwner: ExtensionIndexedObject;
  readonly sourceOwner: ExtensionIndexedObject;
  readonly targetBaseOwner: ExtensionIndexedObject;
  readonly sourceBaseOwner: ExtensionIndexedObject;
  readonly targetBaseRoot: ExtensionMetadataIndex;
  readonly sourceBaseRoot: ExtensionMetadataIndex;
  readonly targetDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceDescriptor: AdoptedSemanticArtifactCapture;
  readonly targetBaseDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceBaseDescriptor: AdoptedSemanticArtifactCapture;
  readonly direction: ExtensionAdoptedDirection;
  readonly formatVersion: string;
  readonly configurationWitnesses: readonly MergeFileWitness[];
  readonly ownerProof?: CapturedAdoptedTemplateOwnerProof;
}): Promise<{ readonly artifact: ExtensionAdoptedPreparedTemplateArtifact } | { readonly reason: string } | { readonly artifact?: undefined }> {
  const projection = projectExtensionAdoptedDescriptor({
    direction: input.direction,
    target: input.targetDescriptor,
    source: input.sourceDescriptor,
    base: input.targetBaseDescriptor,
    formatVersion: input.formatVersion,
  });
  if (!projection.ok || projection.recipe.kind !== 'adopted-descriptor') {
    return { reason: projection.ok ? 'Не удалось получить captured adopted Template descriptor recipe.' : projection.reason };
  }
  const targetType = templateType(projection.targetXml, input.metadataType);
  const sourceType = templateType(projection.sourceXml, input.metadataType);
  const targetBaseType = templateType(input.targetBaseDescriptor.content, input.metadataType);
  const sourceBaseType = templateType(input.sourceBaseDescriptor.content, input.metadataType);
  if (!targetType || !sourceType || !targetBaseType || !sourceBaseType) {
    return { reason: 'TemplateType отсутствует, неоднозначен или не входит в однофайловый body profile.' };
  }

  const paths = {
    target: bodyPath(input.targetDescriptor, projection.targetXml),
    source: bodyPath(input.sourceDescriptor, projection.sourceXml),
    targetBase: bodyPath(input.targetBaseDescriptor, input.targetBaseDescriptor.content),
    sourceBase: bodyPath(input.sourceBaseDescriptor, input.sourceBaseDescriptor.content),
    targetDestination: bodyPath(input.targetDescriptor, projection.sourceXml),
  };
  if (Object.values(paths).some((value) => value === undefined)) {
    return { reason: 'Не удалось вывести физический single-file Template body path через поддерживаемый реестр.' };
  }
  const [targetBody, sourceBody, targetBaseBody, sourceBaseBody, targetDestinationBody] = await Promise.all([
    capturePhysicalSide(input.targetRoot, input.targetOwner, paths.target!, input.targetDescriptor.identity,
      input.targetDescriptor.identity.ownership === 'adopted', targetType, targetBaseType, 'target'),
    capturePhysicalSide(input.sourceRoot, input.sourceOwner, paths.source!, input.sourceDescriptor.identity,
      input.sourceDescriptor.identity.ownership === 'adopted', sourceType, sourceBaseType, 'source'),
    captureRequiredBaseBody(input.targetBaseRoot, input.targetBaseOwner, paths.targetBase!, input.targetBaseDescriptor.identity),
    captureRequiredBaseBody(input.sourceBaseRoot, input.sourceBaseOwner, paths.sourceBase!, input.sourceBaseDescriptor.identity),
    captureDestinationSide(input.targetRoot, input.targetOwner, paths.targetDestination!, input.targetDescriptor.identity),
  ]);
  const captures = [targetBody, sourceBody, targetBaseBody, sourceBaseBody, targetDestinationBody];
  const failed = captures.find((capture) => !capture.ok);
  if (failed && !failed.ok) { return { reason: failed.reason }; }
  if (!targetBody.ok || !sourceBody.ok || !targetBaseBody.ok || !sourceBaseBody.ok || !targetDestinationBody.ok) {
    return { reason: 'Не удалось сохранить согласованность captured Template body sides.' };
  }
  if (targetBaseBody.side.kind !== 'file' || sourceBaseBody.side.kind !== 'file') {
    return { reason: 'Каждая captured CF база должна содержать физический Template body.' };
  }
  const extraBaseWitnesses = input.ownerProof
    ? dedupeWitnesses([input.ownerProof.targetBase.witness, input.ownerProof.sourceBase.witness,
      targetBaseBody.side.capture.witness, sourceBaseBody.side.capture.witness])
    : [];
  const bundleInput: CapturedAdoptedTemplateProjectionInput = {
    direction: input.direction,
    formatVersion: input.formatVersion,
    metadataType: input.metadataType,
    targetDescriptor: input.targetDescriptor,
    sourceDescriptor: input.sourceDescriptor,
    targetBaseDescriptor: input.targetBaseDescriptor,
    sourceBaseDescriptor: input.sourceBaseDescriptor,
    targetBody: targetBody.side,
    sourceBody: sourceBody.side,
    targetDestinationBody: targetDestinationBody.side,
    targetBaseBody: targetBaseBody.side.capture,
    sourceBaseBody: sourceBaseBody.side.capture,
    ...(input.ownerProof ? { ownerProof: input.ownerProof } : {}),
    configurationWitnesses: input.configurationWitnesses,
    ...(extraBaseWitnesses.length ? { additionalBaseWitnesses: extraBaseWitnesses } : {}),
  };
  const projected = projectCapturedAdoptedTemplateBundle(bundleInput);
  if (!projected.ok) { return { reason: projected.reason }; }
  const bodyEffect = projected.recipe.targetTemplateType !== projected.recipe.sourceTemplateType
    || hash(projected.recipe.targetLogicalBody) !== hash(projected.recipe.sourceLogicalBody);
  const requiredWitnesses = dedupeWitnesses(projected.requiredWitnesses);
  return {
    artifact: {
      metadataType: input.metadataType,
      qualifiedName: input.qualifiedName,
      targetRelativePath: input.targetDescriptor.witness.relativePath,
      sourceRelativePath: input.sourceDescriptor.witness.relativePath,
      targetHash: input.targetDescriptor.witness.expectedHash,
      sourceHash: input.sourceDescriptor.witness.expectedHash,
      targetXml: projected.targetXml,
      sourceXml: projected.sourceXml,
      recipe: projected.recipe,
      bodyEffect,
      requiredWitnesses,
    },
  };
}

async function captureNestedDescriptor(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
  metadataType: 'Template',
  expectedName: string,
): Promise<{ readonly ok: true; readonly capture: AdoptedSemanticArtifactCapture } | { readonly ok: false; readonly reason: string }> {
  const matches = owner.sidecarFiles.filter((file) => samePath(file.relativePath, relativePath));
  if (matches.length !== 1 || !matches[0]?.hash) {
    return { ok: false, reason: `Nested Template descriptor должен быть единственным индексированным файлом ${relativePath}.` };
  }
  const physical = await captureIndexedFile(root, relativePath, matches[0]!.hash);
  if (!physical.ok) { return physical; }
  let identity: CfeObjectIdentity;
  try { identity = parseCfeObjectIdentity(physical.capture.content.toString('utf8'), relativePath); }
  catch (error) { return { ok: false, reason: `Nested Template identity не подтверждена: ${errorMessage(error)}` }; }
  if (identity.type !== metadataType || identity.name !== expectedName) {
    return { ok: false, reason: `Nested descriptor ${relativePath} не совпадает с registered Template ${expectedName}.` };
  }
  return { ok: true, capture: { ...physical.capture, identity: identityFor(identity) } };
}

async function capturePhysicalSide(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
  identity: AdoptedDesignerIdentity,
  adopted: boolean,
  effectiveType: string,
  baseType: string,
  label: string,
): Promise<{ readonly ok: true; readonly side: CapturedAdoptedTemplatePhysicalSide } | { readonly ok: false; readonly reason: string }> {
  const result = await captureIndexedOrMissing(root, owner, relativePath, identity);
  if (!result.ok) { return result; }
  if (result.side.kind === 'missing' && (!adopted || effectiveType !== baseType)) {
    return { ok: false, reason: `Отсутствующее ${label} Template body можно унаследовать только при неизменном effective TemplateType.` };
  }
  return result;
}

async function captureDestinationSide(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
  identity: AdoptedDesignerIdentity,
): Promise<{ readonly ok: true; readonly side: CapturedAdoptedTemplatePhysicalSide } | { readonly ok: false; readonly reason: string }> {
  return captureIndexedOrMissing(root, owner, relativePath, identity);
}

async function captureRequiredBaseBody(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
  identity: AdoptedDesignerIdentity,
): Promise<{ readonly ok: true; readonly side: Extract<CapturedAdoptedTemplatePhysicalSide, { readonly kind: 'file' }> } | { readonly ok: false; readonly reason: string }> {
  const result = await captureIndexedOrMissing(root, owner, relativePath, identity);
  if (!result.ok) { return result; }
  if (result.side.kind !== 'file') { return { ok: false, reason: `Captured base Template body отсутствует: ${relativePath}.` }; }
  return { ok: true, side: result.side };
}

async function captureIndexedOrMissing(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
  identity: AdoptedDesignerIdentity,
): Promise<{ readonly ok: true; readonly side: CapturedAdoptedTemplatePhysicalSide } | { readonly ok: false; readonly reason: string }> {
  const matching = owner.sidecarFiles.filter((file) => samePath(file.relativePath, relativePath));
  if (matching.length > 1) { return { ok: false, reason: `В captured sidecar неоднозначен Template body ${relativePath}.` }; }
  let snapshot;
  try {
    snapshot = await captureMergePath(path.resolve(root.canonicalRootPath ?? root.rootPath, relativePath), { retainContent: true });
  } catch (error) { return { ok: false, reason: `Не удалось захватить ${relativePath}: ${errorMessage(error)}` }; }
  if (snapshot.state === 'missing') {
    if (matching.length > 0) { return { ok: false, reason: `Индексированный Template body отсутствует после compare: ${relativePath}.` }; }
    return { ok: true, side: { kind: 'missing', witness: { sourceId: root.sourceId, relativePath, expectedHash: MISSING_TARGET_HASH, kind: 'file' } } };
  }
  if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined || matching.length !== 1) {
    return { ok: false, reason: `Физический Template body не совпадает с единственным indexed regular file: ${relativePath}.` };
  }
  const content = Buffer.from(snapshot.contentBase64, 'base64');
  if (!sameHash(snapshot.hash, matching[0]!.hash) || hash(content) !== normalizeHash(snapshot.hash)) {
    return { ok: false, reason: `Физический Template body hash изменился после индексации: ${relativePath}.` };
  }
  return {
    ok: true,
    side: {
      kind: 'file',
      capture: {
        content,
        witness: { sourceId: root.sourceId, relativePath, expectedHash: normalizeHash(snapshot.hash), kind: 'file' },
        identity,
      },
    },
  };
}

async function captureIndexedFile(
  root: ExtensionMetadataIndex,
  relativePath: string,
  expectedHash: string,
): Promise<{ readonly ok: true; readonly capture: AdoptedSemanticArtifactCapture } | { readonly ok: false; readonly reason: string }> {
  let snapshot;
  try { snapshot = await captureMergePath(path.resolve(root.canonicalRootPath ?? root.rootPath, relativePath), { retainContent: true }); }
  catch (error) { return { ok: false, reason: `Не удалось захватить ${relativePath}: ${errorMessage(error)}` }; }
  if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined) {
    return { ok: false, reason: `Captured Template descriptor отсутствует или не является regular file: ${relativePath}.` };
  }
  const content = Buffer.from(snapshot.contentBase64, 'base64');
  if (!sameHash(snapshot.hash, expectedHash) || hash(content) !== normalizeHash(snapshot.hash)) {
    return { ok: false, reason: `Template descriptor hash изменился после индексации: ${relativePath}.` };
  }
  let parsed: CfeObjectIdentity;
  try { parsed = parseCfeObjectIdentity(content.toString('utf8'), relativePath); }
  catch (error) { return { ok: false, reason: `Template descriptor identity не подтверждена: ${errorMessage(error)}` }; }
  return {
    ok: true,
    capture: {
      content,
      witness: { sourceId: root.sourceId, relativePath, expectedHash: normalizeHash(snapshot.hash), kind: 'file' },
      identity: identityFor(parsed),
    },
  };
}

function readTemplateRegistrations(
  ownerCapture: AdoptedSemanticArtifactCapture,
  owner: ExtensionIndexedObject,
  formatVersion: string,
): { readonly ok: true; readonly names: readonly string[] } | { readonly ok: false; readonly relativePath: string; readonly reason: string } {
  const relativePath = ownerCapture.witness.relativePath;
  try {
    const root = parseXmlDocument(ownerCapture.content.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MD_CLASSES_NAMESPACE
        || root.attributes.filter((attribute) => attribute.name === 'version').length !== 1
        || root.attributes.find((attribute) => attribute.name === 'version')?.value !== formatVersion) {
      return { ok: false, relativePath, reason: 'Дескриптор nested Template owner имеет неверный MDClasses root.' };
    }
    const objects = elementChildren(root).filter((element) => element.localName === owner.metadataType
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    if (objects.length !== 1 || (objects[0]!.attributes.find((attribute) => attribute.name === 'uuid')?.value ?? '').toLowerCase()
        !== ownerCapture.identity.uuid.toLowerCase()) {
      return { ok: false, relativePath, reason: 'Metadata owner root tag/UUID не совпадает с captured identity.' };
    }
    const properties = elementChildren(objects[0]!).filter((element) => element.localName === 'Properties'
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    const nameNodes = properties.length === 1 ? elementChildren(properties[0]!).filter((element) => element.localName === 'Name'
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE) : [];
    if (nameNodes.length !== 1 || textContent(nameNodes[0]!).trim() !== ownerCapture.identity.name) {
      return { ok: false, relativePath, reason: 'Metadata owner Name не совпадает с captured identity.' };
    }
    const childObjects = elementChildren(objects[0]!).filter((element) => element.localName === 'ChildObjects'
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    if (childObjects.length > 1) {
      return { ok: false, relativePath, reason: 'Nested Template owner не может иметь несколько прямых MDClasses ChildObjects.' };
    }
    const names: string[] = [];
    for (const child of childObjects[0] ? elementChildren(childObjects[0]) : []) {
      if (child.localName !== 'Template' || namespaceUriForName(child) !== MD_CLASSES_NAMESPACE) { continue; }
      if (elementChildren(child).length > 0 || child.attributes.length > 0) {
        return { ok: false, relativePath, reason: 'Template registration должна содержать только имя и не должна содержать вложенную структуру.' };
      }
      const name = textContent(child).trim();
      if (!name || child.children.some((item) => item.kind !== 'text')) {
        return { ok: false, relativePath, reason: 'Template registration имеет пустое или неоднозначное plain-text имя.' };
      }
      names.push(name);
    }
    if (new Set(names.map(normalizeName)).size !== names.length) {
      return { ok: false, relativePath, reason: 'В MDClasses ChildObjects повторяется имя Template registration.' };
    }
    return { ok: true, names };
  } catch (error) {
    return { ok: false, relativePath, reason: `Не удалось разобрать Template registrations: ${errorMessage(error)}` };
  }
}

function sameOwnerCapture(capture: AdoptedSemanticArtifactCapture, owner: ExtensionIndexedObject): boolean {
  return capture.witness.sourceId === owner.sourceId
    && samePath(capture.witness.relativePath, owner.descriptorRelativePath ?? '')
    && sameHash(capture.witness.expectedHash, owner.descriptorHash ?? '')
    && capture.identity.type === owner.identity?.type
    && capture.identity.name === owner.identity?.name
    && sameUuid(capture.identity.uuid, owner.identity?.uuid ?? '')
    && (capture.identity.sourceUuid?.toLowerCase() ?? '') === (owner.identity?.sourceUuid?.toLowerCase() ?? '')
    && capture.identity.ownership === owner.identity?.ownership;
}

function nestedTemplatePath(owner: ExtensionIndexedObject, name: string): string | undefined {
  if (!owner.sidecarRelativePath || !owner.descriptorRelativePath) { return undefined; }
  return `${owner.sidecarRelativePath.replace(/\\/gu, '/')}/Templates/${name}.xml`;
}

function bodyPath(descriptor: AdoptedSemanticArtifactCapture, logicalXml: Buffer): string | undefined {
  return requiredLinkedDesignerBodyPath('Template', descriptor.witness.relativePath, logicalXml)?.replace(/\\/gu, '/');
}

function templateType(xml: Buffer, metadataType: 'Template' | 'CommonTemplate'): string | undefined {
  try {
    const root = parseXmlDocument(xml.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MD_CLASSES_NAMESPACE) { return undefined; }
    const objects = elementChildren(root).filter((element) => element.localName === metadataType
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    const properties = objects.length === 1 ? elementChildren(objects[0]!).filter((element) => element.localName === 'Properties'
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE) : [];
    const types = properties.length === 1 ? elementChildren(properties[0]!).filter((element) => element.localName === 'TemplateType'
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE) : [];
    if (types.length !== 1) { return undefined; }
    const value = textContent(types[0]!).trim();
    return SUPPORTED_TEMPLATE_TYPES.has(value) ? value : undefined;
  } catch { return undefined; }
}

function identityFor(identity: CfeObjectIdentity): AdoptedDesignerIdentity {
  return {
    ownership: identity.ownership,
    type: identity.type,
    name: identity.name,
    uuid: identity.uuid,
    ...(identity.sourceUuid ? { sourceUuid: identity.sourceUuid } : {}),
  };
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const map = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    const key = `${witness.sourceId}\0${normalizePath(witness.relativePath)}\0${witness.kind ?? 'file'}`;
    const existing = map.get(key);
    if (existing && !sameHash(existing.expectedHash, witness.expectedHash)) {
      throw new Error(`Raw Template witnesses конфликтуют: ${witness.relativePath}.`);
    }
    if (!existing) { map.set(key, { ...witness, kind: witness.kind ?? 'file' }); }
  }
  return [...map.values()];
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function samePath(left: string, right: string): boolean { return normalizePath(left) === normalizePath(right); }
function normalizeName(value: string): string { return value.normalize('NFC').toLocaleLowerCase('en-US'); }
function sameUuid(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function sameHash(left: string, right: string): boolean { return normalizeHash(left) === normalizeHash(right); }
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
