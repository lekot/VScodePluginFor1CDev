import { createHash } from 'crypto';
import * as path from 'path';
import { METADATA_TYPE_DESCRIPTORS } from '../constants/metadataTypeDescriptors';
import { MetadataType, type TreeNode } from '../models/treeNode';
import { MetadataParser } from '../parsers/metadataParser';
import type { MetadataUniverseEntry, MetadataUniverseSnapshot } from './supportTypes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONCRETE_OBJECT_TYPES = new Set(METADATA_TYPE_DESCRIPTORS.map((descriptor) => descriptor.type));
const OWNER_FALLBACK_TYPES = new Set<MetadataType>([
  MetadataType.Attribute,
  MetadataType.TabularSection,
  MetadataType.Form,
  MetadataType.Template,
  MetadataType.CommandSubElement,
  MetadataType.Recurrence,
  MetadataType.Method,
  MetadataType.Parameter,
  MetadataType.EnumValue,
  MetadataType.Dimension,
  MetadataType.Resource,
  MetadataType.PredefinedItem,
]);
const STRUCTURAL_IDS = new Set([
  'Attributes',
  'TabularSections',
  'Forms',
  'Commands',
  'Templates',
  'Dimensions',
  'Resources',
  'EnumValues',
  'PredefinedData',
  'Ext',
]);

export interface MetadataUniverseResolverDeps {
  /** Must return the complete, non-filtered metadata tree for this configuration. */
  readonly loadTree?: (configRoot: string) => Promise<TreeNode>;
}

/** Builds a support universe from typed tree identities, never from arbitrary XML UUID attributes. */
export class MetadataUniverseResolver {
  constructor(private readonly deps: MetadataUniverseResolverDeps = {}) {}

  async resolve(configRoot: string): Promise<MetadataUniverseSnapshot> {
    const root = path.resolve(configRoot);
    const tree = await (this.deps.loadTree ?? MetadataParser.parse.bind(MetadataParser))(root);
    if (tree.type !== MetadataType.Configuration) {
      throw new Error('Metadata universe is incomplete: tree root is not a configuration.');
    }

    const entries: MetadataUniverseEntry[] = [];
    const keys = new Set<string>();
    const ownObjectPaths = new Map<string, string>();
    this.visit(tree, root, entries, keys, ownObjectPaths);

    entries.sort(compareEntry);
    const canonical = entries
      .map((entry) => `${entry.relativeMetadataPath}\0${entry.objectUuid}\0${entry.supportSubjectUuid}`)
      .join('\n');
    return {
      configRoot: root,
      metadataUniverseGenerationId: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      entries,
    };
  }

  private visit(
    node: TreeNode,
    configRoot: string,
    entries: MetadataUniverseEntry[],
    keys: Set<string>,
    ownObjectPaths: Map<string, string>,
  ): void {
    if (node.properties._lazy === true) {
      throw new Error(`Metadata universe is incomplete: lazy node ${node.id}.`);
    }

    const entry = resolveMetadataUniverseEntry(configRoot, node);
    const ownUuid = parseNodeUuid(node.properties.uuid);
    if (entry !== undefined && ownUuid !== undefined) {
      const duplicatePath = ownObjectPaths.get(ownUuid);
      if (duplicatePath !== undefined) {
        throw new Error(
          `Metadata universe contains duplicate object UUID ${ownUuid}: `
          + `${duplicatePath} and ${entry.relativeMetadataPath}.`,
        );
      }
      ownObjectPaths.set(ownUuid, entry.relativeMetadataPath);
    }

    if (entry !== undefined) {
      const key = `${entry.relativeMetadataPath}\0${entry.objectUuid}\0${entry.supportSubjectUuid}`;
      if (keys.has(key)) {
        throw new Error(`Metadata universe contains a duplicate node identity: ${entry.relativeMetadataPath}.`);
      }
      keys.add(key);
      entries.push(entry);
    }

    for (const child of node.children ?? []) {
      if (child.parent !== undefined && child.parent !== node) {
        throw new Error(`Metadata universe is incomplete: inconsistent parent for ${child.id}.`);
      }
      this.visit(child, configRoot, entries, keys, ownObjectPaths);
    }
  }
}

/**
 * Resolves the exact universe identity for one tree node.
 *
 * The helper is pure and is the single owner of path/type/UUID/owner-fallback semantics used by
 * universe construction and consumers that need to validate a node against a cached universe.
 */
export function resolveMetadataUniverseEntry(
  configRoot: string,
  node: TreeNode,
): MetadataUniverseEntry | undefined {
  const lineage: TreeNode[] = [];
  let current: TreeNode | undefined = node;
  while (current) {
    lineage.unshift(current);
    current = current.parent;
  }

  let ownerUuid: string | undefined;
  for (const candidate of lineage) {
    const ownUuid = parseNodeUuid(candidate.properties.uuid);
    const isStructural = structuralNode(candidate, ownUuid);
    const isRootConfiguration = candidate.parent === undefined
      && candidate.type === MetadataType.Configuration;
    const isTypedMetadataNode = !isStructural
      && (CONCRETE_OBJECT_TYPES.has(candidate.type) || OWNER_FALLBACK_TYPES.has(candidate.type));
    const isOwnedSyntheticNode = !isStructural
      && (candidate.properties.isModule === true || candidate.properties.isVirtual === true);

    if (CONCRETE_OBJECT_TYPES.has(candidate.type) && !isStructural && ownUuid === undefined) {
      throw new Error(`Metadata universe is incomplete: concrete node ${candidate.id} has no valid UUID.`);
    }

    let supportSubjectUuid: string | undefined;
    let objectUuid: string | undefined;
    if (isOwnedSyntheticNode) {
      if (ownUuid !== undefined) {
        throw new Error(
          `Metadata universe is ambiguous: synthetic node ${candidate.id} unexpectedly owns UUID ${ownUuid}.`,
        );
      }
      supportSubjectUuid = ownerUuid;
      if (!supportSubjectUuid) {
        throw new Error(`Metadata universe is incomplete: owner UUID for ${candidate.id} is unavailable.`);
      }
      objectUuid = supportSubjectUuid;
    } else if (isTypedMetadataNode && ownUuid !== undefined) {
      supportSubjectUuid = ownUuid;
      objectUuid = ownUuid;
    } else if (isTypedMetadataNode) {
      supportSubjectUuid = ownerUuid;
      if (!supportSubjectUuid) {
        throw new Error(`Metadata universe is incomplete: owner UUID for ${candidate.id} is unavailable.`);
      }
      objectUuid = supportSubjectUuid;
    } else if (!isRootConfiguration && !isStructural && ownUuid !== undefined) {
      throw new Error(
        `Metadata universe is ambiguous: unsupported node type ${candidate.type} owns UUID ${ownUuid}.`,
      );
    }

    if (candidate === node) {
      return supportSubjectUuid === undefined || isStructural
        ? undefined
        : {
            relativeMetadataPath: relativeNodePath(configRoot, candidate, ownUuid === undefined),
            objectUuid: objectUuid!,
            supportSubjectUuid,
          };
    }

    if ((isRootConfiguration || isTypedMetadataNode) && ownUuid !== undefined) {
      ownerUuid = ownUuid;
    }
  }
  return undefined;
}

function structuralNode(node: TreeNode, ownUuid: string | undefined): boolean {
  const isTypeFolder = node.parent?.type === MetadataType.Configuration
    && typeof node.properties.type === 'string'
    && node.id === node.properties.type;
  return isTypeFolder || STRUCTURAL_IDS.has(node.id)
    || (node.type === MetadataType.Extension && ownUuid === undefined);
}

function parseNodeUuid(value: unknown): string | undefined {
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    return undefined;
  }
  return value.trim().toLowerCase();
}

function relativeNodePath(configRoot: string, node: TreeNode, disambiguate: boolean): string {
  const sourcePath = node.filePath ?? node.parentFilePath;
  if (!sourcePath) {
    throw new Error(`Metadata universe is incomplete: node ${node.id} has no metadata path.`);
  }
  const relative = path.relative(configRoot, path.resolve(sourcePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Metadata universe node is outside the configuration root: ${sourcePath}.`);
  }
  const normalized = relative.replace(/\\/g, '/');
  return disambiguate || node.parentFilePath !== undefined ? `${normalized}#${node.id}` : normalized;
}

function compareEntry(left: MetadataUniverseEntry, right: MetadataUniverseEntry): number {
  return left.relativeMetadataPath.localeCompare(right.relativeMetadataPath)
    || left.objectUuid.localeCompare(right.objectUuid)
    || left.supportSubjectUuid.localeCompare(right.supportSubjectUuid);
}
