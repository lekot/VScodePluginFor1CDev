// src/agent/agentBindingResolver.ts
// Agent API — resolveBinding: фикстура/configPath → инфобаза.
// Позволяет агенту узнать путь к базе по имени фикстуры ("uh", "empty_conf").

import * as vscode from 'vscode';
import * as path from 'path';
import type { AgentResult } from './types';
import type { AgentDebugOperationsDeps } from './agentDebugOperations';
import type { ConfigurationBinding } from '../bindings/models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResolveBindingParams {
    /** Путь к фикстуре: полный, относительный, или просто имя ("uh", "empty_conf"). */
    configPath?: string;
}

export interface ResolvedBinding {
    configPath: string;
    configRelativePath: string;
    workspaceFolder: string;
    infobase: {
        id: string;
        name: string;
        type: 'file' | 'server' | 'web';
        filePath?: string;
        server?: string;
        database?: string;
        webUrl?: string;
    } | null;
}

export interface BindingListItem {
    configRelativePath: string;
    workspaceFolder: string;
    infobaseCount: number;
    infobases: Array<{
        id: string;
        name: string;
        type: string;
        filePath?: string;
        server?: string;
        database?: string;
        webUrl?: string;
    }>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Ищет binding по configPath (полный путь, относительный, или fuzzy имя фикстуры).
 * Возвращает резолвленную инфобазу (первую file/server из привязанных).
 */
export async function resolveBindingCommand(
    params: ResolveBindingParams,
    deps: AgentDebugOperationsDeps,
): Promise<AgentResult<ResolvedBinding>> {
    const allBindings = await deps.bindingManager.listAll();
    if (allBindings.length === 0) {
        return { success: false, error: 'Нет привязок. Создайте привязку через «Привязать базы…»' };
    }

    const query = params.configPath ?? deps.getConfigPath?.();
    if (!query) {
        return { success: false, error: 'configPath не указан и нет активной конфигурации' };
    }

    // Find matching binding — try 3 strategies:
    // 1. Exact match by resolved absolute path
    // 2. Substring match by relative path
    // 3. Fuzzy match by fixture directory name
    const matched = findBinding(query, allBindings);
    if (!matched) {
        const available = allBindings.map(b => extractFixtureName(b.configRelativePath)).join(', ');
        return { success: false, error: `Привязка не найдена для "${query}". Доступные фикстуры: ${available}` };
    }

    // Resolve infobase
    let infobase: ResolvedBinding['infobase'] = null;
    if (matched.infobaseIds.length > 0) {
        const catalog = await deps.infobaseStorage.load();
        const catalogById = new Map(catalog.map(e => [e.id, e] as const));

        for (const id of matched.infobaseIds) {
            const entry = catalogById.get(id);
            if (entry && (entry.type === 'file' || entry.type === 'server')) {
                infobase = pickInfobaseFields(entry);
                break;
            }
        }
        // Fallback: return any entry (even web)
        if (!infobase && matched.infobaseIds.length > 0) {
            const entry = catalogById.get(matched.infobaseIds[0]);
            if (entry) {
                infobase = pickInfobaseFields(entry);
            }
        }
    }

    // Resolve absolute configPath
    const wsFolder = vscode.workspace.workspaceFolders?.find(f => f.name === matched.workspaceFolder)
        ?? vscode.workspace.workspaceFolders?.[0];
    const absoluteConfigPath = wsFolder
        ? path.join(wsFolder.uri.fsPath, matched.configRelativePath)
        : matched.configRelativePath;

    return {
        success: true,
        data: {
            configPath: absoluteConfigPath,
            configRelativePath: matched.configRelativePath,
            workspaceFolder: matched.workspaceFolder,
            infobase,
        },
    };
}

/**
 * Возвращает все привязки с резолвленными инфобазами.
 */
export async function listBindingsCommand(
    deps: AgentDebugOperationsDeps,
): Promise<AgentResult<BindingListItem[]>> {
    const allBindings = await deps.bindingManager.listAll();
    const catalog = await deps.infobaseStorage.load();
    const catalogById = new Map(catalog.map(e => [e.id, e] as const));

    const items: BindingListItem[] = allBindings.map(b => {
        const infobases = b.infobaseIds
            .map(id => catalogById.get(id))
            .filter((e): e is InfobaseEntry => e !== undefined)
            .map(pickInfobaseFields);

        return {
            configRelativePath: b.configRelativePath,
            workspaceFolder: b.workspaceFolder,
            infobaseCount: infobases.length,
            infobases,
        };
    });

    return { success: true, data: items };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findBinding(query: string, bindings: ConfigurationBinding[]): ConfigurationBinding | undefined {
    const isWin = process.platform === 'win32';
    const norm = (p: string): string => {
        const r = p.replace(/\\/g, '/');
        return isWin ? r.toLowerCase() : r;
    };
    const q = norm(query);

    // Strategy 1: exact match by full or relative path
    for (const b of bindings) {
        const rel = norm(b.configRelativePath);
        if (rel === q) {
            return b;
        }
    }

    // Strategy 2: query is a substring of configRelativePath (e.g. "FormatSamples/uh")
    for (const b of bindings) {
        const rel = norm(b.configRelativePath);
        if (rel.includes(q + '/') || rel.endsWith(q)) {
            return b;
        }
    }

    // Strategy 3: fuzzy match by fixture directory name
    // "uh" matches "FormatSamples/uh/Configuration.xml"
    // "empty_conf" matches "FormatSamples/empty_conf/Configuration.xml"
    for (const b of bindings) {
        const fixtureName = norm(extractFixtureName(b.configRelativePath));
        if (fixtureName === q || fixtureName.includes(q)) {
            return b;
        }
    }

    return undefined;
}

/** Extract fixture directory name from configRelativePath. */
function extractFixtureName(configRelativePath: string): string {
    // "FormatSamples/uh/Configuration.xml" → "uh"
    // "FormatSamples/empty_conf/Configuration.xml" → "empty_conf"
    const parts = configRelativePath.replace(/\\/g, '/').split('/');
    // Drop the last segment (Configuration.xml) and return the parent dir name
    if (parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return parts[0];
}

function pickInfobaseFields(entry: InfobaseEntry): ResolvedBinding['infobase'] & object {
    return {
        id: entry.id,
        name: entry.name,
        type: entry.type,
        ...(entry.filePath ? { filePath: entry.filePath } : {}),
        ...(entry.server ? { server: entry.server } : {}),
        ...(entry.database ? { database: entry.database } : {}),
        ...(entry.webUrl ? { webUrl: entry.webUrl } : {}),
    };
}
