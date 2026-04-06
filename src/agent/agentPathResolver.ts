// src/agent/agentPathResolver.ts
// Resolves agent path strings (e.g. 'Catalog.Товары') to file system paths and metadata segments.

import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import type { ResolvedAgentPath } from './types';

/**
 * Resolve an agent path (dot-separated) to a ResolvedAgentPath.
 *
 * Supported formats:
 *   2 segments: RootTag.ObjectName
 *   4 segments: RootTag.ObjectName.NestedType.NestedName
 *   6 segments: RootTag.ObjectName.TabularSection.TSName.NestedType.NestedName
 */
export function resolveAgentPath(configRoot: string, agentPath: string): ResolvedAgentPath {
    const segments = agentPath.split('.');

    if (segments.length !== 2 && segments.length !== 4 && segments.length !== 6) {
        throw new Error(
            `Invalid agent path: "${agentPath}". ` +
            `Expected 2 segments (RootTag.Name), 4 segments (RootTag.Name.NestedType.NestedName), ` +
            `or 6 segments (RootTag.Name.TabularSection.TSName.NestedType.NestedName).`
        );
    }

    const rootTag = segments[0];
    const objectName = segments[1];

    const folderName =
        MetadataTypeMapper.getDesignerFolderIdForMetadataType(rootTag as MetadataType) ??
        `${rootTag}s`;

    const filePath = path.join(configRoot, folderName, `${objectName}.xml`);

    if (segments.length === 2) {
        return { rootTag, objectName, filePath };
    }

    if (segments.length === 4) {
        return {
            rootTag,
            objectName,
            filePath,
            nestedType: segments[2],
            nestedName: segments[3],
        };
    }

    // 6 segments
    return {
        rootTag,
        objectName,
        filePath,
        tabularSection: segments[3],
        nestedType: segments[4],
        nestedName: segments[5],
    };
}
