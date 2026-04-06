// src/agent/types.ts
// Agent API — публичные типы для команд агента. Без зависимостей от vscode.

export interface AgentResult<T = void> {
    success: boolean;
    data?: T;
    error?: string;
}

export interface CreateObjectParams {
    /** Тип объекта: 'Catalog', 'Document', 'Enum', 'CommonModule', 'Subsystem' */
    type: string;
    name: string;
    synonym?: string;
    properties?: Record<string, unknown>;
}

export interface GetYamlParams {
    /** Путь вида 'Catalog.Товары' */
    path: string;
}

export interface ListObjectsParams {
    /** Если не задан — все типы */
    type?: string;
}

export interface ObjectInfo {
    type: string;
    name: string;
    filePath: string;
}
