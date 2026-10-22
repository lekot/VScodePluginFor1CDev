import { getConfigurationMutationEngine } from '../../services/configurationSession/ConfigurationMutationEngine';
import { hashContent } from '../../services/configurationSession/atomicFileStorage';
import { unwrapMutationReceipt } from '../../services/configurationSession/mutationReceiptError';
import { xmlBuilder } from './xmlCore';

export function buildXmlString(data: unknown): string {
  return xmlBuilder.build(data);
}

/** Compatibility adapter for snapshot writes; all filesystem effects belong to the mutation engine. */
export async function writeUtf8FileWithBackup(
  filePath: string,
  originalContent: string | undefined,
  newContent: string,
): Promise<void> {
  const receipt = await getConfigurationMutationEngine().transformFile(
    filePath,
    {
      kind: 'xml.snapshot.write',
      resourcePath: filePath,
      expectedRevision: originalContent === undefined ? null : hashContent(originalContent),
    },
    () => ({ content: newContent, result: undefined }),
  );
  unwrapMutationReceipt(receipt, `Unable to write XML file: ${filePath}`);
}
