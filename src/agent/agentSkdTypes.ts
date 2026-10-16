// src/agent/agentSkdTypes.ts
// Agent SKD API — типы параметров и результатов команд СКД.
// Без зависимостей от vscode — только чистые типы.
// PS1-скрипты возвращают plain text (не JSON); типы отражают реальный API.

// ─── skd.compile ─────────────────────────────────────────────────────────────

/**
 * Параметры компиляции СКД из JSON DSL.
 * Один из DefinitionFile / value обязателен; нельзя использовать оба вместе.
 */
export interface SkdCompileParams {
    /**
     * Путь к JSON-файлу описания СКД (skd-compile.ps1: -DefinitionFile).
     * Взаимоисключающее с value.
     */
    definitionFile?: string;
    /**
     * Inline JSON-строка с описанием СКД (skd-compile.ps1: -Value).
     * Взаимоисключающее с definitionFile.
     */
    value?: string;
    /** Путь к выходному XML-файлу (skd-compile.ps1: -OutputPath, обязателен). */
    outputPath: string;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

/** Результат компиляции СКД. */
export interface SkdCompileResult {
    /** Абсолютный путь записанного XML. */
    output: string;
    /** Статистика из stdout. */
    stats?: {
        dataSets: number;
        fields: number;
        calculated: number;
        totals: number;
        parameters: number;
        variants: number;
        sizeBytes: number;
    };
    /** Полный stdout скрипта (для диагностики). */
    rawOutput: string;
}

// ─── skd.info ────────────────────────────────────────────────────────────────

/**
 * Параметры получения информации о СКД.
 */
export interface SkdInfoParams {
    /**
     * Путь к Template.xml или к папке СКД (skd-info.ps1: -TemplatePath, обязателен).
     * Поддерживает: путь к xml, папка (→ Ext/Template.xml), дескриптор (.xml → Stem/Ext/Template.xml).
     */
    templatePath: string;
    /**
     * Режим вывода (skd-info.ps1: -Mode).
     * Допустимые значения: overview, query, fields, links, calculated, resources,
     * params, variant, trace, templates, full.
     * По умолчанию: overview.
     */
    mode?: 'overview' | 'query' | 'fields' | 'links' | 'calculated' | 'resources' | 'params' | 'variant' | 'trace' | 'templates' | 'full';
    /** Имя набора данных / варианта для детального вывода (skd-info.ps1: -Name). */
    name?: string;
    /** Загрузка пакетами, 0 = без пакетов (skd-info.ps1: -Batch). */
    batch?: number;
    /** Максимальное количество строк на страницу (skd-info.ps1: -Limit, по умолчанию 150). */
    limit?: number;
    /** Смещение для пагинации (skd-info.ps1: -Offset). */
    offset?: number;
    /** Путь к выходному файлу (skd-info.ps1: -OutFile). */
    outFile?: string;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

/** Результат анализа СКД. */
export interface SkdInfoResult {
    /** Plain-text вывод skd-info.ps1. */
    info: string;
    /** true если вывод был усечён (-Limit/-Offset). */
    truncated?: boolean;
}

// ─── skd.edit ────────────────────────────────────────────────────────────────

/**
 * Допустимые операции редактирования СКД (skd-edit.ps1: -Operation ValidateSet).
 */
export const SKD_EDIT_OPERATIONS = [
    'add-field', 'add-total', 'add-calculated-field', 'add-parameter', 'add-filter',
    'add-dataParameter', 'add-order', 'add-selection', 'add-dataSetLink',
    'add-dataSet', 'add-variant', 'add-conditionalAppearance', 'add-drilldown',
    'set-query', 'patch-query', 'set-outputParameter', 'set-structure',
    'modify-field', 'modify-filter', 'modify-dataParameter', 'modify-parameter', 'modify-structure', 'set-field-role',
    'rename-parameter', 'reorder-parameters',
    'clear-selection', 'clear-order', 'clear-filter', 'clear-conditionalAppearance',
    'remove-field', 'remove-total', 'remove-calculated-field', 'remove-parameter', 'remove-filter',
] as const;

export type SkdEditOperation = (typeof SKD_EDIT_OPERATIONS)[number];

/**
 * Параметры атомарного редактирования СКД.
 */
export interface SkdEditParams {
    /**
     * Путь к Template.xml или папке СКД (skd-edit.ps1: -TemplatePath, обязателен).
     */
    templatePath: string;
    /**
     * Операция редактирования (skd-edit.ps1: -Operation, обязателен).
     */
    operation: SkdEditOperation;
    /**
     * JSON-значение операции (skd-edit.ps1: -Value, обязателен).
     * Содержимое зависит от операции.
     */
    value: string;
    /** Имя набора данных для привязки операции (skd-edit.ps1: -DataSet). */
    dataSet?: string;
    /** Имя варианта настроек (skd-edit.ps1: -Variant). */
    variant?: string;
    /** Флаг: не добавлять автоматически в отбор (skd-edit.ps1: -NoSelection). */
    noSelection?: boolean;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

/** Результат редактирования СКД. */
export interface SkdEditResult {
    /** Путь к сохранённому файлу. */
    output: string;
    /** Полный stdout (список OK/WARN строк). */
    rawOutput: string;
}

// ─── skd.validate ────────────────────────────────────────────────────────────

/**
 * Параметры валидации СКД.
 */
export interface SkdValidateParams {
    /**
     * Путь к Template.xml, папке СКД или дескриптору (skd-validate.ps1: -TemplatePath, обязателен).
     */
    templatePath: string;
    /** Детальный вывод, включая [OK]-строки (skd-validate.ps1: -Detailed). */
    detailed?: boolean;
    /** Максимальное количество ошибок до остановки (skd-validate.ps1: -MaxErrors, по умолчанию 20). */
    maxErrors?: number;
    /** Путь к выходному файлу отчёта (skd-validate.ps1: -OutFile). */
    outFile?: string;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

/** Результат валидации СКД. */
export interface SkdValidateResult {
    /**
     * true если нет ошибок и предупреждений в выполненных проверках.
     * Примечание: если coverage === 'partial' (например, XSD не проверялся),
     * платформенная валидность типов и порядка элементов не гарантируется полностью.
     */
    valid: boolean;
    /**
     * Степень покрытия валидацией:
     * - 'full' — структурные проверки и XSD-схемы платформы проверены.
     * - 'partial' — структурные проверки выполнены, но XSD-валидация не проводилась.
     */
    coverage: 'full' | 'partial';
    /** true если XSD-валидация была фактически выполнена. */
    xsdChecked: boolean;
    /** Причина, по которой XSD не проверялся (если xsdChecked === false). */
    xsdReason?: string;
    /** Количество ошибок. */
    errorCount: number;
    /** Количество предупреждений. */
    warningCount: number;
    /** Полный stdout вывод (строки [ERROR]/[WARN]/[OK]). */
    rawOutput: string;
}

/** PowerShell may have changed the target before a requested stop was confirmed. */
export interface SkdOperationInDoubtResult {
    status: 'inDoubt';
    effectPossible: true;
}
