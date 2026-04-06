import { TreeNode } from '../../src/models/treeNode';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { ConfigFormat, FormatDetector } from '../../src/parsers/formatDetector';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { initDesignerTemplateRepository } from '../../src/services/designerTemplateRepository';
import { normalizeEmptyPlaceholderTree } from '../../src/utils/treeNormalization';
import { getRepoRootFromCompiledTestFile } from './matrixTestPaths';

export { copyEmptyConfFixtureToTemp, getRepoRootFromCompiledTestFile } from './matrixTestPaths';

export interface DesignerMatrixContext {
  provider: MetadataTreeDataProvider;
  root: TreeNode;
  configPath: string;
}

/**
 * Builds the same in-memory tree chain as `extension.ts` (parse → detect → normalize) and attaches
 * a `MetadataTreeDataProvider` with Designer load context.
 */
export async function buildDesignerMatrixContext(workDir: string): Promise<DesignerMatrixContext> {
  const repoRoot = getRepoRootFromCompiledTestFile();
  initDesignerTemplateRepository(repoRoot);

  let root = await MetadataParser.parseStructureOnly(workDir);
  const format = await FormatDetector.detect(workDir);
  root = normalizeEmptyPlaceholderTree(root, { configPath: workDir, format });

  root.id = 'config:test-matrix';
  root.name = 'Configuration';

  const provider = new MetadataTreeDataProvider();
  provider.setRootNode(root, { configPath: workDir, format: ConfigFormat.Designer });

  return { provider, root, configPath: workDir };
}

/**
 * Depth-first preorder over the tree using the provider’s lazy-loading (`getChildren`).
 */
export async function dfsPreorderNodes(
  provider: MetadataTreeDataProvider,
  visit: (n: TreeNode) => void | Promise<void>
): Promise<void> {
  const roots = await provider.getChildren(undefined);
  const walk = async (node: TreeNode): Promise<void> => {
    await visit(node);
    const children = await provider.getChildren(node);
    for (const c of children) {
      await walk(c);
    }
  };
  for (const r of roots) {
    await walk(r);
  }
}
