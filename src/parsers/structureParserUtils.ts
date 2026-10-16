import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TreeNode, MetadataType } from '../models/treeNode';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';

/**
 * Creates the standard root TreeNode for structure-only metadata trees.
 */
export function createStructureRootNode(filePath: string): TreeNode {
  return {
    id: 'root',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: { bslLanguage: 'ru' },
    children: [],
    filePath,
  };
}

/**
 * Reads a configuration file, computes its SHA-256 digest, and returns the file buffer,
 * the hex digest, and the decoded UTF-8 string.
 * Ensures the digest and XML string are created from the exact same file read.
 */
export async function readConfigurationFileAndHash(filePath: string): Promise<{
  fileBytes: Buffer;
  contentHash: string;
  xmlString: string;
}> {
  await fs.promises.access(filePath);
  const fileBytes = await fs.promises.readFile(filePath);
  const contentHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
  const xmlString = fileBytes.toString('utf-8');
  return { fileBytes, contentHash, xmlString };
}

/**
 * Populates top-level metadata type directory container nodes for structure-only trees.
 */
export async function populateStructureTypeNodes(basePath: string, rootNode: TreeNode): Promise<void> {
  const metadataTypes = MetadataTypeMapper.getMetadataTypes();
  for (const typeName of metadataTypes) {
    const typePath = path.join(basePath, typeName);
    try {
      await fs.promises.access(typePath);
    } catch {
      continue;
    }
    const metadataType = MetadataTypeMapper.map(typeName);
    const typeNode: TreeNode = {
      id: typeName,
      name: typeName,
      type: metadataType,
      properties: { type: typeName },
      children: [],
      filePath: typePath,
    };
    typeNode.parent = rootNode;
    rootNode.children!.push(typeNode);
  }
}
