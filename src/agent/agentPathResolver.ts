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
 *   6 segments: RootTag.ObjectName.ParentType.ParentName.NestedType.NestedName
 *               (including the legacy TabularSection path)
 */
export function resolveAgentPath(configRoot: string, agentPath: string): ResolvedAgentPath {
    const segments = agentPath.split('.');

    if (segments.length !== 2 && segments.length !== 4 && segments.length !== 6) {
        throw new Error(
            `Invalid agent path: "${agentPath}". ` +
            `Expected 2 segments (RootTag.Name), 4 segments (RootTag.Name.NestedType.NestedName), ` +
            `or 6 segments (RootTag.Name.ParentType.ParentName.NestedType.NestedName).`
        );
    }

    const rootTag = segments[0];
    const objectName = segments[1];
    validatePathIdentifier(rootTag, 'тип объекта');
    validatePathIdentifier(objectName, 'имя объекта');
    if (segments.length >= 4) {
        validatePathTypeIdentifier(segments[2], 'тип вложенного элемента');
        validatePathIdentifier(segments[3], 'имя вложенного элемента');
    }
    if (segments.length === 6) {
        validatePathTypeIdentifier(segments[4], 'тип вложенного элемента');
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

    const nestedPath = [
        { type: rootTag, name: objectName },
        ...Array.from({ length: (segments.length - 2) / 2 }, (_, index) => ({
            type: segments[2 + index * 2],
            name: segments[3 + index * 2],
        })),
    ];

    if (rootTag === MetadataType.ExternalDataSource) {
        if (segments.length === 4 && segments[2] === 'Table') {
            const filePath = externalDataSourceTableFilePath(configRoot, folderName, objectName, segments[3], agentPath);
            return {
                rootTag,
                objectName,
                filePath,
                nestedPath,
                fileRootType: 'Table',
                fileNestedPath: [{ type: 'Table', name: segments[3] }],
            };
        }

        if (segments.length === 6 && segments[2] === 'Table' && segments[4] === 'Field') {
            const filePath = externalDataSourceTableFilePath(configRoot, folderName, objectName, segments[3], agentPath);
            return {
                rootTag,
                objectName,
                filePath,
                nestedPath,
                fileRootType: 'Table',
                fileNestedPath: nestedPath.slice(1),
                nestedType: 'Field',
                nestedName: segments[5],
            };
        }

        if (!(segments.length === 4 && segments[2] === 'Function')) {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `ExternalDataSource path must select a Table, Function, or Table Field: "${agentPath}".`,
            );
        }
    }

    if (segments.length === 4) {
        return {
            rootTag,
            objectName,
            filePath,
            nestedType: segments[2],
            nestedName: segments[3],
            nestedPath,
        };
    }

    // 6 segments
    return {
        rootTag,
        objectName,
        filePath,
        ...(segments[2] === 'TabularSection' ? { tabularSection: segments[3] } : {}),
        nestedType: segments[4],
        nestedName: segments[5],
        nestedPath,
    };
}

function externalDataSourceTableFilePath(
    configRoot: string,
    folderName: string,
    sourceName: string,
    tableName: string,
    agentPath: string,
): string {
    const filePath = path.join(configRoot, folderName, sourceName, 'Tables', `${tableName}.xml`);
    if (!isPathInside(configRoot, filePath)) {
        throw new AgentPathError('INVALID_AGENT_PATH', `Agent path выходит за границы конфигурации: "${agentPath}".`);
    }
    return filePath;
}

function validatePathIdentifier(value: string, role: string): void {
    const error = validateElementName(value, []);
    if (error) {
        throw new Error(`Некорректный ${role} "${value}": ${error}`);
    }
}

function validatePathTypeIdentifier(value: string, role: string): void {
    if ((Object.values(MetadataType) as string[]).includes(value)) {
        return;
    }
    validatePathIdentifier(value, role);
}
