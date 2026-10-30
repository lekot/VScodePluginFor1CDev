import * as path from 'path';
import { pathToFileURL } from 'url';

import type { CompareMessage } from '../domain/compareContracts';
import type { ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionRootPurposeSelection } from './extensionTransfer';
import type { MergeFileWitness, XmlPatchPayload } from '../merge/mergePreview';
import { applySelectedXmlPatches } from '../merge/semanticXmlMerge';
import { hashXmlText } from '../xml/xmlPatch';

const CONFIGURATION_XML = 'Configuration.xml';

export interface RootPurposeConfigurationOutput {
  readonly content: Buffer;
  readonly sourceWitnesses: readonly MergeFileWitness[];
}

export async function buildRootPurposeConfigurationOutput(input: {
  target: ExtensionMetadataIndex;
  incoming: ExtensionMetadataIndex;
  targetContent: Buffer;
  selectedAdditions: readonly string[];
  selection: ExtensionRootPurposeSelection;
}): Promise<RootPurposeConfigurationOutput | { diagnostic: CompareMessage }> {
  if (input.selection.targetHash !== input.target.configurationHash ||
      input.selection.sourceHash !== input.incoming.configurationHash ||
      !input.target.configurationHash || !input.incoming.configurationHash) {
    return { diagnostic: diagnostic('Configuration.xml изменился после сравнения назначения расширения.', input.incoming.sourceId, input.selection.nodeId) };
  }

  const result = await input.selection.candidateFactory();
  if (!result.ok) {
    return { diagnostic: diagnostic(result.diagnostics[0]?.suggestedAction ?? 'Изменение назначения больше недоступно.', input.incoming.sourceId, input.selection.nodeId) };
  }
  const candidate = result.candidate;
  const patch = candidate.xmlPatch;
  const targetRoot = input.target.canonicalRootPath ?? input.target.rootPath;
  const targetPath = path.join(targetRoot, CONFIGURATION_XML);
  const targetUri = pathToFileURL(targetPath).toString();
  if (!patch || patch.semanticKind !== 'metadataXml' || candidate.targetUri !== targetUri ||
      !isPurposePatch(patch) || patch.expectedOldHash !== hashXmlText(input.target.configurationContent?.toString('utf8') ?? '')) {
    return { diagnostic: diagnostic('Кандидат не ограничен свойством ConfigurationExtensionPurpose целевого Configuration.xml.', input.incoming.sourceId, input.selection.nodeId) };
  }

  const targetDescriptorWitnesses: MergeFileWitness[] = [];
  for (const object of input.target.objects) {
    if (object.descriptorRelativePath && object.descriptorHash) {
      targetDescriptorWitnesses.push({ sourceId: input.target.sourceId, relativePath: object.descriptorRelativePath, expectedHash: object.descriptorHash, kind: 'file' });
    }
  }
  const availableMetadataReferences = input.target.objects
    .filter((object) => object.descriptorRelativePath && object.descriptorHash)
    .map((object) => object.qualifiedName);
  const semanticContext = {
    ...patch.semanticContext,
    availableMetadataReferences: [...new Set([...availableMetadataReferences, ...input.selectedAdditions])],
  };
  const rebasedPurposePatch: XmlPatchPayload = {
    ...patch,
    expectedOldHash: hashXmlText(input.targetContent.toString('utf8')),
    semanticContext,
  };
  const patches: XmlPatchPayload[] = [rebasedPurposePatch];
  const applied = applySelectedXmlPatches(input.targetContent.toString('utf8'), patches);
  if (!applied.ok) {
    return { diagnostic: diagnostic(applied.message, input.target.sourceId, input.selection.nodeId) };
  }
  return {
    content: Buffer.from(applied.source, 'utf8'),
    sourceWitnesses: dedupeWitnesses([
      ...(patch.sourceWitnesses ?? []),
      { sourceId: input.target.sourceId, relativePath: CONFIGURATION_XML, expectedHash: input.target.configurationHash, kind: 'file' },
      { sourceId: input.incoming.sourceId, relativePath: CONFIGURATION_XML, expectedHash: input.incoming.configurationHash, kind: 'file' },
      ...targetDescriptorWitnesses,
    ]),
  };
}

function isPurposePatch(patch: XmlPatchPayload): boolean {
  return patch.target.pointer.split('/').some((segment) => {
    const encodedName = segment.slice(0, segment.indexOf('['));
    try {return decodeURIComponent(encodedName) === 'ConfigurationExtensionPurpose';}
    catch {return false;}
  });
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    byKey.set(`${witness.sourceId}\0${witness.relativePath}\0${witness.kind ?? 'file'}`, { ...witness });
  }
  return [...byKey.values()];
}

function diagnostic(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return {
    severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare',
    sourceId, nodeId, blocking: true, suggestedAction: message,
  };
}
