import type { ExtensionTransferRow } from './extensionTransfer';
import type { MergeFileWitness } from '../merge/mergePreview';

export interface ExtensionOutputWrite {
  readonly relativePath: string;
  readonly content: Buffer;
  readonly sourceWitnesses: readonly MergeFileWitness[];
}

export interface ExtensionObjectOutput {
  readonly row: ExtensionTransferRow;
  readonly outputRelativePaths: readonly string[];
  readonly writes: readonly ExtensionOutputWrite[];
  readonly deletePaths: readonly string[];
  readonly addRegistration?: import('../../services/configurationXmlUpdater').RootObjectConfigurationMutation;
  readonly effectiveDescriptorRelativePath?: string;
  readonly effectiveDescriptorContent?: Buffer;
  readonly effectiveDescriptorWitnesses?: readonly MergeFileWitness[];
}
