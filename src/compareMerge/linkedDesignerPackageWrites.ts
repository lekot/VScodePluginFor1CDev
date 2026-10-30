import * as path from 'path';
import { pathToFileURL } from 'url';

import { buildRootObjectConfigurationContent, type RootObjectConfigurationMutation } from '../services/configurationXmlUpdater';
import { captureMergePath, mergeSnapshotHash } from './merge/mergeSnapshot';
import { MISSING_TARGET_HASH, type MergeCandidate, type MergeFileWitness } from './merge/mergePreview';
import { rootRegistrationIsAvailable } from './linkedDesignerPackageIndex';
import { blocked, hashBuffer, uniqueWitnesses } from './linkedDesignerUtils';
import type { CompareMessage } from './domain/compareContracts';
import type { LinkedDesignerMaterializerContext, LinkedDesignerPackageRecipe } from './linkedDesignerTypes';

export async function materializePackageMembers(
  input: LinkedDesignerMaterializerContext,
  recipe: LinkedDesignerPackageRecipe,
): Promise<{ candidates: MergeCandidate[] } | { diagnostic: CompareMessage }> {
  const candidates: MergeCandidate[] = [];
  if (recipe.action === 'delete' && recipe.targetDirectoryWitness) {
    const witness = recipe.targetDirectoryWitness;
    const directoryPath = path.join(input.targetRootPath, ...witness.relativePath.split('/'));
    const directory = await captureMergePath(directoryPath, { retainContent: false }).catch(() => ({ state: 'missing' as const }));
    const actualHash = directory.state === 'directory' ? mergeSnapshotHash(directory) : undefined;
    if (actualHash !== witness.expectedHash) {
      return { diagnostic: blocked(`Каталог удаляемого Designer-пакета изменился после сравнения: ${witness.relativePath}`, input.targetSourceId, recipe.registrationNodeId) };
    }
  }
  for (const member of recipe.members) {
    const targetPath = path.join(input.targetRootPath, ...member.targetRelativePath.split('/'));
    const current = await captureMergePath(targetPath, { retainContent: false }).catch(() => ({ state: 'missing' as const }));
    const currentHash = current.state === 'missing' ? MISSING_TARGET_HASH : current.type === 'file' ? current.hash : undefined;
    if (currentHash !== member.expectedTargetHash) {
      return { diagnostic: blocked(`Целевой файл Designer-пакета изменился после сравнения: ${member.targetRelativePath}`, input.targetSourceId, recipe.registrationNodeId) };
    }
    if (recipe.action === 'delete') {
      if (current.state !== 'file') {
        return { diagnostic: blocked(`Удаление Designer-пакета не поддерживает каталог или отсутствующий файл: ${member.targetRelativePath}`, input.targetSourceId, recipe.registrationNodeId) };
      }
      candidates.push({
        kind: 'fileDelete',
        sourceId: input.sourceId,
        snapshotId: input.rightSnapshotId,
        nodeId: recipe.registrationNodeId ?? recipe.packageId,
        targetUri: pathToFileURL(targetPath).toString(),
        expectedOldHash: member.expectedTargetHash,
        fileOperation: { kind: 'fileDelete', targetPath: pathToFileURL(targetPath).toString(), expectedOldHash: member.expectedTargetHash, destructive: true },
      });
      continue;
    }
    if (!member.content || !member.sourceRelativePath || !member.sourceHash || hashBuffer(member.content) !== member.sourceHash) {
      return { diagnostic: blocked(`В source snapshot отсутствуют проверяемые байты Designer-файла: ${member.sourceRelativePath ?? member.targetRelativePath}`, input.sourceId, recipe.registrationNodeId) };
    }
    const write = await createCapturedWriteCandidate(input, {
      nodeId: recipe.registrationNodeId ?? recipe.packageId,
      targetRelativePath: member.targetRelativePath,
      expectedTargetHash: member.expectedTargetHash,
      sourceRelativePath: member.sourceRelativePath,
      sourceHash: member.sourceHash,
      content: member.content,
    });
    if ('diagnostic' in write) {return { diagnostic: write.diagnostic };}
    candidates.push(write);
  }
  return { candidates };
}

export async function materializeRootConfigurationWrite(
  input: LinkedDesignerMaterializerContext,
  mutations: readonly RootObjectConfigurationMutation[],
  recipes: readonly LinkedDesignerPackageRecipe[],
): Promise<{ candidate: MergeCandidate } | { diagnostic: CompareMessage }> {
  const snapshot = input.rootConfiguration;
  if (!snapshot || !snapshot.sourceHash || !snapshot.sourceContent) {
    return { diagnostic: blocked('Не удалось сохранить сравнимые версии Configuration.xml для linked registration.', input.sourceId) };
  }
  const targetPath = path.join(input.targetRootPath, 'Configuration.xml');
  const current = await captureMergePath(targetPath, { retainContent: true }).catch(() => ({ state: 'missing' as const }));
  if (current.state !== 'file' || current.hash !== snapshot.targetHash || !current.contentBase64) {
    return { diagnostic: blocked('Целевой Configuration.xml изменился после сравнения.', input.targetSourceId) };
  }
  const content = Buffer.from(current.contentBase64, 'base64');
  let next = content.toString('utf8');
  for (const mutation of mutations) {
    const recipe = recipes.find((candidate) => candidate.rootRegistration?.rootTag === mutation.rootTag && candidate.rootRegistration.objectName === mutation.objectName);
    if (!recipe || !rootRegistrationIsAvailable(recipe, snapshot)) {
      return { diagnostic: blocked(`Регистрация ${mutation.rootTag}.${mutation.objectName} не подтверждена обеими версиями Configuration.xml.`, input.sourceId, recipe?.registrationNodeId) };
    }
    try {
      next = buildRootObjectConfigurationContent(next, mutation);
    } catch (error) {
      return { diagnostic: blocked(error instanceof Error ? error.message : String(error), input.sourceId, recipe.registrationNodeId) };
    }
  }
  const sourceWitness: MergeFileWitness = {
    sourceId: input.sourceId,
    relativePath: 'Configuration.xml',
    expectedHash: snapshot.sourceHash,
    kind: 'file',
  };
  const candidate = await createCapturedOutputCandidate(input, {
    nodeId: recipes.find((recipe) => recipe.rootRegistration)?.registrationNodeId ?? recipes[0]?.packageId ?? 'linked-designer-root-registration',
    targetRelativePath: 'Configuration.xml',
    expectedTargetHash: snapshot.targetHash,
    content: Buffer.from(next, 'utf8'),
    witnesses: [sourceWitness, ...recipes.flatMap((recipe) => recipe.targetDirectoryWitness ? [recipe.targetDirectoryWitness] : [])],
  });
  return { candidate };
}

export async function createCapturedWriteCandidate(
  input: LinkedDesignerMaterializerContext,
  write: {
    readonly nodeId: string;
    readonly targetRelativePath: string;
    readonly expectedTargetHash: string;
    readonly sourceRelativePath: string;
    readonly sourceHash: string;
    readonly content: Buffer;
  },
): Promise<MergeCandidate | { diagnostic: CompareMessage }> {
  const targetPath = path.join(input.targetRootPath, ...write.targetRelativePath.split('/'));
  if (hashBuffer(write.content) !== write.sourceHash) {
    return { diagnostic: blocked(`Captured source bytes не совпадают с hash: ${write.sourceRelativePath}`, input.sourceId, write.nodeId) };
  }
  const sourceWitness: MergeFileWitness = {
    sourceId: input.sourceId,
    relativePath: write.sourceRelativePath,
    expectedHash: write.sourceHash,
    kind: 'file',
  };
  const contentBase64 = write.content.toString('base64');
  const newHash = hashBuffer(write.content);
  const targetUri = pathToFileURL(targetPath).toString();
  const candidate: MergeCandidate = {
    kind: 'fileWrite',
    sourceId: input.sourceId,
    snapshotId: input.rightSnapshotId,
    nodeId: write.nodeId,
    targetUri,
    expectedOldHash: write.expectedTargetHash,
    newHash,
    previewPath: write.targetRelativePath,
    previewEffect: write.expectedTargetHash === MISSING_TARGET_HASH ? 'create' : 'replace',
    fileWrite: {
      contentBase64,
      witnesses: [sourceWitness],
    },
  };
  return { ...candidate };
}

export async function createCapturedOutputCandidate(
  input: LinkedDesignerMaterializerContext,
  write: {
    readonly nodeId: string;
    readonly targetRelativePath: string;
    readonly expectedTargetHash: string;
    readonly content: Buffer;
    readonly witnesses: readonly MergeFileWitness[];
  },
): Promise<MergeCandidate> {
  const targetPath = path.join(input.targetRootPath, ...write.targetRelativePath.split('/'));
  const targetUri = pathToFileURL(targetPath).toString();
  const newHash = hashBuffer(write.content);
  return {
    kind: 'fileWrite',
    sourceId: input.sourceId,
    snapshotId: input.rightSnapshotId,
    nodeId: write.nodeId,
    targetUri,
    expectedOldHash: write.expectedTargetHash,
    newHash,
    previewPath: write.targetRelativePath,
    previewEffect: write.expectedTargetHash === MISSING_TARGET_HASH ? 'create' : 'replace',
    fileWrite: {
      contentBase64: write.content.toString('base64'),
      witnesses: uniqueWitnesses(write.witnesses),
    },
  };
}
