/**
 * Common test utilities and helpers
 * Reduces code duplication across test files
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import type { FormModel, FormChildItem, FormAttribute } from '../../src/formEditor/formModel';

// ---------------------------------------------------------------------------
// Temporary Directory Management
// ---------------------------------------------------------------------------

/**
 * Creates a temporary directory for test isolation
 * @param prefix Prefix for the temp directory name
 * @returns Path to the created temporary directory
 */
export async function createTempDir(prefix: string = '1cviewer-test-'): Promise<string> {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Removes a temporary directory and all its contents
 * @param tmpDir Path to the temporary directory
 */
export async function cleanupTempDir(tmpDir: string): Promise<void> {
  try {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// TreeNode Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Configuration TreeNode
 */
export function createConfigNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 'config',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: {},
    ...overrides,
  };
}

/**
 * Creates a Catalogs type node
 */
export function createCatalogsTypeNode(
  parent: TreeNode,
  filePath?: string,
  overrides: Partial<TreeNode> = {}
): TreeNode {
  return {
    id: 'catalogs',
    name: 'Catalogs',
    type: MetadataType.Catalog,
    properties: {},
    filePath,
    parent,
    ...overrides,
  };
}

/**
 * Creates a Catalog element node
 */
export function createCatalogNode(
  name: string,
  parent: TreeNode,
  filePath?: string,
  overrides: Partial<TreeNode> = {}
): TreeNode {
  return {
    id: `cat-${name}`,
    name,
    type: MetadataType.Catalog,
    properties: {},
    filePath,
    parent,
    ...overrides,
  };
}

/**
 * Creates a Forms node
 */
export function createFormsNode(
  parent: TreeNode,
  filePath?: string,
  overrides: Partial<TreeNode> = {}
): TreeNode {
  return {
    id: 'Forms',
    name: 'Forms',
    type: MetadataType.Form,
    properties: {},
    children: [],
    filePath,
    parent,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FormModel Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates a minimal valid FormModel
 */
export function createFormModel(overrides: Partial<FormModel> = {}): FormModel {
  return {
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
    ...overrides,
  };
}

/**
 * Creates a FormChildItem (form element)
 */
export function createFormItem(
  id: string,
  name: string,
  tag: string = 'InputField',
  children: FormChildItem[] = []
): FormChildItem {
  return {
    tag,
    id,
    name,
    properties: {},
    childItems: children,
  };
}

/**
 * Creates a FormAttribute
 */
export function createFormAttribute(
  name: string,
  id?: string,
  properties: Record<string, unknown> = {}
): FormAttribute {
  return {
    name,
    id,
    properties,
  };
}

// ---------------------------------------------------------------------------
// ID Collection Utilities
// ---------------------------------------------------------------------------

/**
 * Collects all IDs from a FormChildItem tree
 */
export function collectAllIds(item: FormChildItem): Set<string> {
  const ids = new Set<string>();
  const walk = (node: FormChildItem) => {
    if (node.id) {
      ids.add(node.id);
    }
    for (const child of node.childItems ?? []) {
      walk(child);
    }
  };
  walk(item);
  return ids;
}

/**
 * Collects all IDs from a FormModel's childItemsRoot
 */
export function collectModelIds(model: FormModel): Set<string> {
  const ids = new Set<string>();
  const walk = (items: FormChildItem[]) => {
    for (const item of items) {
      if (item.id) {
        ids.add(item.id);
      }
      if (item.childItems?.length) {
        walk(item.childItems);
      }
    }
  };
  walk(model.childItemsRoot);
  return ids;
}

// ---------------------------------------------------------------------------
// File System Utilities
// ---------------------------------------------------------------------------

/**
 * Creates a directory structure for testing
 * @param basePath Base path for the structure
 * @param structure Object describing the directory structure
 */
export async function createDirectoryStructure(
  basePath: string,
  structure: Record<string, string | Record<string, unknown>>
): Promise<void> {
  for (const [name, content] of Object.entries(structure)) {
    const fullPath = path.join(basePath, name);
    if (typeof content === 'string') {
      // It's a file
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, content, 'utf-8');
    } else {
      // It's a directory
      await fs.promises.mkdir(fullPath, { recursive: true });
      await createDirectoryStructure(fullPath, content as Record<string, string>);
    }
  }
}

/**
 * Checks if a file exists
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Checks if a directory exists
 */
export function dirExists(dirPath: string): boolean {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

/**
 * Reads file content as UTF-8 string
 */
export async function readFileContent(filePath: string): Promise<string> {
  return await fs.promises.readFile(filePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// XML Test Utilities
// ---------------------------------------------------------------------------

/**
 * Creates a minimal XML structure for testing
 */
export function createMinimalXml(rootTag: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<${rootTag} xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:core="http://v8.1c.ru/8.1/data/core" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${name}</Name>
</${rootTag}>`;
}

/**
 * Asserts that XML content contains a specific tag
 */
export function assertXmlContains(xml: string, tag: string): void {
  if (!xml.includes(`<${tag}`)) {
    throw new Error(`XML does not contain tag: ${tag}`);
  }
}

/**
 * Asserts that XML content contains a specific name element
 */
export function assertXmlContainsName(xml: string, name: string): void {
  if (!xml.includes(`<Name>${name}</Name>`)) {
    throw new Error(`XML does not contain name: ${name}`);
  }
}
