import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';

import type { CompareTreeNode } from '../compareTreeTypes';
import { MISSING_TARGET_HASH, type MergeCandidate } from '../merge/mergePreview';
import type {
  AdapterCompareInput,
  AdapterCompareResult,
  ArtifactUnit,
  ExecutableCandidateFactory,
  FileOperationPayload,
  MergeAdapter,
  MetadataObjectUnit,
} from './mergeAdapter';

interface PlannedFileMergeCandidate extends MergeCandidate {
  fileOperation: FileOperationPayload;
}

export const fileObjectAdapter: MergeAdapter = {
  kind: 'fileObject',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    const candidateFactories = new Map<string, ExecutableCandidateFactory>();
    const objectPresence = await compareObjectPresence(input, candidateFactories);
    const nodes = [
      objectPresence,
      ...compareFileArtifacts(input, candidateFactories),
    ].filter((node): node is CompareTreeNode => Boolean(node));
    return {
      nodes,
      candidateFactories,
      diagnostics: [],
    };
  },
};

async function compareObjectPresence(
  input: AdapterCompareInput,
  candidateFactories: Map<string, ExecutableCandidateFactory>
): Promise<CompareTreeNode | undefined> {
  if (
    input.match.right &&
    !input.match.left &&
    shouldShowStatus('rightOnly', input.strategy)
  ) {
    const sourcePath = await objectCopySourcePath(input.match.right);
    const sourceHash = await hashObjectSource(input.match.right, sourcePath);
    return objectOperationNode({
      input,
      object: input.match.right,
      status: 'rightOnly',
      destructive: false,
      operation: {
        kind: sourcePath === input.match.right.containerPath ? 'folderCopy' : 'fileCopy',
        sourcePath,
        targetPath: targetObjectPath(input, sourcePath),
        expectedOldHash: MISSING_TARGET_HASH,
        sourceHash,
        destructive: false,
      },
      candidateFactories,
    });
  }

  if (
    input.match.left &&
    !input.match.right &&
    shouldShowStatus('leftOnly', input.strategy)
  ) {
    const targetPath = await objectCopySourcePath(input.match.left);
    return objectOperationNode({
      input,
      object: input.match.left,
      status: 'leftOnly',
      destructive: true,
      operation: {
        kind: targetPath === input.match.left.containerPath ? 'folderDelete' : 'fileDelete',
        targetPath,
        expectedOldHash: await hashObjectSource(input.match.left, targetPath),
        destructive: true,
      },
      candidateFactories,
    });
  }

  return undefined;
}

function compareFileArtifacts(
  input: AdapterCompareInput,
  candidateFactories: Map<string, ExecutableCandidateFactory>
): CompareTreeNode[] {
  if (!input.match.left || !input.match.right) {
    return [];
  }

  const leftArtifacts = fileArtifactsFor(input.leftInventory, input.match.left);
  const rightArtifacts = fileArtifactsFor(input.rightInventory, input.match.right);
  const relativePaths = [...new Set([...leftArtifacts.keys(), ...rightArtifacts.keys()])].sort();
  const nodes: CompareTreeNode[] = [];

  for (const relativePath of relativePaths) {
    const left = leftArtifacts.get(relativePath);
    const right = rightArtifacts.get(relativePath);
    if (left?.kind === 'metadataXml' || right?.kind === 'metadataXml') {
      continue;
    }
    if (left && right && !isFileOperationArtifact(left, right)) {
      continue;
    }

    const status = !left ? 'rightOnly' : !right ? 'leftOnly' : left.contentHash === right.contentHash ? 'equal' : 'changed';
    if (status === 'equal' || !shouldShowStatus(status, input.strategy)) {
      continue;
    }

    const targetPath = left?.filePath ?? targetArtifactPath(input, relativePath);
    const operation: FileOperationPayload =
      status === 'leftOnly'
        ? {
            kind: 'fileDelete',
            targetPath,
            expectedOldHash: left ? mergeHash(left.contentHash) : undefined,
            destructive: true,
          }
        : {
            kind: 'fileCopy',
            sourcePath: right?.filePath,
            targetPath,
            expectedOldHash: left ? mergeHash(left.contentHash) : MISSING_TARGET_HASH,
            sourceHash: right ? mergeHash(right.contentHash) : undefined,
            destructive: false,
          };

    nodes.push(
      fileArtifactNode({
        input,
        relativePath,
        status,
        leftValue: left?.contentHash ?? '',
        rightValue: right?.contentHash ?? '',
        operation,
        candidateFactories,
      })
    );
  }

  return nodes;
}

function objectOperationNode(input: {
  input: AdapterCompareInput;
  object: MetadataObjectUnit;
  status: 'leftOnly' | 'rightOnly';
  destructive: boolean;
  operation: FileOperationPayload;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
}): CompareTreeNode {
  const nodeId = `fileObject:${input.status}:${encodeURIComponent(input.object.qualifiedName)}`;
  input.candidateFactories.set(nodeId, fileCandidateFactory(input.input, nodeId, input.operation));

  return {
    id: nodeId,
    label: input.object.qualifiedName,
    kind: 'metadataObject',
    status: input.status,
    leftValue: input.status === 'leftOnly' ? input.object.containerPath : '',
    rightValue: input.status === 'rightOnly' ? input.object.containerPath : '',
    mergeable: true,
    destructive: input.destructive,
    payloadRef: `fileOperation:${input.object.objectId}`,
    mergeState: {
      state: 'ready',
      targetFilePath: input.operation.targetPath,
    },
    children: [],
  };
}

function fileArtifactNode(input: {
  input: AdapterCompareInput;
  relativePath: string;
  status: 'changed' | 'leftOnly' | 'rightOnly';
  leftValue: string;
  rightValue: string;
  operation: FileOperationPayload;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
}): CompareTreeNode {
  const nodeId = `fileArtifact:${input.status}:${encodeURIComponent(input.relativePath)}`;
  input.candidateFactories.set(nodeId, fileCandidateFactory(input.input, nodeId, input.operation));

  return {
    id: nodeId,
    label: path.basename(input.relativePath),
    kind: 'fileArtifact',
    status: input.status,
    leftValue: input.leftValue,
    rightValue: input.rightValue,
    mergeable: true,
    destructive: input.operation.destructive,
    payloadRef: `fileOperation:${input.relativePath}`,
    mergeState: {
      state: 'ready',
      targetFilePath: input.operation.targetPath,
    },
    children: [],
  };
}

function fileCandidateFactory(
  input: AdapterCompareInput,
  nodeId: string,
  operation: FileOperationPayload
): ExecutableCandidateFactory {
  return async () => {
    const operationTargetUri = targetUri(operation.targetPath);
    const candidate: PlannedFileMergeCandidate = {
      kind: operation.kind,
      sourceId: rightSourceId(input),
      snapshotId: rightSnapshotId(input),
      nodeId,
      targetUri: operationTargetUri,
      expectedOldHash: operation.expectedOldHash,
      newHash: operation.sourceHash,
      fileOperation: {
        ...operation,
        targetPath: operationTargetUri,
      },
    };
    return { ok: true, candidate };
  };
}

function fileArtifactsFor(
  inventory: AdapterCompareInput['leftInventory'],
  object: MetadataObjectUnit
): Map<string, ArtifactUnit> {
  const artifacts = inventory.artifactsByObjectId.get(object.objectId) ?? [];
  return new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
}

function isFileOperationArtifact(left: ArtifactUnit, right: ArtifactUnit): boolean {
  return left.mergeMode === 'fileOperation' || right.mergeMode === 'fileOperation';
}

function targetArtifactPath(input: AdapterCompareInput, relativePath: string): string {
  return path.join(input.leftInventory.rootPath, relativePath);
}

function shouldShowStatus(
  status: 'changed' | 'leftOnly' | 'rightOnly',
  strategy: AdapterCompareInput['strategy']
): boolean {
  if (status === 'changed' || strategy === 'full') {
    return true;
  }
  return strategy === 'left' ? status === 'leftOnly' : status === 'rightOnly';
}

function targetObjectPath(
  input: AdapterCompareInput,
  sourcePath: string
): string {
  const relativePath = path.relative(input.rightInventory.rootPath, sourcePath);
  return path.join(input.leftInventory.rootPath, relativePath);
}

function rightSourceId(input: AdapterCompareInput): string {
  return input.session.state.sources.find((source) => source.side === 'right')?.sourceId ?? 'right-source';
}

function rightSnapshotId(input: AdapterCompareInput): string {
  const rightSource = input.session.state.sources.find((source) => source.side === 'right');
  return rightSource?.snapshotId ?? 'snapshot-right';
}

function targetUri(filePath: string): string {
  return path.isAbsolute(filePath) ? pathToFileURL(filePath).toString() : filePath;
}

function mergeHash(contentHash: string): string {
  return contentHash.startsWith('sha256:') ? contentHash.slice('sha256:'.length) : contentHash;
}

async function hashDirectory(directoryPath: string): Promise<string> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      parts.push(`dir:${entry.name}:${await hashDirectory(entryPath)}`);
    } else if (entry.isFile()) {
      parts.push(`file:${entry.name}:${await hashFileBytes(entryPath)}`);
    }
  }

  return hashText(parts.join('\n'));
}

async function hashFileBytes(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function objectCopySourcePath(object: MetadataObjectUnit): Promise<string> {
  return await directoryExists(object.containerPath) ? object.containerPath : object.descriptorPath;
}

async function hashObjectSource(object: MetadataObjectUnit, sourcePath: string): Promise<string> {
  return sourcePath === object.containerPath
    ? await hashDirectory(sourcePath)
    : await hashFileBytes(sourcePath);
}

async function directoryExists(folderPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(folderPath);
    return stat.isDirectory();
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
