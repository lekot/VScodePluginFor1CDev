import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { probeXmlRootExpandedName } from '../xml/xmlRootProbe';

export type ArtifactKind =
  | 'metadataXml'
  | 'formXml'
  | 'predefinedXml'
  | 'roleRightsXml'
  | 'dcsXml'
  | 'bslModule'
  | 'objectFolder'
  | 'binaryOrOpaqueFile';

export type ArtifactMergeMode = 'xmlPatch' | 'bslRoutine' | 'fileOperation';

export interface ArtifactUnit {
  artifactId: string;
  ownerObjectId?: string;
  kind: ArtifactKind;
  relativePath: string;
  filePath: string;
  contentHash: string;
  mergeMode: ArtifactMergeMode;
}

export interface CreateArtifactInput {
  rootPath: string;
  ownerObjectId?: string;
  filePath: string;
  descriptorPath?: string;
}

export async function createArtifactUnit(input: CreateArtifactInput): Promise<ArtifactUnit> {
  const rootProbe = !(input.descriptorPath && samePath(input.filePath, input.descriptorPath))
    && ['rights.xml', 'template.xml'].includes(path.basename(input.filePath).toLocaleLowerCase('en-US'));
  const { rootName, contentHash } = await hashFileWithRootProbe(input.filePath, rootProbe);
  const kind = classifyArtifactKind(input.filePath, input.descriptorPath, rootName);
  const relativePath = path.relative(input.rootPath, input.filePath);

  return {
    artifactId: `${input.ownerObjectId ?? 'unowned'}:${relativePath}`,
    ownerObjectId: input.ownerObjectId,
    kind,
    relativePath,
    filePath: input.filePath,
    contentHash,
    mergeMode: mergeModeForKind(kind),
  };
}

export function classifyArtifactKind(
  filePath: string,
  descriptorPath: string | undefined,
  rootExpandedName?: string,
): ArtifactKind {
  if (descriptorPath && samePath(filePath, descriptorPath)) {
    return 'metadataXml';
  }

  const extName = path.extname(filePath).toLowerCase();
  if (extName === '.bsl') {
    return 'bslModule';
  }

  const fileName = path.basename(filePath).toLowerCase();
  if (fileName === 'form.xml') {
    return 'formXml';
  }
  if (fileName === 'predefined.xml') {
    return 'predefinedXml';
  }
  if (fileName === 'rights.xml' && rootExpandedName === '{http://v8.1c.ru/8.2/roles}Rights') {
    return 'roleRightsXml';
  }
  if (fileName === 'template.xml'
    && rootExpandedName === '{http://v8.1c.ru/8.1/data-composition-system/schema}DataCompositionSchema') {
    return 'dcsXml';
  }

  return 'binaryOrOpaqueFile';
}

export function mergeModeForKind(kind: ArtifactKind): ArtifactMergeMode {
  switch (kind) {
    case 'metadataXml':
    case 'formXml':
    case 'predefinedXml':
    case 'roleRightsXml':
    case 'dcsXml':
      return 'xmlPatch';
    case 'bslModule':
      return 'bslRoutine';
    case 'objectFolder':
    case 'binaryOrOpaqueFile':
      return 'fileOperation';
  }
}

const ROOT_PROBE_LIMIT = 64 * 1024;

async function hashFileWithRootProbe(filePath: string, probeRoot: boolean): Promise<{ contentHash: string; rootName?: string }> {
  const file = await fs.open(filePath, 'r');
  const hash = createHash('sha256');
  try {
    const chunk = Buffer.alloc(ROOT_PROBE_LIMIT);
    let position = 0;
    let hasMoreBytes = true;
    let rootName: string | undefined;
    while (hasMoreBytes) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        hasMoreBytes = false;
        continue;
      }
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      if (probeRoot && position === 0) {
        rootName = probeXmlRootExpandedName(bytes.toString('utf8'));
      }
      position += bytesRead;
    }
    return { contentHash: `sha256:${hash.digest('hex')}`, ...(rootName ? { rootName } : {}) };
  } finally {
    await file.close();
  }
}

export async function hashFile(filePath: string): Promise<string> {
  return (await hashFileWithRootProbe(filePath, false)).contentHash;
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}
