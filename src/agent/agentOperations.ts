// src/agent/agentOperations.ts
// Agent API — бизнес-логика без зависимостей от vscode.
// Используется как из agentCommands.ts (VS Code), так и из unit-тестов (mocha).

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { rulesRegistry, metadataConverter } from '../rules';
import {
    addRootObjectToConfiguration,
    buildRootObjectConfigurationContent,
    removeRootObjectFromConfiguration,
} from '../services/configurationXmlUpdater';
import { getDesignerTemplateXml } from '../services/designerTemplateRepository';
import { substituteDesignerTemplate } from '../services/designerTemplateSubstitutor';
import { injectInternalInfoIntoMetadataXml } from '../utils/xml/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import { requireProjectWriteFormatProfile } from '../utils/format/formatRank';
import { generateSimpleUuid } from '../utils/xml/xmlHelpers';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { MetadataType } from '../models/treeNode';
import { validateElementName } from '../utils/elementNameValidator';
import { assertPathWithinRoot } from '../services/configurationSession/pathBoundary';
import {
    assertCfeGenericCreateAllowed,
    assertCfeGenericMutationAllowed,
    CfeFilesystemMutationPolicyResolver,
} from '../extensionSupport/cfeProject/mutationPolicy';
import { CfeOwnershipError, type CfeObjectIdentity } from '../extensionSupport/cfeProject/ownership';
import { getMetadataTypeDescriptorByRootTag } from '../constants/metadataTypeDescriptors';
import { hashContent } from '../services/configurationSession/atomicFileStorage';
import type { MutationExpectation, MutationPlan, MutationStep } from '../services/configurationSession/mutationPlan';

/** Types whose templates include default ChildObjects (Dimension+Resource); rules engine cannot generate those yet. */
const TEMPLATE_ONLY_TYPES = new Set(['InformationRegister', 'AccumulationRegister']);
import { CONFIGURATION_XML } from '../constants/fileNames';
import { AgentPathError, resolveAgentPath } from './agentPathResolver';
import { XMLWriter } from '../utils/XMLWriter';
import { TypeParser } from '../parsers/typeParser';
import { TypeSerializer } from '../serializers/typeSerializer';
import { ObjectTypeParser } from '../parsers/objectTypeParser';
import { ObjectTypeSerializer } from '../serializers/objectTypeSerializer';
import type {
    AgentResult,
    CreateObjectParams,
    GetYamlParams,
    ListObjectsParams,
    ListChildrenParams,
    MetadataChildInfo,
    ObjectInfo,
    GetPropertiesResult,
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
    GetSourceParams,
    SetSourceParams,
    GetSourceResult,
} from './types';

// ─── XML-парсер для Configuration.xml (без preserveOrder — нам нужен простой доступ) ───

const configParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
});

function xmlValuesByLocalName(record: Record<string, unknown>, expectedName: string): unknown[] {
    return Object.entries(record)
        .filter(([key]) => key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) === expectedName : key === expectedName)
        .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

function xmlRecords(value: unknown): Record<string, unknown>[] {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    );
}

function firstXmlRecord(record: Record<string, unknown>, expectedName: string): Record<string, unknown> | undefined {
    return xmlValuesByLocalName(record, expectedName).flatMap(xmlRecords)[0];
}

function xmlText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') {
        return String(value).trim();
    }
    if (Array.isArray(value)) {
        return value.length > 0 ? xmlText(value[0]) : '';
    }
    if (value && typeof value === 'object') {
        return xmlText((value as Record<string, unknown>)['#text']);
    }
    return '';
}

async function readValidatedMetadataDocument(
    filePath: string,
    expectedRootType: string,
    expectedName: string,
): Promise<Record<string, unknown>> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const validation = XMLValidator.validate(content);
    if (validation !== true) {
        const details = typeof validation === 'object' && validation !== null ? validation.err.msg : 'invalid XML';
        throw new Error(`Некорректный XML-файл ${filePath}: ${details}`);
    }

    const parsed = configParser.parse(content);
    const metadataObject = firstXmlRecord(parsed as Record<string, unknown>, 'MetaDataObject');
    const roots = metadataObject
        ? xmlValuesByLocalName(metadataObject, expectedRootType).flatMap(xmlRecords)
        : [];
    if (roots.length !== 1) {
        throw new Error(`В файле ${filePath} ожидался один корневой объект ${expectedRootType}.`);
    }

    const properties = firstXmlRecord(roots[0], 'Properties');
    const actualName = properties ? xmlText(xmlValuesByLocalName(properties, 'Name')[0]) : '';
    if (actualName !== expectedName) {
        throw new Error(`В файле ${filePath} ожидался объект ${expectedRootType}.${expectedName}, найден ${actualName || 'объект без имени'}.`);
    }
    return roots[0];
}

function externalDataSourceTableNames(root: Record<string, unknown>): string[] {
    const childObjects = firstXmlRecord(root, 'ChildObjects');
    if (!childObjects) {
        return [];
    }
    return xmlValuesByLocalName(childObjects, 'Table').map(xmlText).filter(Boolean);
}

const cfeReadPolicyResolver = new CfeFilesystemMutationPolicyResolver();

function mutationFailure(error: unknown): AgentResult<never> {
    return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof CfeOwnershipError ? { code: error.code } : {}),
    };
}

// ─── AgentOperations ────────────────────────────────────────────────────────

export class AgentOperations {
    private readonly configRootPath: string;

    constructor(configRootPath: string) {
        this.configRootPath = configRootPath;
    }

    /** Builds the serializable multi-file create plan without applying filesystem effects. */
    async planCreateObject(params: CreateObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        const { type, name, synonym, properties } = params;
        if (!type || typeof type !== 'string') {
            throw new Error('Parameter type is required and must be a string.');
        }
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new Error('Parameter name is required and cannot be empty.');
        }
        const trimmedName = name.trim();
        await assertCfeGenericCreateAllowed(this.configRootPath, trimmedName, { isRootObjectCreate: true });
        const typeValidation = validateElementName(type, []);
        if (typeValidation) { throw new Error(`Invalid type "${type}": ${typeValidation}`); }
        const rules = !TEMPLATE_ONLY_TYPES.has(type) ? rulesRegistry.get(type) : undefined;
        const templateXml = !rules ? await getDesignerTemplateXml(type) : null;
        if (!rules && templateXml === null) {
            throw new Error(`Type "${type}" is not supported.`);
        }
        const folderName = MetadataTypeMapper.getDesignerFolderIdForMetadataType(type as MetadataType) ?? `${type}s`;
        const folderPath = path.join(this.configRootPath, folderName);
        const validation = validateElementName(trimmedName, await listXmlSiblingNames(folderPath));
        if (validation) { throw new Error(validation); }
        const filePath = path.join(folderPath, `${trimmedName}.xml`);
        const elementDir = path.join(folderPath, trimmedName);
        const fileExpected = await expectationForPath(filePath);
        if (fileExpected.state !== 'missing') { throw new Error(`Object already exists: ${filePath}`); }
        const directoryExpected = await expectationForPath(elementDir);
        if (directoryExpected.state !== 'missing') { throw new Error(`Object directory already exists: ${elementDir}`); }

        const uuid = generateSimpleUuid();
        let content: string;
        if (rules) {
            let ir = metadataConverter.createDefaultIR(rules, { name: trimmedName, uuid });
            const overrides: Record<string, unknown> = {};
            if (synonym !== undefined) { overrides['Synonym'] = synonym; }
            if (properties) { Object.assign(overrides, properties); }
            if (Object.keys(overrides).length > 0) { ir = metadataConverter.mergeProperties(ir, overrides); }
            content = metadataConverter.irToXml(ir, rules);
        } else {
            content = substituteDesignerTemplate(templateXml!, {
                uuid,
                Name: trimmedName,
                Synonym_ru: synonym ?? trimmedName,
                uuidDim: generateSimpleUuid(),
                uuidResource: generateSimpleUuid(),
            });
        }
        const configurationPath = path.join(this.configRootPath, CONFIGURATION_XML);
        const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
        const targetVersion = requireProjectWriteFormatProfile(configurationContent).version;
        content = normalizeMetaDataObjectRoot(injectInternalInfoIntoMetadataXml(content, type, trimmedName), targetVersion);
        const nextConfigurationContent = buildRootObjectConfigurationContent(configurationContent, {
            type: 'add', rootTag: type, objectName: trimmedName,
        });
        return {
            kind: 'agent.createObject',
            steps: [
                { type: 'ensureDirectory', targetPath: folderPath },
                { type: 'writeFile', targetPath: filePath, content, encoding: 'utf8', expected: fileExpected },
                { type: 'ensureDirectory', targetPath: elementDir },
                {
                    type: 'writeFile',
                    targetPath: configurationPath,
                    content: nextConfigurationContent,
                    encoding: 'utf8',
                    expected: { state: 'file', hash: hashContent(configurationContent) },
                },
            ],
            result: { success: true, data: { filePath } },
        };
    }

    /** Builds the serializable multi-file delete plan without applying filesystem effects. */
    async planDeleteObject(params: DeleteObjectParams): Promise<MutationPlan<AgentResult>> {
        if (params.path.split('.').length !== 2) {
            throw new AgentPathError('INVALID_AGENT_PATH', `deleteObject supports only a root object path: "${params.path}".`);
        }
        const { rootTag, objectName, filePath } = await this.resolveContainedAgentPath(params.path);
        await assertCfeGenericMutationAllowed(filePath, 'delete');
        const fileExpected = await expectationForPath(filePath);
        if (fileExpected.state !== 'file') { throw new Error(`Object file not found: ${filePath}`); }
        const folderName = MetadataTypeMapper.getDesignerFolderIdForMetadataType(rootTag as MetadataType) ?? `${rootTag}s`;
        const elementDir = path.join(this.configRootPath, folderName, objectName);
        const directoryExpected = await expectationForPath(elementDir);
        const configurationPath = path.join(this.configRootPath, CONFIGURATION_XML);
        const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
        const steps: MutationStep[] = [
            { type: 'deletePath', targetPath: filePath, expected: fileExpected },
        ];
        if (directoryExpected.state !== 'missing') {
            steps.push({ type: 'deletePath', targetPath: elementDir, expected: directoryExpected });
        }
        steps.push({
            type: 'writeFile',
            targetPath: configurationPath,
            content: buildRootObjectConfigurationContent(configurationContent, {
                type: 'remove', rootTag, objectName,
            }),
            encoding: 'utf8',
            expected: { state: 'file', hash: hashContent(configurationContent) },
        });
        return { kind: 'agent.deleteObject', steps, result: { success: true } };
    }

    /** Builds the serializable multi-file rename plan without applying filesystem effects. */
    async planRenameObject(params: RenameObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        const segmentCount = typeof params.path === 'string' ? params.path.split('.').length : 0;
        if (segmentCount !== 2) {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `renameObject supports only a root object path (RootTag.Name): "${String(params.path)}".`,
            );
        }
        const resolved = await this.resolveContainedAgentPath(params.path);
        if (resolved.nestedType !== undefined || resolved.tabularSection !== undefined) {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `renameObject does not support nested metadata paths: "${params.path}".`,
            );
        }
        const { rootTag, objectName, filePath } = resolved;
        await assertCfeGenericMutationAllowed(filePath, 'rename');
        const sourceExpected = await expectationForPath(filePath);
        if (sourceExpected.state !== 'file') { throw new Error(`Object file not found: ${filePath}`); }
        const folderName = MetadataTypeMapper.getDesignerFolderIdForMetadataType(rootTag as MetadataType) ?? `${rootTag}s`;
        const folderPath = path.join(this.configRootPath, folderName);
        const newName = params.newName?.trim();
        const validation = validateElementName(
            newName,
            (await listXmlSiblingNames(folderPath)).filter(
                (sibling) => sibling.toLocaleLowerCase() !== objectName.toLocaleLowerCase(),
            ),
        );
        if (validation) { throw new Error(validation); }
        const newFilePath = path.join(folderPath, `${newName}.xml`);
        const targetExpected = await expectationForPath(newFilePath);
        if (targetExpected.state !== 'missing') { throw new Error(`Object already exists: ${newFilePath}`); }
        const oldDir = path.join(folderPath, objectName);
        const newDir = path.join(folderPath, newName);
        const oldDirExpected = await expectationForPath(oldDir);
        const newDirExpected = await expectationForPath(newDir);
        if (newDirExpected.state !== 'missing') { throw new Error(`Object directory already exists: ${newDir}`); }
        const objectContent = await fs.promises.readFile(filePath, 'utf8');
        const configurationPath = path.join(this.configRootPath, CONFIGURATION_XML);
        const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
        const steps: MutationStep[] = [
            {
                type: 'writeFile', targetPath: filePath,
                content: XMLWriter.buildUpdatedPropertiesXml(objectContent, { Name: newName }),
                encoding: 'utf8', expected: sourceExpected,
            },
            {
                type: 'movePath', sourcePath: filePath, targetPath: newFilePath,
                sourceExpected: { state: 'file', hash: hashContent(XMLWriter.buildUpdatedPropertiesXml(objectContent, { Name: newName })) },
                targetExpected,
            },
        ];
        if (oldDirExpected.state !== 'missing') {
            steps.push({
                type: 'movePath', sourcePath: oldDir, targetPath: newDir,
                sourceExpected: oldDirExpected, targetExpected: newDirExpected,
            });
        }
        steps.push({
            type: 'writeFile', targetPath: configurationPath,
            content: buildRootObjectConfigurationContent(configurationContent, {
                type: 'rename', rootTag, objectName, newName,
            }),
            encoding: 'utf8', expected: { state: 'file', hash: hashContent(configurationContent) },
        });
        return { kind: 'agent.renameObject', steps, result: { success: true, data: { filePath: newFilePath } } };
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
            await assertCfeGenericCreateAllowed(this.configRootPath, trimmedName, { isRootObjectCreate: true });
            const typeValidation = validateElementName(type, []);
            if (typeValidation) {
                return { success: false, error: `Некорректный type "${type}": ${typeValidation}` };
            }

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
            const cfgXml = await fs.promises.readFile(path.join(this.configRootPath, CONFIGURATION_XML), 'utf8');
            const targetVersion = requireProjectWriteFormatProfile(cfgXml).version;
            const nameValidation = validateElementName(trimmedName, await listXmlSiblingNames(typeFolderPath));
            if (nameValidation) {
                return { success: false, error: nameValidation };
            }
            await assertPathWithinRoot(this.configRootPath, typeFolderPath);
            await fs.promises.mkdir(typeFolderPath, { recursive: true });

            const newFilePath = path.join(typeFolderPath, `${trimmedName}.xml`);
            await assertPathWithinRoot(this.configRootPath, newFilePath);

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
            content = normalizeMetaDataObjectRoot(content, targetVersion);

            await assertPathWithinRoot(this.configRootPath, newFilePath);
            await fs.promises.writeFile(newFilePath, content, 'utf-8');

            // Создаём директорию объекта
            const elementDir = path.join(typeFolderPath, trimmedName);
            await assertPathWithinRoot(this.configRootPath, elementDir);
            await fs.promises.mkdir(elementDir, { recursive: true });

            // Регистрируем в Configuration.xml
            await addRootObjectToConfiguration(this.configRootPath, type, trimmedName);

            return { success: true, data: { filePath: newFilePath } };
        } catch (err) {
            return mutationFailure(err);
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

            if (type === MetadataType.ExternalDataSource && objectPath.split('.').length !== 2) {
                return { success: false, error: 'getYaml поддерживает только корневой путь ExternalDataSource. Для таблиц используйте getProperties.' };
            }

            // Ищем XML-файл
            const xmlFilePath = (await this.resolveContainedAgentPath(`${type}.${name}`)).filePath;

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
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getProperties
    // ─────────────────────────────────────────────────────────────────────────

    async getProperties(params: GetPropertiesParams): Promise<AgentResult<GetPropertiesResult>> {
        try {
            const resolved = await this.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.validateExternalDataSourcePath(resolved);

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

            const cfePolicy = await cfeReadPolicyResolver.resolve(this.configRootPath);
            const filterType = params.type;
            const normalizedQuery = params.query?.trim().toLocaleLowerCase();
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
                    if (normalizedQuery && !objectName.toLocaleLowerCase().includes(normalizedQuery)) {
                        continue;
                    }

                    const typeFolderName = getMetadataTypeDescriptorByRootTag(tagName)?.designerFolder ?? `${tagName}s`;
                    const filePath = path.join(this.configRootPath, typeFolderName, `${objectName}.xml`);
                    const cfeFields = cfePolicy
                        ? ownershipFields(await cfeReadPolicyResolver.resolveObjectIdentity(cfePolicy, filePath))
                        : {};
                    objects.push({ type: tagName, name: objectName, filePath, ...cfeFields });
                }
            }

            return { success: true, data: { objects } };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    /** Lists supported named inline ChildObjects for a root or nested metadata element. */
    async listChildren(params: ListChildrenParams): Promise<AgentResult<{ children: MetadataChildInfo[] }>> {
        try {
            const resolved = await this.resolveContainedAgentPath(params.path);
            try {
                await fs.promises.access(resolved.filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${resolved.filePath}` };
            }
            const validatedRoot = await this.validateExternalDataSourcePath(resolved);
            const parentPath = resolved.fileNestedPath
                ?? resolved.nestedPath
                ?? [{ type: resolved.rootTag, name: resolved.objectName }];
            const children = await XMLWriter.listNestedMetadataChildren(resolved.filePath, parentPath);
            const publicChildren = children.map((child) => {
                const childPath = resolved.fileRootType && resolved.nestedPath
                    ? [resolved.nestedPath[0]!, ...child.path]
                    : child.path;
                if (resolved.rootTag === MetadataType.ExternalDataSource && validateElementName(child.name, [])) {
                    throw new Error(`Некорректное имя вложенного элемента ExternalDataSource: "${child.name}".`);
                }
                return {
                    type: child.type,
                    name: child.name,
                    path: childPath.map((segment) => `${segment.type}.${segment.name}`).join('.'),
                };
            });
            if (resolved.rootTag === MetadataType.ExternalDataSource && !resolved.nestedPath && validatedRoot) {
                const tableChildren = externalDataSourceTableNames(validatedRoot).map((name) => {
                    const nameError = validateElementName(name, []);
                    if (nameError) {
                        throw new Error(`Некорректное имя таблицы ExternalDataSource: "${name}": ${nameError}`);
                    }
                    return {
                        type: 'Table',
                        name,
                        path: `${resolved.rootTag}.${resolved.objectName}.Table.${name}`,
                    };
                });
                return { success: true, data: { children: [...tableChildren, ...publicChildren] } };
            }
            return {
                success: true,
                data: { children: publicChildren },
            };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteAttribute
    // ─────────────────────────────────────────────────────────────────────────

    async deleteAttribute(params: DeleteAttributeParams): Promise<AgentResult> {
        try {
            const resolved = await this.resolveContainedAgentPath(params.path);
            if (resolved.rootTag === MetadataType.ExternalDataSource) {
                return { success: false, error: 'deleteAttribute не поддерживает поля таблиц ExternalDataSource.' };
            }
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'delete');

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
            return mutationFailure(err);
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

            const resolved = await this.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'delete');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await XMLWriter.removeNestedElement(filePath, 'TabularSection', resolved.nestedName!);
            return { success: true };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteObject
    // ─────────────────────────────────────────────────────────────────────────

    async deleteObject(params: DeleteObjectParams): Promise<AgentResult> {
        try {
            if (params.path.split('.').length !== 2) {
                return { success: false, error: `deleteObject принимает только корневой путь объекта: "${params.path}".` };
            }
            const resolved = await this.resolveContainedAgentPath(params.path);
            const { rootTag, objectName, filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'delete');

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
            await assertPathWithinRoot(this.configRootPath, elementDir);
            await fs.promises.rm(elementDir, { recursive: true, force: true });

            // Снимаем регистрацию из Configuration.xml
            await removeRootObjectFromConfiguration(this.configRootPath, rootTag, objectName);

            return { success: true };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // renameObject
    // ─────────────────────────────────────────────────────────────────────────

    async renameObject(params: RenameObjectParams): Promise<AgentResult<{ filePath: string }>> {
        try {
            if (params.path.split('.').length !== 2) {
                return { success: false, error: `renameObject принимает только корневой путь объекта: "${params.path}".` };
            }
            const resolved = await this.resolveContainedAgentPath(params.path);
            const { rootTag, objectName, filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'rename');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            const folderName =
                MetadataTypeMapper.getDesignerFolderIdForMetadataType(rootTag as MetadataType) ??
                `${rootTag}s`;
            const typeFolderPath = path.join(this.configRootPath, folderName);

            const newName = params.newName?.trim();
            const nameValidation = validateElementName(
                newName,
                (await listXmlSiblingNames(typeFolderPath)).filter(
                    (name) => name.toLocaleLowerCase() !== objectName.toLocaleLowerCase(),
                ),
            );
            if (nameValidation) {
                return { success: false, error: nameValidation };
            }

            const newFilePath = path.join(typeFolderPath, `${newName}.xml`);
            const oldDir = path.join(typeFolderPath, objectName);
            const newDir = path.join(typeFolderPath, newName);
            await Promise.all([
                assertPathWithinRoot(this.configRootPath, newFilePath),
                assertPathWithinRoot(this.configRootPath, oldDir),
                assertPathWithinRoot(this.configRootPath, newDir),
            ]);

            // Обновляем Name в XML
            await XMLWriter.writeProperties(filePath, { Name: newName });

            // Переименовываем XML-файл
            await fs.promises.rename(filePath, newFilePath);

            // Переименовываем директорию объекта если есть
            try {
                await fs.promises.access(oldDir);
                await fs.promises.rename(oldDir, newDir);
            } catch {
                // Директории нет — ок
            }

            // Обновляем Configuration.xml
            await removeRootObjectFromConfiguration(this.configRootPath, rootTag, objectName);
            await addRootObjectToConfiguration(this.configRootPath, rootTag, newName);

            return { success: true, data: { filePath: newFilePath } };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addAttribute
    // ─────────────────────────────────────────────────────────────────────────

    async addAttribute(params: AddAttributeParams): Promise<AgentResult> {
        try {
            const resolved = await this.resolveContainedAgentPath(params.path);
            if (resolved.rootTag === MetadataType.ExternalDataSource) {
                return { success: false, error: 'addAttribute не поддерживает ExternalDataSource; используйте Fields таблицы.' };
            }
            const { filePath, rootTag, objectName } = resolved;
            await assertCfeGenericCreateAllowed(filePath, params.name, {
                isRootObjectCreate: false,
                ownerMetadataXmlPath: filePath,
            });

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            const nameValidation = validateElementName(
                params.name,
                await XMLWriter.listNestedElementNames(filePath, 'Attribute'),
            );
            if (nameValidation) {
                return { success: false, error: nameValidation };
            }
            await XMLWriter.addNestedElement(filePath, 'Attribute', params.name.trim(), {}, rootTag as MetadataType, objectName);
            return { success: true };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addTabularSection
    // ─────────────────────────────────────────────────────────────────────────

    async addTabularSection(params: AddTabularSectionParams): Promise<AgentResult> {
        try {
            const resolved = await this.resolveContainedAgentPath(params.path);
            if (resolved.rootTag === MetadataType.ExternalDataSource) {
                return { success: false, error: 'addTabularSection не поддерживает ExternalDataSource.' };
            }
            const { filePath, rootTag, objectName } = resolved;
            await assertCfeGenericCreateAllowed(filePath, params.name, {
                isRootObjectCreate: false,
                ownerMetadataXmlPath: filePath,
            });

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            const nameValidation = validateElementName(
                params.name,
                await XMLWriter.listNestedElementNames(filePath, 'TabularSection'),
            );
            if (nameValidation) {
                return { success: false, error: nameValidation };
            }
            await XMLWriter.addNestedElement(filePath, 'TabularSection', params.name.trim(), {}, rootTag as MetadataType, objectName);
            return { success: true };
        } catch (err) {
            return mutationFailure(err);
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
            const resolved = await this.resolveContainedAgentPath(params.path);
            const { filePath, rootTag, objectName, nestedName } = resolved;
            await assertCfeGenericCreateAllowed(filePath, params.name, {
                isRootObjectCreate: false,
                ownerMetadataXmlPath: filePath,
            });

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            const nameValidation = validateElementName(
                params.name,
                await XMLWriter.listNestedElementNames(filePath, 'Attribute', nestedName),
            );
            if (nameValidation) {
                return { success: false, error: nameValidation };
            }
            await XMLWriter.addAttributeToTabularSection(filePath, nestedName!, params.name.trim(), rootTag as MetadataType, objectName);
            return { success: true };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // setProperties
    // ─────────────────────────────────────────────────────────────────────────

    async setProperties(params: SetPropertiesParams): Promise<AgentResult> {
        try {
            const resolved = await this.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'update');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.validateExternalDataSourcePath(resolved);

            if ('Name' in params.properties) {
                return { success: false, error: 'Нельзя менять Name через setProperties. Используйте renameObject.' };
            }

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
            return { success: true };
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
            const resolved = await this.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.validateExternalDataSourcePath(resolved);
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

    async setType(params: SetTypeParams): Promise<AgentResult> {
        try {
            const resolved = await this.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'update');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            await this.validateExternalDataSourcePath(resolved);

            // Строим TypeDefinition из массива строк
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

            return { success: true };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getSource / setSource (EventSubscription)
    // ─────────────────────────────────────────────────────────────────────────

    async getSource(params: GetSourceParams): Promise<AgentResult<GetSourceResult>> {
        try {
            const resolved = await this.resolveEventSubscriptionPath(params.path);
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

    async setSource(params: SetSourceParams): Promise<AgentResult> {
        try {
            const resolved = await this.resolveEventSubscriptionPath(params.path);
            if (!Array.isArray(params.types)) {
                throw new Error('Parameter types must be an array of cfg:ObjectKind[.Name] strings.');
            }

            // Parse the entire request before touching the file so an invalid member cannot cause a partial update.
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

            await XMLWriter.writeProperties(resolved.filePath, {
                Source: ObjectTypeSerializer.serialize(definition),
            });
            return { success: true };
        } catch (err) {
            return mutationFailure(err);
        }
    }

    private async resolveEventSubscriptionPath(agentPath: string): Promise<ReturnType<typeof resolveAgentPath>> {
        const resolved = await this.resolveContainedAgentPath(agentPath);
        if (agentPath.split('.').length !== 2 || resolved.rootTag !== 'EventSubscription') {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `Source supports only an EventSubscription root path (EventSubscription.Name): "${agentPath}".`,
            );
        }
        return resolved;
    }

    private async resolveContainedAgentPath(agentPath: string): Promise<ReturnType<typeof resolveAgentPath>> {
        const resolved = resolveAgentPath(this.configRootPath, agentPath);
        await assertPathWithinRoot(this.configRootPath, resolved.filePath);
        return resolved;
    }

    private async validateExternalDataSourcePath(
        resolved: ReturnType<typeof resolveAgentPath>,
    ): Promise<Record<string, unknown> | undefined> {
        if (resolved.rootTag !== MetadataType.ExternalDataSource) {
            return undefined;
        }
        const expectedRootType = resolved.fileRootType ?? resolved.rootTag;
        const expectedName = resolved.fileRootType
            ? resolved.fileNestedPath?.[0]?.name
            : resolved.objectName;
        if (!expectedName) {
            throw new Error('Не удалось определить корневой объект XML для ExternalDataSource path.');
        }

        if (resolved.fileRootType === 'Table') {
            const tableName = resolved.fileNestedPath?.[0]?.name;
            const sourceFolder = MetadataTypeMapper.getDesignerFolderIdForMetadataType(MetadataType.ExternalDataSource)!;
            const sourcePath = path.join(this.configRootPath, sourceFolder, `${resolved.objectName}.xml`);
            await assertPathWithinRoot(this.configRootPath, sourcePath);
            const sourceRoot = await readValidatedMetadataDocument(
                sourcePath,
                MetadataType.ExternalDataSource,
                resolved.objectName,
            );
            const references = externalDataSourceTableNames(sourceRoot);
            for (const reference of references) {
                const nameError = validateElementName(reference, []);
                if (nameError) {
                    throw new Error(`Некорректное имя таблицы ExternalDataSource: "${reference}": ${nameError}`);
                }
            }
            const referenceCount = references.filter((reference) => reference === tableName).length;
            if (referenceCount !== 1) {
                throw new Error(referenceCount === 0
                    ? `Таблица "${tableName}" не объявлена в ChildObjects источника ExternalDataSource.${resolved.objectName}.`
                    : `Ссылка на таблицу "${tableName}" неоднозначна в ExternalDataSource.${resolved.objectName}.`);
            }
        }

        return readValidatedMetadataDocument(resolved.filePath, expectedRootType, expectedName);
    }
}

async function readCfeOwnershipForRead(
    configurationRoot: string,
    metadataXmlPath: string,
): Promise<Pick<ObjectInfo, 'ownership' | 'sourceUuid'>> {
    const policy = await cfeReadPolicyResolver.resolve(configurationRoot);
    return policy
        ? ownershipFields(await cfeReadPolicyResolver.resolveObjectIdentity(policy, metadataXmlPath))
        : {};
}

function ownershipFields(identity: CfeObjectIdentity): Pick<ObjectInfo, 'ownership' | 'sourceUuid'> {
    return {
        ownership: identity.ownership,
        ...(identity.sourceUuid ? { sourceUuid: identity.sourceUuid } : {}),
    };
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

async function listXmlSiblingNames(typeFolderPath: string): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(typeFolderPath, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.xml'))
            .map((entry) => path.basename(entry.name, path.extname(entry.name)));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function expectationForPath(targetPath: string): Promise<MutationExpectation> {
    try {
        const stat = await fs.promises.lstat(targetPath);
        if (stat.isSymbolicLink()) {
            throw new Error(`Symbolic-link metadata path is forbidden: ${targetPath}`);
        }
        if (stat.isDirectory()) {
            return { state: 'directory' };
        }
        if (stat.isFile()) {
            return { state: 'file', hash: hashContent(await fs.promises.readFile(targetPath)) };
        }
        throw new Error(`Unsupported metadata filesystem entry: ${targetPath}`);
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return { state: 'missing' };
        }
        throw error;
    }
}
