// src/agent/agentSourceAddressResolver.ts
// Resolves semantic source addresses (e.g. 'main:Catalog.Goods', 'ExtShop:Catalog.Goods') to configuration sessions and paths.

import * as path from 'path';
import type { ConfigurationSession } from '../services/configurationSession/ConfigurationSession';
import type { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import { CfeProjectRegistry } from '../extensionSupport/cfeProject/registry';
import type { CfeProjectContext } from '../extensionSupport/cfeProject/types';
import {
    AgentPathError,
    parseSourceAddress,
    resolveAgentPath,
} from './agentPathResolver';
import type { ResolvedAgentPath, AgentTreeNodeSummary } from './types';
import type { TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';

export interface ResolveSourceAddressParams {
    /** Semantic address, e.g. 'main:Catalog.Goods', 'ExtShop:Catalog.Goods', or 'Catalog.Goods' */
    address: string;
    /** Optional exact configuration selector */
    configurationId?: string;
}

export interface SourceAddressResolutionContext {
    registry: WorkspaceRegistry;
    workspaceRoot?: string;
    treeDataProvider?: MetadataTreeDataProvider;
}

export interface ResolvedSourceAddress {
    sourceSet: string;
    dotPath: string;
    configRoot: string;
    session: ConfigurationSession;
    configurationId: string;
    resolvedPath: ResolvedAgentPath;
    cfeContext?: CfeProjectContext;
    treeNode?: AgentTreeNodeSummary;
}


/**
 * Resolves a semantic source address (e.g. 'main:Catalog.Goods' or 'ExtShop:Catalog.Goods')
 * to its ConfigurationSession, physical configuration root, and parsed path.
 */
export async function resolveSourceAddress(
    params: ResolveSourceAddressParams,
    context: SourceAddressResolutionContext,
): Promise<ResolvedSourceAddress> {
    const { sourceSet: explicitSourceSet, dotPath } = parseSourceAddress(params.address);
    let sourceSet = explicitSourceSet ?? 'main';

    const cfeProjects: CfeProjectContext[] = [];
    const candidateRoots = new Set<string>();
    if (context.workspaceRoot) {
        candidateRoots.add(context.workspaceRoot);
    } else {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const vscode = require('vscode');
            const folders = vscode.workspace?.workspaceFolders;
            if (folders && folders.length > 0) {
                for (const f of folders) {
                    if (f?.uri?.fsPath) {
                        candidateRoots.add(f.uri.fsPath);
                    }
                }
            }
        } catch {
            // Not running in VS Code runtime
        }
        if (candidateRoots.size === 0) {
            for (const item of context.registry.list()) {
                candidateRoots.add(path.dirname(item.rootPath));
                candidateRoots.add(path.dirname(path.dirname(item.rootPath)));
            }
        }
    }

    for (const wsRoot of candidateRoots) {
        try {
            const cfeRegistry = new CfeProjectRegistry(wsRoot, context.registry);
            const found = await cfeRegistry.list();
            for (const proj of found) {
                if (!cfeProjects.some((p) =>
                    p.extensionSession.identity.configurationId === proj.extensionSession.identity.configurationId
                    && p.baseSession.identity.configurationId === proj.baseSession.identity.configurationId
                )) {
                    cfeProjects.push(proj);
                }
            }
        } catch {
            // Manifest may not exist or folder has no CFE projects
        }
    }


    let targetSession: ConfigurationSession;
    let cfeContext: CfeProjectContext | undefined;

    if (explicitSourceSet === undefined && params.configurationId) {
        targetSession = context.registry.require(params.configurationId);
        const matchingProject = cfeProjects.find(
            (p) => p.extensionSession.identity.configurationId === targetSession.identity.configurationId,
        );
        if (matchingProject) {
            cfeContext = matchingProject;
            sourceSet = matchingProject.extensionName;
        }
    } else if (sourceSet.toLowerCase() === 'main') {
        if (params.configurationId) {
            const session = context.registry.require(params.configurationId);
            const isExtension = cfeProjects.some(
                (p) => p.extensionSession.identity.configurationId === session.identity.configurationId,
            );
            if (isExtension) {
                throw new AgentPathError(
                    'INVALID_AGENT_PATH',
                    `The provided configurationId "${params.configurationId}" conflicts with source set "main".`,
                );
            }
            targetSession = session;
        } else if (cfeProjects.length > 0) {
            const baseSessions = cfeProjects.map((p) => p.baseSession);
            const uniqueBaseIds = Array.from(new Set(baseSessions.map((s) => s.identity.configurationId)));
            if (uniqueBaseIds.length === 1) {
                targetSession = baseSessions[0];
            } else {
                throw new AgentPathError(
                    'INVALID_AGENT_PATH',
                    'Multiple base configurations found in workspace. Specify configurationId explicitly.',
                );
            }
        } else {
            targetSession = context.registry.resolveLegacyDefault('read');
        }
    } else if (sourceSet.toLowerCase() === 'cfe') {
        if (cfeProjects.length === 0) {
            throw new AgentPathError('INVALID_AGENT_PATH', 'No CFE extension projects found in workspace.');
        }
        if (cfeProjects.length > 1) {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `Multiple CFE extension projects found (${cfeProjects.map((p) => p.extensionName).join(', ')}). Specify extension name explicitly as <extensionName>:<dotPath>.`,
            );
        }
        const project = cfeProjects[0];
        targetSession = project.extensionSession;
        cfeContext = project;
        if (params.configurationId && targetSession.identity.configurationId !== params.configurationId) {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `The provided configurationId "${params.configurationId}" conflicts with source set "${sourceSet}".`,
            );
        }
    } else {
        // Specific extension name or configuration label
        const matchingProjects = cfeProjects.filter(
            (p) => p.extensionName.toLowerCase() === sourceSet.toLowerCase()
                || path.basename(p.extensionRoot).toLowerCase() === sourceSet.toLowerCase(),
        );
        if (matchingProjects.length > 0) {
            let project: CfeProjectContext;
            if (params.configurationId) {
                const found = matchingProjects.find(
                    (p) => p.extensionSession.identity.configurationId === params.configurationId,
                );
                if (!found) {
                    throw new AgentPathError(
                        'INVALID_AGENT_PATH',
                        `The provided configurationId "${params.configurationId}" conflicts with source set "${sourceSet}".`,
                    );
                }
                project = found;
            } else if (matchingProjects.length > 1) {
                throw new AgentPathError(
                    'INVALID_AGENT_PATH',
                    `Multiple CFE projects named "${sourceSet}" found in workspace. Specify configurationId explicitly.`,
                );
            } else {
                project = matchingProjects[0];
            }
            targetSession = project.extensionSession;
            cfeContext = project;
        } else {
            // Check if sourceSet matches a configuration descriptor label or id in registry
            const desc = context.registry.list().find(
                (d) => d.label.toLowerCase() === sourceSet.toLowerCase()
                    || d.configurationId === sourceSet,
            );
            if (desc) {
                targetSession = context.registry.require(desc.configurationId);
                if (params.configurationId && targetSession.identity.configurationId !== params.configurationId) {
                    throw new AgentPathError(
                        'INVALID_AGENT_PATH',
                        `The provided configurationId "${params.configurationId}" conflicts with source set "${sourceSet}".`,
                    );
                }
            } else {
                throw new AgentPathError(
                    'INVALID_AGENT_PATH',
                    `Source set "${sourceSet}" is unknown or not found in workspace.`,
                );
            }
        }
    }

    const configRoot = targetSession.identity.rootPath;
    const resolvedPath = resolveAgentPath(configRoot, params.address);
    resolvedPath.sourceSet = sourceSet;

    let treeNode: AgentTreeNodeSummary | undefined;
    if (context.treeDataProvider && typeof context.treeDataProvider.findNodeByLocation === 'function') {
        try {
            const node = await context.treeDataProvider.findNodeByLocation({
                configRoot,
                objectType: resolvedPath.rootTag,
                objectName: resolvedPath.objectName,
                extensionName: cfeContext?.extensionName,
            });
            if (node) {
                treeNode = toAgentTreeNodeSummary(node);
            }
        } catch {
            // Ignore tree walk errors
        }
    }

    return {
        sourceSet,
        dotPath,
        configRoot,
        session: targetSession,
        configurationId: targetSession.identity.configurationId,
        resolvedPath,
        cfeContext,
        treeNode,
    };
}

/**
 * Converts a TreeNode into a JSON-safe AgentTreeNodeSummary DTO,
 * stripping circular references (parent and children) and ensuring safe serialization.
 */
export function toAgentTreeNodeSummary(node: TreeNode): AgentTreeNodeSummary {
    let properties: Record<string, unknown> | undefined;
    if (node.properties && typeof node.properties === 'object') {
        properties = {};
        for (const [key, value] of Object.entries(node.properties)) {
            if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
                continue;
            }
            if (typeof value === 'object' && value !== null) {
                try {
                    JSON.stringify(value);
                    properties[key] = value;
                } catch {
                    // skip non-serializable property
                }
            } else {
                properties[key] = value;
            }
        }
    }
    return {
        id: node.id,
        name: node.name,
        type: String(node.type),
        filePath: node.filePath,
        parentFilePath: node.parentFilePath,
        properties,
        hasChildren: Boolean(node.children && node.children.length > 0),
    };
}

