import { createHash } from 'crypto';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type { AdapterCompareInput, ArtifactUnit, XmlPatchPayload } from '../mergeAdapter';
import type { SemanticXmlKind } from './semanticXmlValidator';

export function buildXmlSourceWitnesses(
  input: AdapterCompareInput,
  paths: { left?: string; right?: string },
  kind: SemanticXmlKind,
  referencedMetadataNames: readonly string[] = []
): {
  sourceWitnesses: NonNullable<XmlPatchPayload['sourceWitnesses']>;
  semanticContext: XmlPatchPayload['semanticContext'];
} {
  const witnesses = new Map<string, NonNullable<XmlPatchPayload['sourceWitnesses']>[number]>();
  const add = (witness: NonNullable<XmlPatchPayload['sourceWitnesses']>[number] | undefined) => {
    if (witness) {
      witnesses.set(witness.sourceId + '\u0000' + witness.relativePath, witness);
    }
  };
  add(snapshotWitness(input, 'right', paths.right, input.snapshots.right));
  add(snapshotWitness(input, 'left', paths.left, input.snapshots.left));
  for (const witness of input.semanticContextWitnesses ?? []) {
    add(witness);
  }

  const referenced = new Set(referencedMetadataNames.map((name) => name.trim().normalize('NFC').toLocaleLowerCase('en-US')));
  for (const dependency of input.semanticMetadataReferenceWitnesses ?? []) {
    const key = dependency.qualifiedName.trim().normalize('NFC').toLocaleLowerCase('en-US');
    if (referenced.has(key)) {
      add(dependency.witness);
    }
  }
  if (kind === 'metadataXml' || kind === 'formXml') {
    const availableMetadataReferences = input.semanticValidationContext?.availableMetadataReferences;
    const registered = availableMetadataReferences && new Set(availableMetadataReferences.map((name) =>
      name.trim().normalize('NFC').toLocaleLowerCase('en-US')
    ));
    for (const object of input.leftInventory.objects) {
      const referenceKey = object.qualifiedName.trim().normalize('NFC').toLocaleLowerCase('en-US');
      if (referenced.has(referenceKey) && registered?.has(referenceKey)) {
        const artifact = (input.leftInventory.artifactsByObjectId.get(object.objectId) ?? [])
          .find((candidate) => candidate.kind === 'metadataXml' && samePath(candidate.filePath, object.descriptorPath));
        const witness = artifact ? artifactWitness(input, artifact) : undefined;
        add(witness);
      }
    }
  }

  return {
    sourceWitnesses: [...witnesses.values()],
    semanticContext: input.semanticValidationContext,
  };
}

function snapshotWitness(
  input: AdapterCompareInput,
  side: 'left' | 'right',
  filePath: string | undefined,
  content: string
): NonNullable<XmlPatchPayload['sourceWitnesses']>[number] | undefined {
  if (!filePath) {
    return undefined;
  }
  const inventory = side === 'left' ? input.leftInventory : input.rightInventory;
  const relativePath = canonicalRelativePath(inventory.rootPath, filePath);
  return relativePath ? {
    sourceId: sourceId(input, side),
    relativePath,
    expectedHash: rawTextHash(content),
    kind: 'file',
  } : undefined;
}

function artifactWitness(
  input: AdapterCompareInput,
  artifact: ArtifactUnit
): NonNullable<XmlPatchPayload['sourceWitnesses']>[number] | undefined {
  const relativePath = canonicalRelativePath(input.leftInventory.rootPath, artifact.filePath);
  if (!relativePath) {
    return undefined;
  }
  const expectedHash = artifact.contentHash.startsWith('sha256:')
    ? artifact.contentHash.slice('sha256:'.length)
    : artifact.contentHash;
  return /^[\da-f]{64}$/u.test(expectedHash)
    ? { sourceId: sourceId(input, 'left'), relativePath, expectedHash, kind: 'file' }
    : undefined;
}

function canonicalRelativePath(rootPath: string, filePath: string): string | undefined {
  const relativePath = path.relative(localFilePath(rootPath), localFilePath(filePath)).replace(/\\/g, '/');
  return !relativePath || relativePath === '.' || relativePath === '..' ||
    relativePath.startsWith('../') || path.isAbsolute(relativePath)
    ? undefined
    : relativePath;
}

function sourceId(input: AdapterCompareInput, side: 'left' | 'right'): string {
  return input.session.state.sources.find((source) => source.side === side)?.sourceId ??
    (side === 'left' ? 'left-source' : 'right-source');
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(localFilePath(value)).replace(/\\/g, '/');
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function localFilePath(value: string): string {
  return value.startsWith('file:') ? fileURLToPath(value) : value;
}

function rawTextHash(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}
