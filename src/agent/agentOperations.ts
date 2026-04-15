// src/agent/agentOperations.ts
// Agent API — бизнес-логика без зависимостей от vscode.
// Используется как из agentCommands.ts (VS Code), так и из unit-тестов (mocha).

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { rulesRegistry, metadataConverter } from '../rules';
import { addRootObjectToConfiguration, removeRootObjectFromConfiguration } from '../services/configurationXmlUpdater';
import { getDesignerTemplateXml } from '../services/designerTemplateRepository';
import { substituteDesignerTemplate } from '../services/designerTemplateSubstitutor';
import { injectInternalInfoIntoMetadataXml } from '../utils/xml/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import { generateSimpleUuid } from '../utils/xml/xmlHelpers';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { MetadataType } from '../models/treeNode';

/** Types whose templates include default ChildObjects (Dimension+Resource); rules engine cannot generate those yet. */
const TEMPLATE_ONLY_TYPES = new Set(['InformationRegister', 'AccumulationRegister']);
import { CONFIGURATION_XML } from '../constants/fileNames';
import { resolveAgentPath } from './agentPathResolver';
import { XMLWriter } from '../utils/XMLWriter';
import { TypeParser } from '../parsers/typeParser';
import { TypeSerializer } from '../serializers/typeSerializer';
import type {
    AgentResult,
    CreateObjectParams,
    GetYamlParams,
    ListObjectsParams,
    ObjectInfo,
    GetPropertiesParams,
    AddAttributeParams,
    AddTabularSectionParams,
    AddTabularSectionColumnParams,
    DeleteAttributeParams,
    DeleteTabularSectionParams,
    DeleteObjectParams,
    RenameObjectParams,
    SetPropertiesParams,
    GetTypeParams,
    SetTypeParams,
    GetTypeResult,
} from './types';

// ─── XML-парсер для Configuration.xml (без preserveOrder — нам нужен простой доступ) ───

const configParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
});

// ─── AgentOperations ────────────────────────────────────────────────────────

export class AgentOperations {
    private readonly configRootPath: string;

    constructor(configRootPath: string) {
        this.configRootPath = configRootPath;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createObject
    // ─────────────────────────────────────────────────────────────────────────

    async createObject(params: CreateObjectParams): Promise<AgentResult<{ filePath: string }>> {
        try {
            const { type, name, synonym, properties } = params;

            // Валидация
            if (!type || typeof type !== 'string') {
                return { success: false, error: 'Параметр type обязателен и должен быть строкой.' };
            }
            if (!name || typeof name !== 'string' || !name.trim()) {
                return { success: false, error: 'Параметр name обязателен и не может быть пустым.' };
            }
            const trimmedName = name.trim();

            // Проверяем наличие правил или шаблона
            const rules = !TEMPLATE_ONLY_TYPES.has(type) ? rulesRegistry.get(type) : undefined;
            const templateXml = !rules ? await getDesignerTemplateXml(type) : null;
            if (!rules && templateXml === null) {
                return {
                    success: false,
                    error: `Тип "${type}" не поддерживается. Доступные типы: ${rulesRegistry.allRootTags().join(', ')}`,
                };
            }

            // Определяем папку типа через маппинг, fallback = rootTag + 's'
            const typeFolderName = MetadataTypeMapper.getDesignerFolderIdForMetadataType(type as MetadataType) ?? `${type}s`;
            const typeFolderPath = path.join(this.configRootPath, typeFolderName);
            await fs.promises.mkdir(typeFolderPath, { recursive: true });

            const newFilePath = path.join(typeFolderPath, `${trimmedName}.xml`);

            // Проверяем, что файл не существует
            try {
                await fs.promises.access(newFilePath);
                return { success: false, error: `Объект уже существует: ${newFilePath}` };
            } catch {
                // ENOENT — файл не существует, продолжаем
            }

            let content: string;
            const uuid = generateSimpleUuid();

            if (rules) {
                // Rules-based path
                let ir = metadataConverter.createDefaultIR(rules, { name: trimmedName, uuid });
                const overrides: Record<string, unknown> = {};
                if (synonym !== undefined) {
                    overrides['Synonym'] = synonym;
                }
                if (properties) {
                    Object.assign(overrides, properties);
                }
                if (Object.keys(overrides).length > 0) {
                    ir = metadataConverter.mergeProperties(ir, overrides);
                }
                content = metadataConverter.irToXml(ir, rules);
            } else {
                // Template fallback (registers with default children)
                const uuidDim = generateSimpleUuid();
                const uuidResource = generateSimpleUuid();
                content = substituteDesignerTemplate(templateXml!, {
                    uuid, Name: trimmedName, Synonym_ru: synonym ?? trimmedName,
                    uuidDim, uuidResource,
                });
            }

            content = injectInternalInfoIntoMetadataXml(content, type, trimmedName);
            content = normalizeMetaDataObjectRoot(content);

            await fs.promises.writeFile(newFilePath, content, 'utf-8');

            // Создаём директорию объекта
            const elementDir = path.join(typeFolderPath, trimmedName);
            await fs.promises.mkdir(elementDir, { recursive: true });

            // Регистрируем в Configuration.xml
            await addRootObjectToConfiguration(this.configRootPath, type, trimmedName);

            return { success: true, data: { filePath: newFilePath } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getYaml
    // ─────────────────────────────────────────────────────────────────────────

    async getYaml(params: GetYamlParams): Promise<AgentResult<{ yaml: string }>> {
        try {
            const { path: objectPath } = params;

            if (!objectPath || typeof objectPath !== 'string') {
                return { success: false, error: 'Параметр path обязателен.' };
            }

            // Парсим путь вида 'Catalog.Товары'
            const dotIdx = objectPath.indexOf('.');
            if (dotIdx === -1) {
                return { success: false, error: 'Параметр path должен быть вида "Тип.Имя", например "Catalog.Товары".' };
            }
            const type = objectPath.slice(0, dotIdx);
            const name = objectPath.slice(dotIdx + 1);

            if (!type || !name) {
                return { success: false, error: 'Некорректный путь: тип или имя объекта пустые.' };
            }

            const rules = rulesRegistry.get(type);
            if (!rules) {
                return {
                    success: false,
                    error: `Тип "${type}" не поддерживается Rules Engine. Доступные типы: ${rulesRegistry.allRootTags().join(', ')}`,
                };
            }

            // Ищем XML-файл
            const typeFolderName = `${type}s`;
            const xmlFilePath = path.join(this.configRootPath, typeFolderName, `${name}.xml`);

            let xmlContent: string;
            try {
                xmlContent = await fs.promises.readFile(xmlFilePath, 'utf-8');
            } catch {
                return { success: false, error: `XML-файл не найден: ${xmlFilePath}` };
            }

            const ir = metadataConverter.xmlToIr(xmlContent, rules);
            const yaml = metadataConverter.irToYaml(ir, rules);

            return { success: true, data: { yaml } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getProperties
    // ─────────────────────────────────────────────────────────────────────────

    async getProperties(params: GetPropertiesParams): Promise<AgentResult<{ properties: Record<string, unknown> }>> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            let properties: Record<string, unknown>;
            if (resolved.nestedType && resolved.nestedName) {
                properties = await XMLWriter.readNestedElementProperties(filePath, resolved.nestedType, resolved.nestedName);
            } else {
                properties = await XMLWriter.readProperties(filePath);
            }
            return { success: true, data: { properties } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // listObjects
    // ─────────────────────────────────────────────────────────────────────────

    async listObjects(params: ListObjectsParams): Promise<AgentResult<{ objects: ObjectInfo[] }>> {
        try {
            const configPath = path.join(this.configRootPath, CONFIGURATION_XML);

            let xmlContent: string;
            try {
                xmlContent = await fs.promises.readFile(configPath, 'utf-8');
            } catch {
                return { success: false, error: `Configuration.xml не найден: ${configPath}` };
            }

            let parsed: unknown;
            try {
                parsed = configParser.parse(xmlContent);
            } catch (parseErr) {
                return {
                    success: false,
                    error: `Ошибка парсинга Configuration.xml: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                };
            }

            // Извлекаем ChildObjects
            const childObjects = extractChildObjects(parsed);
            if (!childObjects) {
                return { success: true, data: { objects: [] } };
            }

            const filterType = params.type;
            const objects: ObjectInfo[] = [];

            for (const [tagName, names] of Object.entries(childObjects)) {
                if (filterType && tagName !== filterType) {
                    continue;
                }
                const nameList = Array.isArray(names) ? names : [names];
                for (const nameEntry of nameList) {
                    const objectName = typeof nameEntry === 'string'
                        ? nameEntry
                        : (nameEntry as Record<string, unknown>)['#text'] as string ?? String(nameEntry);
                    if (!objectName) {continue;}

                    const typeFolderName = `${tagName}s`;
                    const filePath = path.join(this.configRootPath, typeFolderName, `${objectName}.xml`);
                    objects.push({ type: tagName, name: objectName, filePath });
                }
            }

            return { success: true, data: { objects } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteAttribute
    // ─────────────────────────────────────────────────────────────────────────

    async deleteAttribute(params: DeleteAttributeParams): Promise<AgentResult> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            const segments = params.path.split('.');
            if (segments.length === 4) {
                // RootTag.ObjectName.Attribute.AttrName
                await XMLWriter.removeNestedElement(filePath, 'Attribute', resolved.nestedName!);
            } else if (segments.length === 6) {
                // RootTag.ObjectName.TabularSection.TSName.Attribute.ColName
                await XMLWriter.removeAttributeFromTabularSection(filePath, resolved.tabularSection!, resolved.nestedName!);
            } else {
                return { success: false, error: `Некорректный путь для deleteAttribute: "${params.path}". Ожидается 4 или 6 сегментов.` };
            }

            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteTabularSection
    // ─────────────────────────────────────────────────────────────────────────

    async deleteTabularSection(params: DeleteTabularSectionParams): Promise<AgentResult> {
        try {
            const segments = params.path.split('.');
            if (segments.length !== 4 || segments[2] !== 'TabularSection') {
                return { success: false, error: `Неверный path для deleteTabularSection: "${params.path}". Ожидается формат: RootTag.ObjectName.TabularSection.TSName` };
            }

            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await XMLWriter.removeNestedElement(filePath, 'TabularSection', resolved.nestedName!);
            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteObject
    // ─────────────────────────────────────────────────────────────────────────

    async deleteObject(params: DeleteObjectParams): Promise<AgentResult> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { rootTag, objectName, filePath } = resolved;

            const folderName =
                MetadataTypeMapper.getDesignerFolderIdForMetadataType(rootTag as MetadataType) ??
                `${rootTag}s`;
            const typeFolderPath = path.join(this.configRootPath, folderName);

            // Удаляем XML-файл объекта
            try {
                await fs.promises.unlink(filePath);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    return { success: false, error: `Файл объекта не найден: ${filePath}` };
                }
                throw err;
            }

            // Удаляем директорию объекта если есть
            const elementDir = path.join(typeFolderPath, objectName);
            await fs.promises.rm(elementDir, { recursive: true, force: true });

            // Снимаем регистрацию из Configuration.xml
            await removeRootObjectFromConfiguration(this.configRootPath, rootTag, objectName);

            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // renameObject
    // ─────────────────────────────────────────────────────────────────────────

    async renameObject(params: RenameObjectParams): Promise<AgentResult<{ filePath: string }>> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { rootTag, objectName, filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            const folderName =
                MetadataTypeMapper.getDesignerFolderIdForMetadataType(rootTag as MetadataType) ??
                `${rootTag}s`;
            const typeFolderPath = path.join(this.configRootPath, folderName);

            // Обновляем Name в XML
            await XMLWriter.writeProperties(filePath, { Name: params.newName });

            // Переименовываем XML-файл
            const newFilePath = path.join(typeFolderPath, `${params.newName}.xml`);
            await fs.promises.rename(filePath, newFilePath);

            // Переименовываем директорию объекта если есть
            const oldDir = path.join(typeFolderPath, objectName);
            const newDir = path.join(typeFolderPath, params.newName);
            try {
                await fs.promises.access(oldDir);
                await fs.promises.rename(oldDir, newDir);
            } catch {
                // Директории нет — ок
            }

            // Обновляем Configuration.xml
            await removeRootObjectFromConfiguration(this.configRootPath, rootTag, objectName);
            await addRootObjectToConfiguration(this.configRootPath, rootTag, params.newName);

            return { success: true, data: { filePath: newFilePath } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addAttribute
    // ─────────────────────────────────────────────────────────────────────────

    async addAttribute(params: AddAttributeParams): Promise<AgentResult> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath, rootTag, objectName } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await XMLWriter.addNestedElement(filePath, 'Attribute', params.name, {}, rootTag as MetadataType, objectName);
            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addTabularSection
    // ─────────────────────────────────────────────────────────────────────────

    async addTabularSection(params: AddTabularSectionParams): Promise<AgentResult> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath, rootTag, objectName } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await XMLWriter.addNestedElement(filePath, 'TabularSection', params.name, {}, rootTag as MetadataType, objectName);
            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addTabularSectionColumn
    // ─────────────────────────────────────────────────────────────────────────

    async addTabularSectionColumn(params: AddTabularSectionColumnParams): Promise<AgentResult> {
        try {
            const segments = params.path.split('.');
            if (segments.length !== 4 || segments[2] !== 'TabularSection') {
                return {
                    success: false,
                    error: `Некорректный путь для addTabularSectionColumn: "${params.path}". Ожидается 4 сегмента вида RootTag.ObjectName.TabularSection.TSName.`,
                };
            }
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath, rootTag, objectName, nestedName } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await XMLWriter.addAttributeToTabularSection(filePath, nestedName!, params.name, rootTag as MetadataType, objectName);
            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setProperties
    // ─────────────────────────────────────────────────────────────────────────

    async setProperties(params: SetPropertiesParams): Promise<AgentResult> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            if ('Name' in params.properties) {
                return { success: false, error: 'Нельзя менять Name через setProperties. Используйте renameObject.' };
            }

            const props = this.normalizeTypeProperty(params.properties);

            if (resolved.nestedType && resolved.nestedName) {
                await XMLWriter.writeNestedElementProperties(filePath, resolved.nestedType, resolved.nestedName, props);
            } else {
                await XMLWriter.writeProperties(filePath, props);
            }
            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
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
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            let properties: Record<string, unknown>;
            if (resolved.nestedType && resolved.nestedName) {
                properties = await XMLWriter.readNestedElementProperties(filePath, resolved.nestedType, resolved.nestedName);
            } else {
                properties = await XMLWriter.readProperties(filePath);
            }

            const typeVal = properties['Type'];

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
                        return 'xs:dateTime';
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

    async setType(params: SetTypeParams): Promise<AgentResult> {
        try {
            const resolved = resolveAgentPath(this.configRootPath, params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            // Строим TypeDefinition из массива строк
            const typeEntries = params.types.map(typeStr => {
                if (typeStr === 'xs:string') { return { kind: 'string' as const }; }
                if (typeStr === 'xs:decimal') { return { kind: 'number' as const }; }
                if (typeStr === 'xs:boolean') { return { kind: 'boolean' as const }; }
                if (typeStr === 'xs:date' || typeStr === 'xs:dateTime' || typeStr === 'xs:time') {
                    return { kind: 'date' as const };
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

            const definition = { category, types: typeEntries };
            const xml = TypeSerializer.serialize(definition);

            if (resolved.nestedType && resolved.nestedName) {
                await XMLWriter.writeNestedElementProperties(filePath, resolved.nestedType, resolved.nestedName, { Type: xml });
            } else {
                await XMLWriter.writeProperties(filePath, { Type: xml });
            }

            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
}

// ─── Хелпер: извлечь ChildObjects из распарсенного Configuration.xml ────────

function extractChildObjects(parsed: unknown): Record<string, unknown> | null {
    if (!parsed || typeof parsed !== 'object') {return null;}
    const root = parsed as Record<string, unknown>;

    // Структура: { MetaDataObject: { Configuration: { ChildObjects: { Catalog: [...], ... } } } }
    const metaDataObject = root['MetaDataObject'];
    if (!metaDataObject || typeof metaDataObject !== 'object') {return null;}

    const configuration = (metaDataObject as Record<string, unknown>)['Configuration'];
    if (!configuration || typeof configuration !== 'object') {return null;}

    const childObjects = (configuration as Record<string, unknown>)['ChildObjects'];
    if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
        return null;
    }
    return childObjects as Record<string, unknown>;
}
