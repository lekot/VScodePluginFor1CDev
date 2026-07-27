import { createHash } from 'crypto';
import * as path from 'path';
import type { ConfigurationId } from '../services/configurationSession/types';
import type {
  EnableObjectRulesRequest,
  GlobalEditability,
  MasterSupportSnapshot,
  MasterSupportState,
  MetadataUniverseSnapshot,
  ObjectSupportMode,
  ObjectSupportSource,
  ObjectSupportState,
  SupplierSupportState,
  SupportMutationRequest,
} from './supportTypes';
import { SupportMutationError } from './supportTypes';

export interface ParentConfigurationsParseContext {
  readonly configurationId: ConfigurationId;
  readonly filePath: string;
  readonly configRoot?: string;
}

export interface TokenRange {
  readonly start: number;
  readonly end: number;
}

export interface SupportTokenPatch extends TokenRange {
  readonly before: '0' | '1' | '2';
  readonly after: '0' | '1' | '2';
  readonly kind: 'global' | 'supplierBlock' | 'objectMode';
  readonly objectId?: string;
}

interface ObjectRecord {
  readonly mode: ObjectSupportMode;
  readonly modeToken: ScalarToken;
  readonly secondaryFlag: string;
  readonly localUuid: string;
  readonly vendorUuid: string;
}

interface SupplierRecord {
  readonly supplierConfigurationId: string;
  readonly blockEditability: GlobalEditability;
  readonly blockToken: ScalarToken;
  readonly parentConfigurationId: string;
  readonly version: string;
  readonly vendor: string;
  readonly name: string;
  readonly objects: readonly ObjectRecord[];
  readonly footer: readonly [ScalarToken, ScalarToken];
}

interface ScalarToken extends TokenRange {
  readonly value: string;
}

interface ParsedModel {
  readonly globalToken: ScalarToken;
  readonly suppliers: readonly SupplierRecord[];
  readonly tail: readonly ScalarToken[];
}

export class ParsedParentConfigurations {
  constructor(
    bytes: Uint8Array,
    readonly context: ParentConfigurationsParseContext,
    readonly state: MasterSupportState,
    readonly model?: ParsedModel,
  ) {
    this.sourceBytes = Buffer.from(bytes);
  }

  private readonly sourceBytes: Buffer;

  get bytes(): Uint8Array {
    return Buffer.from(this.sourceBytes);
  }
}

export interface SupportTokenPatchPlan {
  readonly kind: 'support.setObjectMode' | 'support.enableObjectRules';
  readonly configRoot: string;
  readonly before: MasterSupportSnapshot;
  readonly after: MasterSupportSnapshot;
  readonly afterDocument: ParsedParentConfigurations;
  readonly patches: readonly SupportTokenPatch[];
  readonly targetObjectId: string;
  readonly expectedMetadataUniverseGenerationId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODE_FROM_TOKEN: Readonly<Record<string, ObjectSupportMode>> = {
  '0': 'notEditable',
  '1': 'editableWithSupport',
  '2': 'removedFromSupport',
};
const TOKEN_FROM_MODE: Readonly<Record<ObjectSupportMode, '0' | '1' | '2'>> = {
  notEditable: '0',
  editableWithSupport: '1',
  removedFromSupport: '2',
};

export class ParentConfigurationsCodec {
  static parse(bytes: Uint8Array, context: ParentConfigurationsParseContext): ParsedParentConfigurations {
    const source = Buffer.from(bytes);
    const generationId = hash(source);
    try {
      const tokens = tokenize(source);
      const model = parseRevision6(tokens);
      const snapshot = buildSnapshot(context, model, generationId);
      return new ParsedParentConfigurations(source, context, { kind: 'ready', snapshot }, model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unsupported = message.startsWith('Unsupported ParentConfigurations revision');
      return new ParsedParentConfigurations(source, context, {
        kind: 'unknown',
        configurationId: context.configurationId,
        filePath: context.filePath,
        generationId,
        errorCode: unsupported ? 'SUPPORT_FORMAT_UNSUPPORTED' : 'SUPPORT_FILE_INVALID',
        diagnostics: [message],
      });
    }
  }

  static planObjectMode(
    document: ParsedParentConfigurations,
    request: SupportMutationRequest,
  ): SupportTokenPatchPlan {
    const { snapshot, model } = requireReady(document);
    assertRequestIdentity(snapshot, request.configurationId, request.expectedGenerationId);
    if (snapshot.globalEditability === 'disabled') {
      throw new SupportMutationError(
        'SUPPORT_GLOBAL_EDITING_DISABLED',
        'Object rules are hidden by the global support lock.',
      );
    }
    const objectId = normalizeUuid(request.objectId);
    const patches: SupportTokenPatch[] = [];
    for (const supplier of model.suppliers) {
      for (const object of supplier.objects) {
        if (object.localUuid !== objectId) { continue; }
        addPatch(patches, object.modeToken, TOKEN_FROM_MODE[request.targetMode], 'objectMode', objectId);
      }
    }
    if (!hasObject(model, objectId)) {
      throw new SupportMutationError('SUPPORT_OBJECT_NOT_FOUND', `Support rule not found for UUID ${objectId}.`);
    }
    return finishPlan(document, patches, 'support.setObjectMode', objectId);
  }

  static planEnableObjectRules(
    document: ParsedParentConfigurations,
    request: EnableObjectRulesRequest,
    universe: MetadataUniverseSnapshot,
  ): SupportTokenPatchPlan {
    const { snapshot, model } = requireReady(document);
    assertRequestIdentity(snapshot, request.configurationId, request.expectedGenerationId);
    if (snapshot.formatRevision !== '6') {
      throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', 'Only revision 6 is certified for object rules.');
    }
    if (universe.metadataUniverseGenerationId !== request.expectedMetadataUniverseGenerationId) {
      throw new SupportMutationError('SUPPORT_METADATA_UNIVERSE_STALE', 'Metadata universe generation is stale.');
    }
    if (snapshot.globalEditability !== 'disabled') {
      throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', 'Global object rules are already enabled.');
    }
    const targetId = normalizeUuid(request.targetObjectId);
    const knownSubjects = new Set<string>();
    for (const supplier of model.suppliers) {
      for (const object of supplier.objects) { knownSubjects.add(object.localUuid); }
    }
    if (!knownSubjects.has(targetId)) {
      throw new SupportMutationError('SUPPORT_OBJECT_NOT_FOUND', `Support rule not found for UUID ${targetId}.`);
    }
    const missing = universe.entries.find((entry) => !knownSubjects.has(entry.supportSubjectUuid.toLowerCase()));
    if (missing) {
      throw new SupportMutationError(
        'SUPPORT_OBJECT_UNIVERSE_INCOMPLETE',
        `No patchable support rule for ${missing.relativeMetadataPath} (${missing.supportSubjectUuid}).`,
      );
    }

    const patches: SupportTokenPatch[] = [];
    addPatch(patches, model.globalToken, '0', 'global');
    for (const supplier of model.suppliers) {
      addPatch(patches, supplier.blockToken, '0', 'supplierBlock');
      for (const object of supplier.objects) {
        const desired = object.localUuid === targetId ? TOKEN_FROM_MODE[request.targetMode] : '0';
        addPatch(patches, object.modeToken, desired, 'objectMode', object.localUuid);
      }
    }
    const plan = finishPlan(document, patches, 'support.enableObjectRules', targetId, universe.metadataUniverseGenerationId);
    for (const entry of universe.entries) {
      if (entry.supportSubjectUuid.toLowerCase() === targetId) { continue; }
      if (!plan.after.objectModes.get(entry.supportSubjectUuid.toLowerCase())?.locked) {
        throw new SupportMutationError(
          'SUPPORT_OBJECT_UNIVERSE_INCOMPLETE',
          `Object would become editable: ${entry.relativeMetadataPath}.`,
        );
      }
    }
    return plan;
  }
}

function tokenize(bytes: Buffer): ScalarToken[] {
  if (bytes.length === 0) { throw new Error('ParentConfigurations is empty.'); }
  let cursor = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  if (bytes[cursor] !== 0x7b) { throw new Error('ParentConfigurations opening brace is missing.'); }
  cursor += 1;
  const tokens: ScalarToken[] = [];
  let start = cursor;
  let quoted = false;
  for (; cursor < bytes.length; cursor += 1) {
    const byte = bytes[cursor]!;
    if (byte === 0x22) {
      if (quoted && bytes[cursor + 1] === 0x22) { cursor += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (!quoted && (byte === 0x2c || byte === 0x7d)) {
      let significantStart = start;
      while (significantStart < cursor && isWhitespace(bytes[significantStart]!)) { significantStart += 1; }
      let significantEnd = cursor;
      while (significantEnd > significantStart && isWhitespace(bytes[significantEnd - 1]!)) { significantEnd -= 1; }
      tokens.push({
        start: significantStart,
        end: significantEnd,
        value: bytes.subarray(significantStart, significantEnd).toString('utf8'),
      });
      if (byte === 0x7d) {
        cursor += 1;
        while (cursor < bytes.length && isWhitespace(bytes[cursor]!)) { cursor += 1; }
        if (cursor !== bytes.length) { throw new Error('Unexpected bytes after ParentConfigurations closing brace.'); }
        return tokens;
      }
      start = cursor + 1;
    }
  }
  throw new Error('ParentConfigurations closing brace is missing.');
}

function parseRevision6(tokens: readonly ScalarToken[]): ParsedModel {
  if (tokens.length < 3) { throw new Error('ParentConfigurations header is truncated.'); }
  if (tokens[0]!.value !== '6') { throw new Error(`Unsupported ParentConfigurations revision: ${tokens[0]!.value}.`); }
  const globalToken = tokens[1]!;
  parseEditability(globalToken.value, 'global flag');
  const supplierCount = parseCount(tokens[2]!, 'supplier count');
  let cursor = 3;
  const suppliers: SupplierRecord[] = [];
  const supplierIds = new Set<string>();
  for (let supplierIndex = 0; supplierIndex < supplierCount; supplierIndex += 1) {
    if (cursor + 7 > tokens.length) { throw new Error(`Supplier block ${supplierIndex} is truncated.`); }
    const supplierId = parseUuid(tokens[cursor++]!, 'supplier configuration UUID');
    if (supplierIds.has(supplierId)) {
      throw new Error(`Duplicate supplier configuration UUID: ${supplierId}.`);
    }
    supplierIds.add(supplierId);
    const blockToken = tokens[cursor++]!;
    const blockEditability = parseEditability(blockToken.value, 'supplier block flag');
    const parentId = parseUuid(tokens[cursor++]!, 'parent configuration UUID');
    const version = parseString(tokens[cursor++]!);
    const vendor = parseString(tokens[cursor++]!);
    const name = parseString(tokens[cursor++]!);
    const objectCount = parseCount(tokens[cursor++]!, 'object count');
    const objects: ObjectRecord[] = [];
    const localObjectIds = new Set<string>();
    const vendorObjectIds = new Set<string>();
    for (let objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
      if (cursor + 4 > tokens.length) { throw new Error(`Object tuple ${objectIndex} is truncated.`); }
      const modeToken = tokens[cursor++]!;
      const mode = MODE_FROM_TOKEN[modeToken.value];
      if (!mode) { throw new Error(`Unknown object support mode: ${modeToken.value}.`); }
      const secondaryFlag = tokens[cursor++]!.value;
      if (secondaryFlag !== '0') { throw new Error(`Unknown secondary object flag: ${secondaryFlag}.`); }
      const localUuid = parseUuid(tokens[cursor++]!, 'local object UUID');
      const vendorUuid = parseUuid(tokens[cursor++]!, 'vendor object UUID');
      if (localObjectIds.has(localUuid)) {
        throw new Error(`Duplicate local object UUID ${localUuid} in supplier ${supplierId}.`);
      }
      if (vendorObjectIds.has(vendorUuid)) {
        throw new Error(`Duplicate vendor object UUID ${vendorUuid} in supplier ${supplierId}.`);
      }
      localObjectIds.add(localUuid);
      vendorObjectIds.add(vendorUuid);
      objects.push({ mode, modeToken, secondaryFlag, localUuid, vendorUuid });
    }
    if (cursor + 2 > tokens.length) { throw new Error(`Supplier block ${supplierIndex} footer is truncated.`); }
    const footer: readonly [ScalarToken, ScalarToken] = [tokens[cursor++]!, tokens[cursor++]!];
    if (footer.some((token) => token.value !== '0' && token.value !== '1')) {
      throw new Error(`Unknown supplier footer in block ${supplierIndex}.`);
    }
    suppliers.push({
      supplierConfigurationId: supplierId,
      blockEditability,
      blockToken,
      parentConfigurationId: parentId,
      version,
      vendor,
      name,
      objects,
      footer,
    });
  }
  const tail = tokens.slice(cursor);
  if (tail.length !== 13 || tail.some((token) => token.value !== '0' && token.value !== '1')) {
    throw new Error(`Unsupported revision 6 tail (${tail.length} tokens).`);
  }
  return { globalToken, suppliers, tail };
}

function buildSnapshot(
  context: ParentConfigurationsParseContext,
  model: ParsedModel,
  generationId: string,
): MasterSupportSnapshot {
  const globalEditability = parseEditability(model.globalToken.value, 'global flag');
  const sourceMap = new Map<string, ObjectSupportSource[]>();
  for (const supplier of model.suppliers) {
    for (const object of supplier.objects) {
      const sources = sourceMap.get(object.localUuid) ?? [];
      sources.push({ supplierConfigurationId: supplier.supplierConfigurationId, rawMode: object.mode });
      sourceMap.set(object.localUuid, sources);
    }
  }
  const objectModes = new Map<string, ObjectSupportState>();
  for (const [objectId, sources] of sourceMap) {
    const relevantSuppliers = model.suppliers.filter((supplier) =>
      supplier.objects.some((object) => object.localUuid === objectId));
    const locked = globalEditability === 'disabled'
      || relevantSuppliers.some((supplier) => supplier.blockEditability === 'disabled')
      || sources.some((source) => source.rawMode === 'notEditable');
    const effectiveMode: ObjectSupportMode = locked
      ? 'notEditable'
      : sources.some((source) => source.rawMode === 'editableWithSupport')
        ? 'editableWithSupport'
        : 'removedFromSupport';
    objectModes.set(objectId, { objectId, locked, effectiveMode, sources: [...sources] });
  }
  const values = [...objectModes.values()];
  const lockedCount = values.filter((value) => value.locked).length;
  const configurationMode = lockedCount === values.length ? 'locked' : lockedCount === 0 ? 'editable' : 'mixed';
  const supplierConfigurations: SupplierSupportState[] = model.suppliers.map((supplier) => ({
    supplierConfigurationId: supplier.supplierConfigurationId,
    name: supplier.name,
    vendor: supplier.vendor,
    version: supplier.version,
    blockEditability: supplier.blockEditability,
  }));
  return {
    configurationId: context.configurationId,
    generationId,
    semanticDigest: semanticDigest(model),
    filePath: context.filePath,
    formatRevision: '6',
    globalEditability,
    configurationMode,
    objectModes,
    supplierConfigurations,
  };
}

function finishPlan(
  document: ParsedParentConfigurations,
  patches: readonly SupportTokenPatch[],
  kind: SupportTokenPatchPlan['kind'],
  targetObjectId: string,
  expectedMetadataUniverseGenerationId?: string,
): SupportTokenPatchPlan {
  const { snapshot } = requireReady(document);
  const beforeBytes = Buffer.from(document.bytes);
  const afterBytes = Buffer.from(beforeBytes);
  for (const patch of patches) {
    if (patch.end - patch.start !== 1 || afterBytes[patch.start] !== patch.before.charCodeAt(0)) {
      throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', `Invalid token patch at byte ${patch.start}.`);
    }
    afterBytes[patch.start] = patch.after.charCodeAt(0);
  }
  const afterDocument = ParentConfigurationsCodec.parse(afterBytes, document.context);
  if (afterDocument.state.kind !== 'ready') {
    const diagnostic = afterDocument.state.kind === 'unknown'
      ? afterDocument.state.diagnostics.join(' ')
      : `Unexpected support state: ${afterDocument.state.reason}.`;
    throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', diagnostic);
  }
  validateByteDiff(beforeBytes, afterBytes, patches);
  if (kind === 'support.setObjectMode') {
    validateOnlyTargetChanged(snapshot, afterDocument.state.snapshot, targetObjectId);
  }
  return {
    kind,
    configRoot: document.context.configRoot ?? path.dirname(path.dirname(document.context.filePath)),
    before: snapshot,
    after: afterDocument.state.snapshot,
    afterDocument,
    patches: [...patches],
    targetObjectId,
    expectedMetadataUniverseGenerationId,
  };
}

function requireReady(document: ParsedParentConfigurations): { snapshot: MasterSupportSnapshot; model: ParsedModel } {
  if (document.state.kind !== 'ready' || !document.model) {
    throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', 'Support master is not writable.');
  }
  return { snapshot: document.state.snapshot, model: document.model };
}

function assertRequestIdentity(
  snapshot: MasterSupportSnapshot,
  configurationId: ConfigurationId,
  expectedGenerationId: string,
): void {
  if (snapshot.configurationId !== configurationId) {
    throw new SupportMutationError('SUPPORT_STALE_GENERATION', 'Configuration identity does not match support master.');
  }
  if (snapshot.generationId !== expectedGenerationId) {
    throw new SupportMutationError('SUPPORT_STALE_GENERATION', 'Support master generation is stale.');
  }
}

function addPatch(
  patches: SupportTokenPatch[],
  token: ScalarToken,
  after: '0' | '1' | '2',
  kind: SupportTokenPatch['kind'],
  objectId?: string,
): void {
  if (token.value === after) { return; }
  if (token.value !== '0' && token.value !== '1' && token.value !== '2') {
    throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', `Unpatchable token: ${token.value}.`);
  }
  patches.push({ start: token.start, end: token.end, before: token.value, after, kind, objectId });
}

function validateByteDiff(before: Buffer, after: Buffer, patches: readonly SupportTokenPatch[]): void {
  if (before.length !== after.length) {
    throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', 'Token patch changed file length.');
  }
  const allowed = new Set(patches.map((patch) => patch.start));
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index] && !allowed.has(index)) {
      throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', `Unexpected byte diff at ${index}.`);
    }
  }
}

function validateOnlyTargetChanged(
  before: MasterSupportSnapshot,
  after: MasterSupportSnapshot,
  targetObjectId: string,
): void {
  if (before.objectModes.size !== after.objectModes.size) {
    throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', 'Object support map size changed.');
  }
  for (const [objectId, beforeState] of before.objectModes) {
    if (objectId === targetObjectId) { continue; }
    const afterState = after.objectModes.get(objectId);
    if (!afterState || JSON.stringify(beforeState) !== JSON.stringify(afterState)) {
      throw new SupportMutationError('SUPPORT_EFFECTIVE_DIFF_VIOLATION', `Non-target support state changed: ${objectId}.`);
    }
  }
}

function semanticDigest(model: ParsedModel): string {
  const canonical = {
    global: model.globalToken.value,
    suppliers: model.suppliers.map((supplier) => ({
      supplierConfigurationId: supplier.supplierConfigurationId,
      block: supplier.blockToken.value,
      parentConfigurationId: supplier.parentConfigurationId,
      version: supplier.version,
      vendor: supplier.vendor,
      name: supplier.name,
      objects: supplier.objects.map((object) => [
        TOKEN_FROM_MODE[object.mode], object.secondaryFlag, object.localUuid, object.vendorUuid,
      ]),
      footer: supplier.footer.map((token) => token.value),
    })),
    tail: model.tail.map((token) => token.value),
  };
  return hash(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function parseEditability(value: string, field: string): GlobalEditability {
  if (value === '0') { return 'enabled'; }
  if (value === '1') { return 'disabled'; }
  throw new Error(`Unknown ${field}: ${value}.`);
}

function parseCount(token: ScalarToken, field: string): number {
  if (!/^\d+$/.test(token.value)) { throw new Error(`Invalid ${field}: ${token.value}.`); }
  const count = Number(token.value);
  if (!Number.isSafeInteger(count)) { throw new Error(`Unsafe ${field}: ${token.value}.`); }
  return count;
}

function parseUuid(token: ScalarToken, field: string): string {
  if (!UUID.test(token.value)) { throw new Error(`Invalid ${field}: ${token.value}.`); }
  return token.value.toLowerCase();
}

function normalizeUuid(value: string): string {
  if (!UUID.test(value)) { throw new SupportMutationError('SUPPORT_OBJECT_NOT_FOUND', `Invalid object UUID: ${value}.`); }
  return value.toLowerCase();
}

function parseString(token: ScalarToken): string {
  if (token.value.startsWith('"') && token.value.endsWith('"')) {
    return token.value.slice(1, -1).replace(/""/g, '"');
  }
  return token.value;
}

function hasObject(model: ParsedModel, objectId: string): boolean {
  return model.suppliers.some((supplier) => supplier.objects.some((object) => object.localUuid === objectId));
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
