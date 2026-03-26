import * as path from 'path';
import { ConfigFormat } from '../parsers/formatDetector';
import { TreeNode, MetadataType } from '../models/treeNode';
import { isRootObjectCreateInTypeFolder } from '../services/elementOperations';
import {
  ensureR6PlaceholdersForInstanceNode,
  isTabularSectionColumnsContainer,
} from '../utils/treeNormalization';
import { ExtensionState } from '../state/extensionState';

type OptimisticContext = { configPath: string; format: ConfigFormat };

/** Build a lightweight node so create operations can appear in the tree immediately. */
function buildOptimisticCreatedNode(
  target: TreeNode,
  name: string,
  ctx: OptimisticContext
): TreeNode {
  const trimmed = name.trim();
  if (isRootObjectCreateInTypeFolder(target)) {
    const targetDir =
      target.filePath ??
      (ctx.format === ConfigFormat.Designer
        ? path.join(ctx.configPath, target.id)
        : path.join(ctx.configPath, 'src', target.id));
    return {
      id: `${target.id}.${trimmed}`,
      name: trimmed,
      type: target.type,
      parent: target,
      properties: {},
      children: [],
      filePath: path.join(targetDir, `${trimmed}.xml`),
    };
  }

  if (isTabularSectionColumnsContainer(target)) {
    const section = target.parent;
    const parentXml =
      section?.filePath && section.filePath.toLowerCase().endsWith('.xml')
        ? section.filePath
        : section?.parentFilePath;
    return {
      id: section ? `${section.id}.${trimmed}` : `${target.id}.${trimmed}`,
      name: trimmed,
      type: MetadataType.Attribute,
      parent: target,
      properties: {
        Name: trimmed,
        Comment: '',
        Type: 'String(50)',
      },
      children: [],
      parentFilePath: parentXml,
    };
  }

  if (target.type === MetadataType.Attribute) {
    return {
      id: `${target.id}.Attribute.${trimmed}`,
      name: trimmed,
      type: MetadataType.Attribute,
      parent: target,
      properties: {
        Name: trimmed,
        Comment: '',
        Type: 'String(50)',
      },
      children: [],
      parentFilePath: target.parent?.filePath ?? target.parent?.parentFilePath,
    };
  }

  if (target.type === MetadataType.TabularSection) {
    return {
      id: `${target.id}.TabularSection.${trimmed}`,
      name: trimmed,
      type: MetadataType.TabularSection,
      parent: target,
      properties: {
        Name: trimmed,
        Comment: '',
      },
      children: [],
      parentFilePath: target.parent?.filePath ?? target.parent?.parentFilePath,
    };
  }

  if (target.type !== MetadataType.Configuration) {
    // Object-level create defaults to Attribute in elementOperations.
    return {
      id: `${target.id}.Attribute.${trimmed}`,
      name: trimmed,
      type: MetadataType.Attribute,
      parent: target,
      properties: {
        Name: trimmed,
        Comment: '',
        Type: 'String(50)',
      },
      children: [],
      parentFilePath: target.filePath ?? target.parentFilePath,
    };
  }

  return {
    id: `${target.id}.${trimmed}`,
    name: trimmed,
    type: MetadataType.Unknown,
    parent: target,
    properties: {},
    children: [],
  };
}

export async function optimisticAppendCreatedNode(
  state: ExtensionState,
  target: TreeNode,
  name: string,
  ctx: OptimisticContext
): Promise<void> {
  const provider = state.treeDataProvider;
  if (!provider) {return;}
  const activeTarget = provider.resolveNodeForUi(target);
  const trimmed = name.trim();
  const existing = (activeTarget.children || []).some((c) => c.name === trimmed);
  if (existing) {return;}

  if (!activeTarget.children) {activeTarget.children = [];}
  const created = buildOptimisticCreatedNode(activeTarget, trimmed, ctx);
  ensureR6PlaceholdersForInstanceNode(created, ctx);
  activeTarget.children.push(created);
  provider.refresh(activeTarget);
}
