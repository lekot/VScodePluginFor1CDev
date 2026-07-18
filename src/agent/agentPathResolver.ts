// src/agent/agentPathResolver.ts
// Resolves agent path strings (e.g. 'Catalog.Товары') to file system paths and metadata segments.

import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { validateElementName } from '../utils/elementNameValidator';
import { isPathInside } from '../services/configurationSession/pathBoundary';
import type { ResolvedAgentPath } from './types';

export type AgentPathErrorCode = 'INVALID_AGENT_PATH';

/** Typed Agent API contract error for syntactically valid commands with an unsupported metadata path. */
export class AgentPathError extends Error {
    constructor(readonly code: AgentPathErrorCode, message: string) {
        super(message);
        this.name = 'AgentPathError';
    }
}

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
    validatePathIdentifier(rootTag, 'тип объекта');
    validatePathIdentifier(objectName, 'имя объекта');
    if (segments.length >= 4) {
        validatePathIdentifier(segments[2], 'тип вложенного элемента');
        validatePathIdentifier(segments[3], 'имя вложенного элемента');
    }
    if (segments.length === 6) {
        validatePathIdentifier(segments[4], 'тип вложенного элемента');
        validatePathIdentifier(segments[5], 'имя вложенного элемента');
    }

    const folderName =
        MetadataTypeMapper.getDesignerFolderIdForMetadataType(rootTag as MetadataType) ??
        `${rootTag}s`;

    const filePath = path.join(configRoot, folderName, `${objectName}.xml`);
    if (!isPathInside(configRoot, filePath)) {
        throw new Error(`Agent path выходит за границы конфигурации: "${agentPath}".`);
    }

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

function validatePathIdentifier(value: string, role: string): void {
    const error = validateElementName(value, []);
    if (error) {
        throw new Error(`Некорректный ${role} "${value}": ${error}`);
    }
}
