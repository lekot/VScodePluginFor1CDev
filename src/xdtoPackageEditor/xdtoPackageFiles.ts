import * as fs from 'fs';
import type { TreeNode } from '../models/treeNode';

export function stripUtf8Bom(source: string): string {
  return source.startsWith('\uFEFF') ? source.slice(1) : source;
}

export function buildXdtoPackageSkeleton(targetNamespace: string): string {
  const escapedNamespace = escapeXml(targetNamespace.trim());
  const namespaceAttribute = escapedNamespace ? ` targetNamespace="${escapedNamespace}"` : '';
  return (
    `\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto" ` +
    `xmlns:xs="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${namespaceAttribute}>\r\n` +
    `</package>\r\n`
  );
}

export function getNodeNamespace(node: TreeNode): string {
  const props = (node.properties ?? {}) as Record<string, unknown>;
  const raw = props['Namespace'] ?? props['namespace'];
  return typeof raw === 'string' ? raw : '';
}

export function ensureXdtoPackageSourceFile(node: TreeNode, schemaPath: string): string {
  if (fs.existsSync(schemaPath)) {
    return fs.readFileSync(schemaPath, 'utf8');
  }
  // Opening an editor is read-only. The skeleton becomes durable only through
  // the configuration mutation plan used by the first explicit save.
  return buildXdtoPackageSkeleton(getNodeNamespace(node));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
