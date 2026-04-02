import * as vscode from 'vscode';
import { TreeNode, MetadataType } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { getExtensionRootNodes } from './extensionTypes';

/**
 * Returns all root Configuration nodes that are NOT extensions (main config nodes).
 */
function getMainConfigRoots(state: ExtensionState): TreeNode[] {
  const provider = state.treeDataProvider;
  if (!provider) {
    return [];
  }
  return provider.getRootNodes().filter(
    (r) => typeof r.properties.extensionPurpose !== 'string'
  );
}


/**
 * Recursively walk tree to find a node by predicate. Returns first match or undefined.
 */
function findNodeInTree(root: TreeNode, predicate: (n: TreeNode) => boolean): TreeNode | undefined {
  if (predicate(root)) {
    return root;
  }
  if (!root.children) {
    return undefined;
  }
  for (const child of root.children) {
    const found = findNodeInTree(child, predicate);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Navigate from a borrowed (Adopted) extension object to the corresponding object in the main config.
 * Uses extendedConfigurationObject UUID or falls back to matching by name+type.
 */
export async function navigateToMainObject(borrowedNode: TreeNode, state: ExtensionState): Promise<void> {
  const { treeView, treeDataProvider: provider } = state;
  if (!treeView || !provider) {
    vscode.window.showWarningMessage('Дерево метаданных не загружено.');
    return;
  }

  const mainRoots = getMainConfigRoots(state);

  if (mainRoots.length === 0) {
    vscode.window.showWarningMessage('Не найдено конфигураций (не расширений) в workspace.');
    return;
  }

  let targetNode: TreeNode | undefined;

  // Match by name + type: borrowed object name and type match the main config object
  for (const mainRoot of mainRoots) {
    targetNode = findNodeInTree(
      mainRoot,
      (n) => n.name === borrowedNode.name && n.type === borrowedNode.type
    );
    if (targetNode) {
      break;
    }
  }

  if (!targetNode) {
    vscode.window.showWarningMessage(
      `Не удалось найти объект «${borrowedNode.name}» в основных конфигурациях workspace.`
    );
    return;
  }

  try {
    await treeView.reveal(targetNode, { select: true, focus: true, expand: true });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Не удалось перейти к объекту: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Find all extension nodes that borrow a given main-config object (same name + type + objectBelonging === 'Adopted').
 */
export async function findBorrowingExtensions(mainNode: TreeNode, state: ExtensionState): Promise<TreeNode[]> {
  const extensionRoots = getExtensionRootNodes(state);
  const borrowingNodes: TreeNode[] = [];

  for (const extRoot of extensionRoots) {
    if (!extRoot.children) {
      continue;
    }
    for (const typeFolder of extRoot.children) {
      if (typeFolder.type !== mainNode.type || !typeFolder.children) {
        continue;
      }
      for (const obj of typeFolder.children) {
        if (
          obj.name === mainNode.name &&
          obj.properties.objectBelonging === 'Adopted'
        ) {
          borrowingNodes.push(obj);
        }
      }
    }
  }

  return borrowingNodes;
}

/**
 * Show related objects QuickPick for navigation:
 * - If borrowed: offer "Перейти к оригиналу"
 * - If main config object: offer list of extensions borrowing it
 */
export async function showRelatedObjects(node: TreeNode, state: ExtensionState): Promise<void> {
  const { treeView, treeDataProvider: provider } = state;
  if (!treeView || !provider) {
    vscode.window.showWarningMessage('Дерево метаданных не загружено.');
    return;
  }

  const isBorrowed = node.properties.objectBelonging === 'Adopted';

  if (isBorrowed) {
    // Show single "go to original" action
    const pick = await vscode.window.showQuickPick(
      [{ label: '$(go-to-file) Перейти к оригиналу', description: node.name }],
      { placeHolder: 'Связанные объекты' }
    );
    if (pick) {
      await navigateToMainObject(node, state);
    }
    return;
  }

  // Main config object — find borrowing extensions
  const borrowers = await findBorrowingExtensions(node, state);

  if (borrowers.length === 0) {
    vscode.window.showInformationMessage(
      `Объект «${node.name}» не заимствован ни одним расширением в workspace.`
    );
    return;
  }

  const items = borrowers.map((b) => {
    // Walk up to find the extension root name
    let extName = '';
    let p: TreeNode | undefined = b.parent;
    while (p) {
      if (p.type === MetadataType.Extension) {
        extName = p.name;
        break;
      }
      p = p.parent;
    }
    return {
      label: `$(extensions) ${extName || b.name}`,
      description: `${String(b.type)} · ${b.name}`,
      node: b,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Расширения, заимствующие «${node.name}»`,
    matchOnDescription: true,
  });

  if (picked) {
    try {
      await treeView.reveal(picked.node, { select: true, focus: true, expand: true });
    } catch (err) {
      vscode.window.showErrorMessage(
        `Не удалось перейти к объекту: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
