import { createHash } from 'crypto';

import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import type { RoleRightsProjectionIssue } from '../adapters/roleRightsEffectiveProjection';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import {
  materializeAdoptedDesignerRightsTarget,
  projectAdoptedDesignerRightsPair,
} from './adoptedDesignerRightsProjection';
import type { AdoptedDesignerDirection, AdoptedDesignerIdentity } from './adoptedDesignerProjection';
import type { AdoptedSemanticArtifactCapture } from './extensionAdoptedSemanticBridge';

const RIGHTS_STATE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';
const MD_CLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const SUPPORTED_RIGHTS_VERSIONS = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type CapturedAdoptedRightsSide =
  | { readonly kind: 'file'; readonly capture: AdoptedSemanticArtifactCapture }
  | { readonly kind: 'missing'; readonly witness: MergeFileWitness };

export interface CapturedAdoptedRightsProjectionInput {
  readonly direction: AdoptedDesignerDirection;
  readonly formatVersion: string;
  readonly targetDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceDescriptor: AdoptedSemanticArtifactCapture;
  readonly baseDescriptor: AdoptedSemanticArtifactCapture;
  readonly baseRights: AdoptedSemanticArtifactCapture;
  readonly targetRights: CapturedAdoptedRightsSide;
  readonly sourceRights: CapturedAdoptedRightsSide;
  readonly configurationWitnesses: readonly MergeFileWitness[];
  readonly additionalBaseWitnesses?: readonly MergeFileWitness[];
}

/** Immutable raw captures plus the initial logical pair used by selected Rights patches. */
export interface CapturedAdoptedRightsRecipe {
  readonly kind: 'adopted-rights';
  readonly direction: AdoptedDesignerDirection;
  readonly formatVersion: string;
  readonly targetDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceDescriptor: AdoptedSemanticArtifactCapture;
  readonly baseDescriptor: AdoptedSemanticArtifactCapture;
  readonly baseRights: AdoptedSemanticArtifactCapture;
  readonly targetRights: CapturedAdoptedRightsSide;
  readonly sourceRights: CapturedAdoptedRightsSide;
  readonly targetRightsRelativePath: string;
  readonly sourceRightsRelativePath: string;
  readonly targetDescriptorRelativePath: string;
  readonly initialLogicalTarget: Buffer;
  readonly initialLogicalSource: Buffer;
  readonly issues: readonly RoleRightsProjectionIssue[];
  readonly configurationWitnesses: readonly MergeFileWitness[];
  readonly additionalBaseWitnesses: readonly MergeFileWitness[];
  readonly requiredWitnesses: readonly MergeFileWitness[];
}

export type CapturedAdoptedRightsProjectionResult =
  | {
    readonly ok: true;
    readonly targetXml: Buffer;
    readonly sourceXml: Buffer;
    readonly recipe: CapturedAdoptedRightsRecipe;
    readonly issues: readonly RoleRightsProjectionIssue[];
    readonly requiredWitnesses: readonly MergeFileWitness[];
  }
  | { readonly ok: false; readonly reason: string; readonly issues: readonly RoleRightsProjectionIssue[] };

export type CapturedAdoptedRightsMaterializationResult =
  | {
    readonly ok: true;
    readonly changed: boolean;
    readonly content?: Buffer;
    readonly requiresRightsPropertyState: boolean;
    readonly issues: readonly RoleRightsProjectionIssue[];
    readonly requiredWitnesses: readonly MergeFileWitness[];
  }
  | { readonly ok: false; readonly reason: string; readonly issues: readonly RoleRightsProjectionIssue[] };

export type CapturedAdoptedRightsWitnessNormalizationResult =
  | { readonly ok: true; readonly witnesses: readonly MergeFileWitness[] }
  | { readonly ok: false; readonly reason: string };

/** Verifies host captures and creates one immutable logical Rights pair over the exact own base. */
export function projectCapturedAdoptedRightsPair(
  input: CapturedAdoptedRightsProjectionInput,
): CapturedAdoptedRightsProjectionResult {
  const issues: RoleRightsProjectionIssue[] = [];
  try {
    verifyCapturedInputs(input);
    const projection = projectAdoptedDesignerRightsPair({
      direction: input.direction,
      formatVersion: input.formatVersion,
      baseRightsXml: input.baseRights.content,
      ...(input.targetRights.kind === 'file' ? { targetRightsXml: input.targetRights.capture.content } : {}),
      ...(input.sourceRights.kind === 'file' ? { sourceRightsXml: input.sourceRights.capture.content } : {}),
    });
    if (!projection.ok) { return { ok: false, reason: projection.reason, issues: cloneIssues(projection.issues) }; }

    const targetRightsRelativePath = sideRelativePath(input.targetRights);
    const sourceRightsRelativePath = sideRelativePath(input.sourceRights);
    const requiredWitnesses = dedupeWitnesses([
      input.targetDescriptor.witness,
      input.sourceDescriptor.witness,
      input.baseDescriptor.witness,
      input.baseRights.witness,
      sideWitness(input.targetRights),
      sideWitness(input.sourceRights),
      ...input.configurationWitnesses,
      ...(input.additionalBaseWitnesses ?? []),
    ]);
    const recipe: CapturedAdoptedRightsRecipe = {
      kind: 'adopted-rights',
      direction: input.direction,
      formatVersion: input.formatVersion,
      targetDescriptor: cloneCapture(input.targetDescriptor),
      sourceDescriptor: cloneCapture(input.sourceDescriptor),
      baseDescriptor: cloneCapture(input.baseDescriptor),
      baseRights: cloneCapture(input.baseRights),
      targetRights: cloneSide(input.targetRights),
      sourceRights: cloneSide(input.sourceRights),
      targetRightsRelativePath,
      sourceRightsRelativePath,
      targetDescriptorRelativePath: input.targetDescriptor.witness.relativePath,
      initialLogicalTarget: Buffer.from(projection.targetXml),
      initialLogicalSource: Buffer.from(projection.sourceXml),
      issues: cloneIssues(projection.issues),
      configurationWitnesses: input.configurationWitnesses.map(cloneWitness),
      additionalBaseWitnesses: (input.additionalBaseWitnesses ?? []).map(cloneWitness),
      requiredWitnesses: requiredWitnesses.map(cloneWitness),
    };
    return {
      ok: true,
      targetXml: Buffer.from(projection.targetXml),
      sourceXml: Buffer.from(projection.sourceXml),
      recipe,
      issues: cloneIssues(projection.issues),
      requiredWitnesses: requiredWitnesses.map(cloneWitness),
    };
  } catch (error) {
    const reason = errorMessage(error);
    issues.push({ scope: 'file', reason });
    return { ok: false, reason, issues: cloneIssues(issues) };
  }
}

/** Rechecks raw snapshots, then encodes selected logical rights into the target's physical override. */
export function materializeCapturedAdoptedRightsTarget(input: {
  readonly recipe: CapturedAdoptedRightsRecipe;
  readonly mergedLogicalTarget: Buffer;
  readonly candidateWitnesses?: readonly MergeFileWitness[];
}): CapturedAdoptedRightsMaterializationResult {
  const issues: RoleRightsProjectionIssue[] = [];
  try {
    const recipe = input.recipe;
    verifyRecipe(recipe);
    if (!Buffer.isBuffer(input.mergedLogicalTarget)) { throw new Error('Объединённый логический Rights target должен быть Buffer.'); }
    const candidateWitnesses = translateCandidateWitnesses(recipe, input.candidateWitnesses ?? []);
    const requiredWitnesses = dedupeCandidateWitnesses([...recipe.requiredWitnesses, ...candidateWitnesses]);
    const targetAdopted = recipe.direction !== 'adopted-to-cf';
    if (input.mergedLogicalTarget.equals(recipe.initialLogicalTarget)) {
      return {
        ok: true,
        changed: false,
        ...(recipe.targetRights.kind === 'file' ? { content: Buffer.from(recipe.targetRights.capture.content) } : {}),
        requiresRightsPropertyState: false,
        issues: cloneIssues(recipe.issues),
        requiredWitnesses: requiredWitnesses.map(cloneWitness),
      };
    }

    const materialized = materializeAdoptedDesignerRightsTarget({
      direction: recipe.direction,
      formatVersion: recipe.formatVersion,
      baseRightsXml: recipe.baseRights.content,
      ...(recipe.targetRights.kind === 'file' ? { targetRightsXml: recipe.targetRights.capture.content } : {}),
      ...(recipe.sourceRights.kind === 'file' ? { sourceRightsXml: recipe.sourceRights.capture.content } : {}),
      mergedLogicalTarget: input.mergedLogicalTarget,
    });
    if (!materialized.ok) { return { ok: false, reason: materialized.reason, issues: cloneIssues(materialized.issues) }; }

    const previousBytes = recipe.targetRights.kind === 'file' ? recipe.targetRights.capture.content : undefined;
    const changed = previousBytes === undefined || !previousBytes.equals(materialized.content);
    return {
      ok: true,
      changed,
      ...(changed ? { content: Buffer.from(materialized.content) } : { content: Buffer.from(previousBytes!) }),
      requiresRightsPropertyState: changed && targetAdopted && materialized.requiresRightsPropertyState,
      issues: cloneIssues(materialized.issues),
      requiredWitnesses: requiredWitnesses.map(cloneWitness),
    };
  } catch (error) {
    const reason = errorMessage(error);
    issues.push({ scope: 'file', reason });
    return { ok: false, reason, issues: cloneIssues(issues) };
  }
}

/** Maps exact projected Rights witnesses back to their captured physical file or missing witness. */
export function normalizeCapturedAdoptedRightsWitnesses(
  recipe: CapturedAdoptedRightsRecipe,
  candidateWitnesses: readonly MergeFileWitness[],
): CapturedAdoptedRightsWitnessNormalizationResult {
  try {
    verifyRecipe(recipe);
    return { ok: true, witnesses: translateCandidateWitnesses(recipe, candidateWitnesses) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function translateCandidateWitnesses(
  recipe: CapturedAdoptedRightsRecipe,
  candidateWitnesses: readonly MergeFileWitness[],
): MergeFileWitness[] {
  const logicalSides = [
    { logicalHash: hash(recipe.initialLogicalTarget), physical: sideWitness(recipe.targetRights) },
    { logicalHash: hash(recipe.initialLogicalSource), physical: sideWitness(recipe.sourceRights) },
  ];
  const translated = candidateWitnesses.map((witness) => {
    assertCandidateWitnessShape(witness);
    const matchingSides = logicalSides.filter((side) => side.physical.sourceId === witness.sourceId
      && sameCapturedPath(side.physical.relativePath, witness.relativePath));
    if (matchingSides.length === 0) { return normalizedCandidateWitness(witness); }
    if (matchingSides.length !== 1) {
      throw new Error(`Logical Rights witness ${witness.sourceId}:${witness.relativePath} matches multiple captured sides.`);
    }

    const match = matchingSides[0]!;
    const physical = match.physical;
    const isExactLogical = (witness.kind ?? 'file') === 'file'
      && normalizeHash(witness.expectedHash) === match.logicalHash;
    if (isExactLogical) { return cloneWitness(physical); }
    if (sameWitness(physical, normalizedCandidateWitness(witness))) { return cloneWitness(physical); }
    throw new Error(`Rights witness ${witness.sourceId}:${witness.relativePath} is neither the exact initial logical snapshot nor its captured physical file/missing witness.`);
  });
  return dedupeCandidateWitnesses(translated);
}

function assertCandidateWitnessShape(witness: MergeFileWitness): void {
  if (!witness || typeof witness.sourceId !== 'string' || !witness.sourceId.trim()
      || typeof witness.relativePath !== 'string' || !isSafeRelativePath(witness.relativePath)) {
    throw new Error('Candidate Rights witness должен иметь sourceId и безопасный relativePath.');
  }
  const kind = witness.kind ?? 'file';
  if (kind !== 'file' && kind !== 'directory') {
    throw new Error('Candidate Rights witness имеет unsupported kind.');
  }
  if (witness.expectedHash === MISSING_TARGET_HASH) {
    if (kind !== 'file') { throw new Error('Missing Rights witness должен иметь kind=file.'); }
    return;
  }
  if (!/^(?:sha256:)?[\da-f]{64}$/iu.test(witness.expectedHash)) {
    throw new Error('Candidate Rights witness должен содержать SHA-256 либо __missing__.');
  }
}

function normalizedCandidateWitness(witness: MergeFileWitness): MergeFileWitness {
  return { ...witness, kind: witness.kind ?? 'file' };
}

function dedupeCandidateWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    assertCandidateWitnessShape(witness);
    const normalized = normalizedCandidateWitness(witness);
    const key = `${normalized.sourceId}\0${normalizeCapturedPath(normalized.relativePath)}\0${normalized.kind}`;
    const existing = byKey.get(key);
    if (existing && normalizeHash(existing.expectedHash) !== normalizeHash(normalized.expectedHash)) {
      throw new Error(`Conflicting raw witnesses for ${normalized.sourceId}:${normalized.relativePath}; hashes cannot be replaced.`);
    }
    if (!existing) { byKey.set(key, normalized); }
  }
  return [...byKey.values()].map(cloneWitness);
}

function sameCapturedPath(left: string, right: string): boolean {
  return normalizeCapturedPath(left) === normalizeCapturedPath(right);
}

function normalizeCapturedPath(value: string): string {
  const normalized = normalizePath(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function verifyCapturedInputs(input: CapturedAdoptedRightsProjectionInput): void {
  if (!isSupportedDirection(input.direction)) { throw new Error('Направление adopted Rights bridge не поддерживается.'); }
  if (typeof input.formatVersion !== 'string' || input.formatVersion.trim() !== input.formatVersion
      || !SUPPORTED_RIGHTS_VERSIONS.has(input.formatVersion)) {
    throw new Error('Не указана точная поддерживаемая версия Rights.xml.');
  }
  verifyCapture(input.targetDescriptor, 'target Role descriptor');
  verifyCapture(input.sourceDescriptor, 'source Role descriptor');
  verifyCapture(input.baseDescriptor, 'own base Role descriptor');
  verifyCapture(input.baseRights, 'own base Rights.xml');

  const targetParsed = parsedDescriptorIdentity(input.targetDescriptor, input.formatVersion);
  const sourceParsed = parsedDescriptorIdentity(input.sourceDescriptor, input.formatVersion);
  const baseParsed = parsedDescriptorIdentity(input.baseDescriptor, input.formatVersion);
  assertIdentityPair(input.targetDescriptor.identity, targetParsed, 'target Role descriptor');
  assertIdentityPair(input.sourceDescriptor.identity, sourceParsed, 'source Role descriptor');
  assertIdentityPair(input.baseDescriptor.identity, baseParsed, 'base Role descriptor');
  assertDirectionIdentities(input.direction, input.targetDescriptor.identity, input.sourceDescriptor.identity, input.baseDescriptor.identity);
  assertSameIdentity(input.baseRights.identity, input.baseDescriptor.identity, 'base Rights.xml');

  assertDescriptorSource(input.targetDescriptor, input.targetRights, 'target');
  assertDescriptorSource(input.sourceDescriptor, input.sourceRights, 'source');
  assertDescriptorSource(input.baseDescriptor, { kind: 'file', capture: input.baseRights }, 'base');
  if (input.targetRights.kind === 'file') {
    verifyCapture(input.targetRights.capture, 'target Rights.xml');
    assertSameIdentity(input.targetRights.capture.identity, input.targetDescriptor.identity, 'target Rights.xml');
  }
  if (input.sourceRights.kind === 'file') {
    verifyCapture(input.sourceRights.capture, 'source Rights.xml');
    assertSameIdentity(input.sourceRights.capture.identity, input.sourceDescriptor.identity, 'source Rights.xml');
  }

  const baseRightsState = rightsPropertyState(input.baseDescriptor.content, input.baseDescriptor.witness.relativePath, input.formatVersion);
  if (baseRightsState !== undefined) { throw new Error('Собственный base Role descriptor содержит unsupported Rights PropertyState.'); }
  assertAdoptedStateMatchesFile(input.targetDescriptor, input.targetRights, 'target', input.formatVersion);
  assertAdoptedStateMatchesFile(input.sourceDescriptor, input.sourceRights, 'source', input.formatVersion);

  const requiredWitnesses = [
    input.targetDescriptor.witness,
    input.sourceDescriptor.witness,
    input.baseDescriptor.witness,
    input.baseRights.witness,
    ...input.configurationWitnesses,
    ...(input.additionalBaseWitnesses ?? []),
  ];
  for (const witness of requiredWitnesses) { assertWitnessShape(witness, 'captured adopted Rights dependency', false); }
  assertWitnessShape(sideWitness(input.targetRights), 'target Rights capture', input.targetRights.kind === 'missing');
  assertWitnessShape(sideWitness(input.sourceRights), 'source Rights capture', input.sourceRights.kind === 'missing');
  assertMatchingBaseRightsWitness(input.baseRights, input.additionalBaseWitnesses ?? []);
  dedupeWitnesses([...requiredWitnesses, sideWitness(input.targetRights), sideWitness(input.sourceRights)]);
}

function verifyRecipe(recipe: CapturedAdoptedRightsRecipe): void {
  if (!recipe || recipe.kind !== 'adopted-rights' || !isSupportedDirection(recipe.direction)) {
    throw new Error('Captured adopted Rights recipe отсутствует или имеет неизвестный discriminator.');
  }
  if (typeof recipe.formatVersion !== 'string' || !SUPPORTED_RIGHTS_VERSIONS.has(recipe.formatVersion)) {
    throw new Error('Captured adopted Rights recipe содержит неподдерживаемую версию формата.');
  }
  verifyCapture(recipe.targetDescriptor, 'target Role descriptor');
  verifyCapture(recipe.sourceDescriptor, 'source Role descriptor');
  verifyCapture(recipe.baseDescriptor, 'own base Role descriptor');
  verifyCapture(recipe.baseRights, 'own base Rights.xml');
  if (recipe.targetRights.kind === 'file') { verifyCapture(recipe.targetRights.capture, 'target Rights.xml'); }
  else { assertWitnessShape(recipe.targetRights.witness, 'target missing Rights.xml', true); }
  if (recipe.sourceRights.kind === 'file') { verifyCapture(recipe.sourceRights.capture, 'source Rights.xml'); }
  else { assertWitnessShape(recipe.sourceRights.witness, 'source missing Rights.xml', true); }
  if (!Buffer.isBuffer(recipe.initialLogicalTarget) || !Buffer.isBuffer(recipe.initialLogicalSource)) {
    throw new Error('Captured adopted Rights recipe не содержит исходную logical пару Buffer.');
  }
  for (const witness of [...recipe.configurationWitnesses, ...recipe.additionalBaseWitnesses]) {
    assertWitnessShape(witness, 'captured adopted Rights recipe dependency', false);
  }
  for (const witness of recipe.requiredWitnesses) { assertWitnessShape(witness, 'captured adopted Rights recipe witness', true); }
  const expectedRequired = [
    recipe.targetDescriptor.witness,
    recipe.sourceDescriptor.witness,
    recipe.baseDescriptor.witness,
    recipe.baseRights.witness,
    sideWitness(recipe.targetRights),
    sideWitness(recipe.sourceRights),
    ...recipe.configurationWitnesses,
    ...recipe.additionalBaseWitnesses,
  ];
  const expectedWitnesses = dedupeWitnesses(expectedRequired);
  const capturedWitnesses = dedupeWitnesses(recipe.requiredWitnesses);
  if (expectedWitnesses.length !== capturedWitnesses.length
      || expectedWitnesses.some((expected) => !capturedWitnesses.some((actual) => sameWitness(expected, actual)))) {
    throw new Error('Captured adopted Rights recipe required witnesses не совпадают с raw captures и dependencies.');
  }
  if (recipe.targetDescriptor.witness.relativePath !== recipe.targetDescriptorRelativePath
      || sideRelativePath(recipe.targetRights) !== recipe.targetRightsRelativePath
      || sideRelativePath(recipe.sourceRights) !== recipe.sourceRightsRelativePath) {
    throw new Error('Captured adopted Rights recipe paths do not match its immutable raw captures.');
  }
  const targetParsed = parsedDescriptorIdentity(recipe.targetDescriptor, recipe.formatVersion);
  const sourceParsed = parsedDescriptorIdentity(recipe.sourceDescriptor, recipe.formatVersion);
  const baseParsed = parsedDescriptorIdentity(recipe.baseDescriptor, recipe.formatVersion);
  assertIdentityPair(recipe.targetDescriptor.identity, targetParsed, 'target Role descriptor');
  assertIdentityPair(recipe.sourceDescriptor.identity, sourceParsed, 'source Role descriptor');
  assertIdentityPair(recipe.baseDescriptor.identity, baseParsed, 'own base Role descriptor');
  assertDirectionIdentities(recipe.direction, recipe.targetDescriptor.identity, recipe.sourceDescriptor.identity, recipe.baseDescriptor.identity);
  assertSameIdentity(recipe.baseRights.identity, recipe.baseDescriptor.identity, 'base Rights.xml');
  assertDescriptorSource(recipe.targetDescriptor, recipe.targetRights, 'target');
  assertDescriptorSource(recipe.sourceDescriptor, recipe.sourceRights, 'source');
  assertDescriptorSource(recipe.baseDescriptor, { kind: 'file', capture: recipe.baseRights }, 'base');
  if (recipe.targetRights.kind === 'file') { assertSameIdentity(recipe.targetRights.capture.identity, recipe.targetDescriptor.identity, 'target Rights.xml'); }
  if (recipe.sourceRights.kind === 'file') { assertSameIdentity(recipe.sourceRights.capture.identity, recipe.sourceDescriptor.identity, 'source Rights.xml'); }
  assertMatchingBaseRightsWitness(recipe.baseRights, recipe.additionalBaseWitnesses);
  assertAdoptedStateMatchesFile(recipe.targetDescriptor, recipe.targetRights, 'target', recipe.formatVersion);
  assertAdoptedStateMatchesFile(recipe.sourceDescriptor, recipe.sourceRights, 'source', recipe.formatVersion);
  const projection = projectAdoptedDesignerRightsPair({
    direction: recipe.direction,
    formatVersion: recipe.formatVersion,
    baseRightsXml: recipe.baseRights.content,
    ...(recipe.targetRights.kind === 'file' ? { targetRightsXml: recipe.targetRights.capture.content } : {}),
    ...(recipe.sourceRights.kind === 'file' ? { sourceRightsXml: recipe.sourceRights.capture.content } : {}),
  });
  if (!projection.ok || !projection.targetXml.equals(recipe.initialLogicalTarget) || !projection.sourceXml.equals(recipe.initialLogicalSource)) {
    throw new Error('Captured adopted Rights initial logical pair отличается от повторной проекции raw captures.');
  }
}

function verifyCapture(capture: AdoptedSemanticArtifactCapture, label: string): void {
  if (!capture || !Buffer.isBuffer(capture.content)) { throw new Error(`Captured ${label} не содержит физических bytes.`); }
  assertWitnessShape(capture.witness, label, false);
  if (hash(capture.content) !== normalizeHash(capture.witness.expectedHash)) {
    throw new Error(`Raw ${label} не совпадает с captured SHA-256 witness.`);
  }
  assertIdentityShape(capture.identity, label);
}

function parsedDescriptorIdentity(capture: AdoptedSemanticArtifactCapture, formatVersion: string): AdoptedDesignerIdentity {
  return parseRoleDescriptor(capture.content, capture.witness.relativePath, formatVersion).identity;
}

function parseRoleDescriptor(
  xml: Buffer,
  relativePath: string,
  formatVersion: string,
): { readonly identity: AdoptedDesignerIdentity; readonly role: ReturnType<typeof parseXmlDocument>['root'] } {
  const document = parseXmlDocument(xml.toString('utf8'));
  const meta = document.root;
  if (meta.localName !== 'MetaDataObject' || namespaceUriForName(meta) !== MD_CLASSES_NAMESPACE) {
    throw new Error(`Role descriptor ${relativePath} должен иметь MetaDataObject в namespace MDClasses.`);
  }
  const versions = meta.attributes.filter((attribute) => attribute.name === 'version');
  if (versions.length !== 1 || versions[0]!.value !== formatVersion) {
    throw new Error(`Версия Role descriptor ${relativePath} не совпадает с captured Designer formatVersion.`);
  }
  const roleNodes = elementChildren(meta).filter((element) => element.localName === 'Role');
  if (roleNodes.length !== 1 || namespaceUriForName(roleNodes[0]!) !== MD_CLASSES_NAMESPACE) {
    throw new Error(`Role descriptor ${relativePath} должен содержать один Role в namespace MDClasses.`);
  }
  const role = roleNodes[0]!;
  const uuids = role.attributes.filter((attribute) => attribute.name === 'uuid');
  if (uuids.length !== 1 || !isUuid(uuids[0]!.value)) {
    throw new Error(`Role descriptor ${relativePath} должен содержать один точный UUID Role.`);
  }
  const properties = uniqueMetadataChild(role, 'Properties', `Role descriptor ${relativePath} должен содержать один Properties в namespace MDClasses.`);
  const name = requiredMetadataText(properties, 'Name', `Role descriptor ${relativePath} должен содержать однозначное имя Role.`);
  const belonging = optionalMetadataText(properties, 'ObjectBelonging');
  const sourceUuid = optionalMetadataText(properties, 'ExtendedConfigurationObject');
  if (belonging === undefined && sourceUuid === undefined) {
    return { role, identity: { ownership: 'own', type: 'Role', name, uuid: uuids[0]!.value } };
  }
  if (belonging !== 'Adopted' || !sourceUuid || !isUuid(sourceUuid)) {
    throw new Error(`Role descriptor ${relativePath} содержит неполные adopted ownership markers.`);
  }
  return {
    role,
    identity: { ownership: 'adopted', type: 'Role', name, uuid: uuids[0]!.value, sourceUuid },
  };
}

function uniqueMetadataChild(parent: ReturnType<typeof parseXmlDocument>['root'], name: string, error: string): ReturnType<typeof parseXmlDocument>['root'] {
  const matches = elementChildren(parent).filter((element) => element.localName === name);
  if (matches.length !== 1 || namespaceUriForName(matches[0]!) !== MD_CLASSES_NAMESPACE) { throw new Error(error); }
  return matches[0]!;
}

function requiredMetadataText(parent: ReturnType<typeof parseXmlDocument>['root'], name: string, error: string): string {
  const value = optionalMetadataText(parent, name);
  if (!value) { throw new Error(error); }
  return value;
}

function optionalMetadataText(parent: ReturnType<typeof parseXmlDocument>['root'], name: string): string | undefined {
  const matches = elementChildren(parent).filter((element) => element.localName === name);
  if (matches.length > 1 || matches.length === 1 && namespaceUriForName(matches[0]!) !== MD_CLASSES_NAMESPACE) {
    throw new Error(`Role descriptor содержит неоднозначный или foreign ${name}.`);
  }
  return matches.length === 1 ? textContent(matches[0]!).trim() : undefined;
}

function assertMatchingBaseRightsWitness(
  baseRights: AdoptedSemanticArtifactCapture,
  additionalBaseWitnesses: readonly MergeFileWitness[],
): void {
  for (const witness of additionalBaseWitnesses) {
    if (normalizePath(witness.relativePath) === normalizePath(baseRights.witness.relativePath)
        && normalizeHash(witness.expectedHash) !== normalizeHash(baseRights.witness.expectedHash)) {
      throw new Error('Два purported common base Rights.xml captures имеют разные raw hashes.');
    }
  }
}

function assertIdentityPair(provided: AdoptedDesignerIdentity, parsed: AdoptedDesignerIdentity, label: string): void {
  assertIdentityShape(provided, label);
  if (provided.ownership !== parsed.ownership || provided.type !== parsed.type || provided.name !== parsed.name
      || normalizeUuid(provided.uuid) !== normalizeUuid(parsed.uuid)
      || normalizeOptionalUuid(provided.sourceUuid) !== normalizeOptionalUuid(parsed.sourceUuid)) {
    throw new Error(`Capture identity ${label} не совпадает с физическим descriptor XML.`);
  }
}

function assertIdentityShape(identity: AdoptedDesignerIdentity, label: string): void {
  if (!identity || (identity.ownership !== 'own' && identity.ownership !== 'adopted')
      || identity.type !== 'Role' || !identity.name.trim() || !isUuid(identity.uuid)
      || identity.ownership === 'adopted' && !isUuid(identity.sourceUuid ?? '')
      || identity.ownership === 'own' && identity.sourceUuid !== undefined) {
    throw new Error(`Identity ${label} не является полной Role own/adopted identity.`);
  }
}

function assertDirectionIdentities(
  direction: AdoptedDesignerDirection,
  target: AdoptedDesignerIdentity,
  source: AdoptedDesignerIdentity,
  base: AdoptedDesignerIdentity,
): void {
  const targetAdopted = direction !== 'adopted-to-cf';
  const sourceAdopted = direction !== 'cf-to-adopted';
  if (base.ownership !== 'own' || target.ownership !== (targetAdopted ? 'adopted' : 'own')
      || source.ownership !== (sourceAdopted ? 'adopted' : 'own')
      || target.type !== base.type || source.type !== base.type || target.name !== base.name || source.name !== base.name
      || (targetAdopted ? !sameUuid(target.sourceUuid, base.uuid) : !sameUuid(target.uuid, base.uuid))
      || (sourceAdopted ? !sameUuid(source.sourceUuid, base.uuid) : !sameUuid(source.uuid, base.uuid))) {
    throw new Error('Rights bridge требует точные Role own/adopted identities поверх одной captured own base.');
  }
}

function assertSameIdentity(left: AdoptedDesignerIdentity, right: AdoptedDesignerIdentity, label: string): void {
  if (left.ownership !== right.ownership || left.type !== right.type || left.name !== right.name
      || !sameUuid(left.uuid, right.uuid) || normalizeOptionalUuid(left.sourceUuid) !== normalizeOptionalUuid(right.sourceUuid)) {
    throw new Error(`Identity ${label} не совпадает с exact descriptor identity.`);
  }
}

function assertDescriptorSource(
  descriptor: AdoptedSemanticArtifactCapture,
  side: CapturedAdoptedRightsSide,
  label: string,
): void {
  const witness = sideWitness(side);
  if (witness.sourceId !== descriptor.witness.sourceId) {
    throw new Error(`${label} Rights witness относится к другому physical root, чем Role descriptor.`);
  }
  if (!isSafeRelativePath(witness.relativePath)) { throw new Error(`${label} Rights witness path небезопасен.`); }
  const descriptorPath = normalizePath(descriptor.witness.relativePath);
  if (!descriptorPath.toLowerCase().endsWith('.xml')) { throw new Error(`${label} Role descriptor path должен оканчиваться на .xml.`); }
  const roleDirectory = descriptorPath.slice(0, -4);
  const allowedRightsPaths = [`${roleDirectory}/Rights.xml`, `${roleDirectory}/Ext/Rights.xml`]
    .map((relativePath) => relativePath.toLowerCase());
  if (!allowedRightsPaths.includes(normalizePath(witness.relativePath).toLowerCase())) {
    throw new Error(`${label} Rights witness не принадлежит каталогу captured Role descriptor.`);
  }
}

function assertAdoptedStateMatchesFile(
  descriptor: AdoptedSemanticArtifactCapture,
  side: CapturedAdoptedRightsSide,
  label: string,
  formatVersion: string,
): void {
  const state = rightsPropertyState(descriptor.content, descriptor.witness.relativePath, formatVersion);
  if (descriptor.identity.ownership !== 'adopted') {
    if (state !== undefined) { throw new Error(`${label} own Role descriptor содержит неприменимый Rights Extended state.`); }
    return;
  }
  if (side.kind === 'file' && state !== 'Extended') {
    throw new Error(`${label} adopted Rights.xml присутствует без однозначного Rights=Extended PropertyState.`);
  }
  if (side.kind === 'missing' && state !== undefined) {
    throw new Error(`${label} adopted Role содержит Rights PropertyState при witnessed missing Rights.xml.`);
  }
}

function rightsPropertyState(xml: Buffer, relativePath: string, formatVersion: string): string | undefined {
  const { role } = parseRoleDescriptor(xml, relativePath, formatVersion);
  const internalInfos = elementChildren(role).filter((element) => element.localName === 'InternalInfo'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  if (internalInfos.length > 1) { throw new Error('Role descriptor содержит повторяющиеся InternalInfo; Rights state неоднозначен.'); }
  if (internalInfos.length === 0) { return undefined; }
  const propertyStates = elementChildren(internalInfos[0]!).filter((element) => element.localName === 'PropertyState');
  const rightsStates: string[] = [];
  for (const propertyState of propertyStates) {
    if (namespaceUriForName(propertyState) !== RIGHTS_STATE_NAMESPACE) {
      throw new Error('PropertyState в Role descriptor находится в unsupported namespace.');
    }
    const properties = elementChildren(propertyState).filter((element) => element.localName === 'Property');
    const states = elementChildren(propertyState).filter((element) => element.localName === 'State');
    if (properties.length !== 1 || states.length !== 1
        || namespaceUriForName(properties[0]!) !== RIGHTS_STATE_NAMESPACE
        || namespaceUriForName(states[0]!) !== RIGHTS_STATE_NAMESPACE) {
      throw new Error('PropertyState в Role descriptor malformed; Rights state нельзя подтвердить.');
    }
    const propertyName = textContent(properties[0]!).trim();
    const stateName = textContent(states[0]!).trim();
    if (!propertyName || !stateName) { throw new Error('PropertyState в Role descriptor содержит пустые Property или State.'); }
    if (propertyName === 'Rights') { rightsStates.push(stateName); }
  }
  if (rightsStates.length > 1) { throw new Error('Rights PropertyState повторяется в Role descriptor.'); }
  return rightsStates[0];
}

function assertWitnessShape(witness: MergeFileWitness, label: string, allowMissing: boolean): void {
  if (!witness || typeof witness.sourceId !== 'string' || !witness.sourceId.trim()
      || typeof witness.relativePath !== 'string' || !isSafeRelativePath(witness.relativePath)
      || witness.kind !== undefined && witness.kind !== 'file') {
    throw new Error(`Witness ${label} должен описывать файл по безопасному относительному пути.`);
  }
  if (allowMissing && witness.expectedHash === MISSING_TARGET_HASH) {
    if (witness.kind !== 'file') { throw new Error(`Missing witness ${label} должен иметь kind=file.`); }
    return;
  }
  if (!/^(?:sha256:)?[\da-f]{64}$/iu.test(witness.expectedHash)) {
    throw new Error(`Witness ${label} должен содержать SHA-256${allowMissing ? ' либо __missing__' : ''}.`);
  }
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    assertWitnessShape(witness, 'captured adopted Rights dependency', true);
    const key = `${witness.sourceId}\0${normalizeCapturedPath(witness.relativePath)}\0${witness.kind ?? 'file'}`;
    const existing = byKey.get(key);
    if (existing && normalizeHash(existing.expectedHash) !== normalizeHash(witness.expectedHash)) {
      throw new Error(`Conflicting raw witnesses for ${witness.sourceId}:${witness.relativePath}; hashes cannot be replaced.`);
    }
    if (!existing) { byKey.set(key, cloneWitness(witness)); }
  }
  return [...byKey.values()];
}

function sameWitness(left: MergeFileWitness, right: MergeFileWitness): boolean {
  return left.sourceId === right.sourceId
    && sameCapturedPath(left.relativePath, right.relativePath)
    && (left.kind ?? 'file') === (right.kind ?? 'file')
    && normalizeHash(left.expectedHash) === normalizeHash(right.expectedHash);
}

function sideWitness(side: CapturedAdoptedRightsSide): MergeFileWitness {
  return side.kind === 'file' ? side.capture.witness : side.witness;
}

function sideRelativePath(side: CapturedAdoptedRightsSide): string { return sideWitness(side).relativePath; }

function cloneSide(side: CapturedAdoptedRightsSide): CapturedAdoptedRightsSide {
  return side.kind === 'file'
    ? { kind: 'file', capture: cloneCapture(side.capture) }
    : { kind: 'missing', witness: cloneWitness(side.witness) };
}

function cloneCapture(capture: AdoptedSemanticArtifactCapture): AdoptedSemanticArtifactCapture {
  return { content: Buffer.from(capture.content), witness: cloneWitness(capture.witness), identity: { ...capture.identity } };
}

function cloneWitness(witness: MergeFileWitness): MergeFileWitness { return { ...witness }; }
function cloneIssues(issues: readonly RoleRightsProjectionIssue[]): RoleRightsProjectionIssue[] { return issues.map((issue) => ({ ...issue })); }
function hash(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex'); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function normalizePath(value: string): string { return value.replace(/\\/gu, '/'); }
function normalizeUuid(value: string): string { return value.toLowerCase(); }
function normalizeOptionalUuid(value: string | undefined): string | undefined { return value ? normalizeUuid(value) : undefined; }
function sameUuid(left: string | undefined, right: string | undefined): boolean { return Boolean(left && right && normalizeUuid(left) === normalizeUuid(right)); }
function isUuid(value: string): boolean {
  return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value)
    && normalizeUuid(value) !== ZERO_UUID;
}
function isSupportedDirection(value: unknown): value is AdoptedDesignerDirection {
  return value === 'adopted-to-cf' || value === 'cf-to-adopted' || value === 'adopted-to-adopted';
}
function isSafeRelativePath(value: string): boolean {
  const normalized = normalizePath(value);
  return Boolean(normalized) && !normalized.startsWith('/') && !/^[a-z]:/iu.test(normalized)
    && !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
