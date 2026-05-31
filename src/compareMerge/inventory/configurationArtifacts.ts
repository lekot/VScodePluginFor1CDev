import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export type ArtifactKind =
  | 'metadataXml'
  | 'formXml'
  | 'predefinedXml'
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
  const kind = classifyArtifactKind(input.filePath, input.descriptorPath);
  const relativePath = path.relative(input.rootPath, input.filePath);

  return {
    artifactId: `${input.ownerObjectId ?? 'unowned'}:${relativePath}`,
    ownerObjectId: input.ownerObjectId,
    kind,
    relativePath,
    filePath: input.filePath,
    contentHash: await hashFile(input.filePath),
    mergeMode: mergeModeForKind(kind),
  };
}

export function classifyArtifactKind(filePath: string, descriptorPath: string | undefined): ArtifactKind {
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

  return 'binaryOrOpaqueFile';
}

export function mergeModeForKind(kind: ArtifactKind): ArtifactMergeMode {
  switch (kind) {
    case 'metadataXml':
    case 'formXml':
    case 'predefinedXml':
      return 'xmlPatch';
    case 'bslModule':
      return 'bslRoutine';
    case 'objectFolder':
    case 'binaryOrOpaqueFile':
      return 'fileOperation';
  }
}

export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}
