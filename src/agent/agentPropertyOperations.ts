// src/agent/agentPropertyOperations.ts
// Handles object properties, type definitions, and EventSubscription sources for Agent API.

import * as fs from 'fs';
import { assertCfeGenericMutationAllowed } from '../extensionSupport/cfeProject/mutationPolicy';
import { getIdentitySensitiveMetadataPropertyNames } from '../domain/metadataPropertyClassifier';
import { XMLWriter } from '../utils/XMLWriter';
import { TypeParser } from '../parsers/typeParser';
import { TypeSerializer } from '../serializers/typeSerializer';
import { ObjectTypeParser } from '../parsers/objectTypeParser';
import { ObjectTypeSerializer } from '../serializers/objectTypeSerializer';
import {
    type AgentOperationsContext,
    mutationFailure,
    readCfeOwnershipForRead,
    runAgentMutation,
} from './agentOperationsShared';
import type {
    AgentResult,
    GetPropertiesParams,
    GetPropertiesResult,
    GetSourceParams,
    GetSourceResult,
    GetTypeParams,
    GetTypeResult,
    MutationResultData,
    SetPropertiesParams,
    SetSourceParams,
    SetTypeParams,
} from './types';

export class AgentPropertyOperations {
    constructor(private readonly context: AgentOperationsContext) {}

    private get configRootPath(): string {
        return this.context.configRootPath;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getProperties
    // ─────────────────────────────────────────────────────────────────────────

    async getProperties(params: GetPropertiesParams): Promise<AgentResult<GetPropertiesResult>> {
        try {
            const resolved = await this.context.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.context.validateExternalDataSourcePath(resolved);

            let properties: Record<string, unknown>;
            if (resolved.nestedType && resolved.nestedName) {
                properties = await XMLWriter.readNestedElementProperties(
                    filePath,
                    resolved.nestedType,
                    resolved.nestedName,
                    { nestedPath: resolved.fileNestedPath ?? resolved.nestedPath }
                );
            } else {
                properties = await XMLWriter.readProperties(filePath);
            }
            const cfeFields = await readCfeOwnershipForRead(this.configRootPath, filePath);
            return { success: true, data: { properties, ...cfeFields } };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setProperties
    // ─────────────────────────────────────────────────────────────────────────

    async setProperties(params: SetPropertiesParams): Promise<AgentResult<MutationResultData>> {
        try {
            if (getIdentitySensitiveMetadataPropertyNames(params.properties).length > 0) {
                return { success: false, error: 'Нельзя менять Name через setProperties. Используйте renameObject.' };
            }

            const resolved = await this.context.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'update');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.context.validateExternalDataSourcePath(resolved);

            return await runAgentMutation(this.context, {
                filePath,
                target: params.path,
                options: params,
                plannedChanges: { files: [filePath], summary: `Изменение свойств ${params.path}` },
                apply: async () => {
                    const props = this.normalizeTypeProperty(params.properties);

                    if (resolved.nestedType && resolved.nestedName) {
                        await XMLWriter.writeNestedElementProperties(
                            filePath,
                            resolved.nestedType,
                            resolved.nestedName,
                            props,
                            undefined,
                            { nestedPath: resolved.fileNestedPath ?? resolved.nestedPath }
                        );
                    } else {
                        await XMLWriter.writeProperties(filePath, props);
                    }
                },
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    /**
     * If properties contain a bare `Type` string (e.g. "cfg:DocumentRef.Больше"),
     * wrap it in the XML structure that writeNestedElementProperties expects:
     * `<Type><v8:Type>cfg:DocumentRef.Больше</v8:Type></Type>`.
     */
    private normalizeTypeProperty(properties: Record<string, unknown>): Record<string, unknown> {
        const typeVal = properties['Type'];
        if (typeof typeVal !== 'string' || typeVal.trim().startsWith('<')) {
            return properties;
        }
        return {
            ...properties,
            Type: `<Type><v8:Type>${typeVal}</v8:Type></Type>`,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getType
    // ─────────────────────────────────────────────────────────────────────────

    async getType(params: GetTypeParams): Promise<AgentResult<GetTypeResult>> {
        try {
            const resolved = await this.context.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.context.validateExternalDataSourcePath(resolved);
            const typeVal = resolved.fileRootType && !resolved.nestedType
                ? (await XMLWriter.readProperties(filePath))['Type']
                : await XMLWriter.readTypeProperty(
                    filePath,
                    resolved.nestedType,
                    resolved.nestedName,
                    resolved.tabularSection,
                    resolved.fileNestedPath ?? resolved.nestedPath,
                );

            // Пустой тип
            if (typeVal === undefined || typeVal === null || typeVal === '') {
                return { success: true, data: { types: [], rawXml: '' } };
            }

            let parsed;
            let rawXml: string;

            if (typeof typeVal === 'string' && typeVal.includes('<')) {
                // Строка содержит XML — парсим напрямую
                parsed = TypeParser.parse(typeVal);
                rawXml = typeVal;
            } else if (typeof typeVal === 'object') {
                // Уже распарсенный объект
                parsed = TypeParser.parseFromObject(typeVal as Record<string, unknown>);
                rawXml = TypeSerializer.serialize(parsed);
            } else {
                // Пустая или нераспознанная строка
                return { success: true, data: { types: [], rawXml: '' } };
            }

            // Преобразуем TypeEntry[] в массив строк
            const types: string[] = parsed.types.map(entry => {
                switch (entry.kind) {
                    case 'string':
                        return 'xs:string';
                    case 'number':
                        return 'xs:decimal';
                    case 'boolean':
                        return 'xs:boolean';
                    case 'date': {
                        const dateFractions = (entry.qualifiers as { dateFractions?: string } | undefined)?.dateFractions;
                        if (dateFractions === 'DateTime') { return 'xs:dateTime'; }
                        if (dateFractions === 'Time') { return 'xs:time'; }
                        return 'xs:date';
                    }
                    case 'reference':
                        return `cfg:${entry.referenceType!.referenceKind}.${entry.referenceType!.objectName}`;
                    default:
                        return '';
                }
            }).filter(Boolean);

            return { success: true, data: { types, rawXml } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setType
    // ─────────────────────────────────────────────────────────────────────────

    async setType(params: SetTypeParams): Promise<AgentResult<MutationResultData>> {
        try {
            const resolved = await this.context.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'update');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.context.validateExternalDataSourcePath(resolved);

            return await runAgentMutation(this.context, {
                filePath,
                target: params.path,
                options: params,
                plannedChanges: { files: [filePath], summary: `Изменение типа ${params.path}` },
                prepare: () => {
                    // Строим TypeDefinition из массива строк после precondition, как в прежнем порядке.
                    const typeEntries = params.types.map(typeStr => {
                        if (typeStr === 'xs:string') { return { kind: 'string' as const }; }
                        if (typeStr === 'xs:decimal') { return { kind: 'number' as const }; }
                        if (typeStr === 'xs:boolean') { return { kind: 'boolean' as const }; }
                        if (typeStr === 'xs:date' || typeStr === 'xs:dateTime' || typeStr === 'xs:time') {
                            const dateFractions = typeStr === 'xs:date'
                                ? 'Date' as const
                                : typeStr === 'xs:time'
                                    ? 'Time' as const
                                    : 'DateTime' as const;
                            return { kind: 'date' as const, qualifiers: { dateFractions } };
                        }
                        if (typeStr.startsWith('cfg:')) {
                            const withoutPrefix = typeStr.slice(4); // убираем 'cfg:'
                            const dotIdx = withoutPrefix.indexOf('.');
                            if (dotIdx === -1) {
                                throw new Error(`Некорректный формат типа-ссылки: "${typeStr}". Ожидается cfg:ReferenceKind.ObjectName`);
                            }
                            const referenceKind = withoutPrefix.slice(0, dotIdx);
                            const objectName = withoutPrefix.slice(dotIdx + 1);
                            return {
                                kind: 'reference' as const,
                                referenceType: {
                                    referenceKind: referenceKind as import('../types/typeDefinitions').ReferenceTypeInfo['referenceKind'],
                                    objectName,
                                },
                            };
                        }
                        throw new Error(`Неизвестный тип: "${typeStr}". Поддерживаются xs:string, xs:decimal, xs:boolean, xs:date, xs:dateTime, xs:time, cfg:Kind.Name`);
                    });

                    let category: 'primitive' | 'reference' | 'composite';
                    if (typeEntries.length === 0) {
                        category = 'primitive';
                    } else if (typeEntries.length === 1 && typeEntries[0].kind === 'reference') {
                        category = 'reference';
                    } else {
                        category = typeEntries.length === 1 ? 'primitive' : 'composite';
                    }
                    return { category, typeEntries };
                },
                apply: async ({ category, typeEntries }) => {
                    const definition = { category, types: typeEntries };
                    const typeProperty = TypeSerializer.serializePropertyValue(definition);

                    if (resolved.nestedType && resolved.nestedName) {
                        await XMLWriter.writeNestedElementProperties(
                            filePath,
                            resolved.nestedType,
                            resolved.nestedName,
                            { Type: typeProperty },
                            undefined,
                            {
                                nestedPath: resolved.fileNestedPath ?? resolved.nestedPath,
                                ...(resolved.tabularSection ? { scopedTabularSectionName: resolved.tabularSection } : {}),
                            }
                        );
                    } else {
                        await XMLWriter.writeProperties(filePath, { Type: typeProperty });
                    }
                },
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getSource / setSource (EventSubscription)
    // ─────────────────────────────────────────────────────────────────────────

    async getSource(params: GetSourceParams): Promise<AgentResult<GetSourceResult>> {
        try {
            const resolved = await this.context.resolveEventSubscriptionPath(params.path);
            const properties = await XMLWriter.readProperties(resolved.filePath);
            const source = properties['Source'];
            if (source === undefined || source === null || source === '') {
                return { success: true, data: { types: [], rawXml: '' } };
            }

            let definition: ReturnType<typeof ObjectTypeParser.parseStrict>;
            if (typeof source === 'string') {
                if (!source.trim().startsWith('<')) {
                    throw new Error('Source имеет неожиданное строковое значение.');
                }
                definition = ObjectTypeParser.parseStrict(source);
            } else {
                definition = ObjectTypeParser.parseStrictFromObject(source);
            }
            const rawXml = typeof source === 'string' && source.trim().startsWith('<')
                ? source
                : ObjectTypeSerializer.serialize(definition);
            const types = definition.types.map(({ objectKind, objectName }) => objectName
                ? `cfg:${objectKind}.${objectName}`
                : `cfg:${objectKind}`);
            return { success: true, data: { types, rawXml } };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    async setSource(params: SetSourceParams): Promise<AgentResult<MutationResultData>> {
        try {
            const resolved = await this.context.resolveEventSubscriptionPath(params.path);
            if (!Array.isArray(params.types)) {
                throw new Error('Parameter types must be an array of cfg:ObjectKind[.Name] strings.');
            }

            const definition = {
                types: params.types.map((value) => {
                    if (typeof value !== 'string') {
                        throw new Error('Every Source type must be a string in cfg:ObjectKind[.Name] format.');
                    }
                    return ObjectTypeParser.parseSingleType(value);
                }),
            };
            await assertCfeGenericMutationAllowed(resolved.filePath, 'update');
            try {
                await fs.promises.access(resolved.filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${resolved.filePath}` };
            }

            return await runAgentMutation(this.context, {
                filePath: resolved.filePath,
                target: params.path,
                options: params,
                plannedChanges: { files: [resolved.filePath], summary: `Изменение источника ${params.path}` },
                apply: async () => {
                    await XMLWriter.writeProperties(resolved.filePath, {
                        Source: ObjectTypeSerializer.serialize(definition),
                    });
                },
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }
}
