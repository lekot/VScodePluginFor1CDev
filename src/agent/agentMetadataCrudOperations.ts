// src/agent/agentMetadataCrudOperations.ts
// Handles root metadata object CRUD, listing, child inspection, and YAML export for Agent API.

import * as fs from 'fs';
import * as path from 'path';
import { rulesRegistry, metadataConverter } from '../rules';
import { validateElementName } from '../utils/elementNameValidator';
import { assertPathWithinRoot } from '../services/configurationSession/pathBoundary';
import {
    assertCfeGenericCreateAllowed,
    assertCfeGenericMutationAllowed,
} from '../extensionSupport/cfeProject/mutationPolicy';
import {
    getMetadataTypeDescriptorByRootTag,
} from '../constants/metadataTypeDescriptors';
import {
    planCreateMetadataObject,
    planDeleteMetadataObject,
    planDuplicateMetadataObject,
    planRenameMetadataObject,
} from '../services/metadataCrudService';
import { listXmlSiblingNames } from '../services/filesystemReadSemantics';
import {
    MutationPlanExecutor,
    isReadOnlyAssertionStep,
    type MutationPlan,
} from '../services/configurationSession/mutationPlan';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { AgentPathError, parseSourceAddress } from './agentPathResolver';
import { XMLWriter } from '../utils/XMLWriter';
import { MetadataType } from '../models/treeNode';
import { calculateRevision, ZERO_REVISION } from './agentRevision';
import {
    type AgentOperationsContext,
    configParser,
    extractChildObjects,
    externalDataSourceTableNames,
    mutationFailure,
    ownershipFields,
    toAgentCreatePlan,
    toAgentDeletePlan,
    cfeReadPolicyResolver,
} from './agentOperationsShared';
import type {
    AgentResult,
    CreateObjectParams,
    CreateObjectResult,
    DeleteObjectParams,
    DuplicateObjectParams,
    GetYamlParams,
    ListChildrenParams,
    ListObjectsParams,
    MetadataChildInfo,
    MutationResultData,
    ObjectInfo,
    RenameObjectParams,
} from './types';

export class AgentMetadataCrudOperations {
    constructor(private readonly context: AgentOperationsContext) {}

    private get configRootPath(): string {
        return this.context.configRootPath;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // planCreateObject
    // ─────────────────────────────────────────────────────────────────────────

    /** Builds the serializable multi-file create plan without applying filesystem effects. */
    async planCreateObject(params: CreateObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        const { type, name } = params;
        if (!type || typeof type !== 'string') {
            throw new Error('Parameter type is required and must be a string.');
        }
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new Error('Parameter name is required and cannot be empty.');
        }
        const planned = await planCreateMetadataObject(
            { configurationRootPath: this.configRootPath },
            {
                type: type as MetadataType,
                name,
                synonym: params.synonym,
                properties: params.properties,
                chartOfAccounts: params.chartOfAccounts,
                filterCriterion: params.filterCriterion,
                recorderDocument: params.recorderDocument,
            },
        );
        return toAgentCreatePlan(planned.plan);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createObject
    // ─────────────────────────────────────────────────────────────────────────

    async createObject(params: CreateObjectParams): Promise<AgentResult<CreateObjectResult>> {
        try {
            const { type, name } = params;

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

            const descriptor = getMetadataTypeDescriptorByRootTag(type);
            if (!descriptor) {
                return {
                    success: false,
                    error: `Тип "${type}" не поддерживается. Доступные типы: ${rulesRegistry.allRootTags().join(', ')}`,
                };
            }

            const typeFolderPath = path.join(this.configRootPath, descriptor.designerFolder);
            const nameValidation = validateElementName(trimmedName, await listXmlSiblingNames(typeFolderPath));
            if (nameValidation) {
                return { success: false, error: nameValidation };
            }
            const newFilePath = path.join(typeFolderPath, `${trimmedName}.xml`);
            await assertPathWithinRoot(this.configRootPath, newFilePath);

            // Проверяем, что файл не существует
            try {
                await fs.promises.access(newFilePath);
                return { success: false, error: `Объект уже существует: ${newFilePath}` };
            } catch {
                // ENOENT — файл не существует, продолжаем
            }

            return await this.context.withTargetMutationLock(newFilePath, async () => {
                const targetPath = `${type}.${trimmedName}`;
                const check = await this.context.checkMutationPreconditions<CreateObjectResult>(newFilePath, targetPath, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

                const metadataMutation = await planCreateMetadataObject(
                    { configurationRootPath: this.configRootPath },
                    {
                        type: type as MetadataType,
                        name: trimmedName,
                        synonym: params.synonym,
                        properties: params.properties,
                        chartOfAccounts: params.chartOfAccounts,
                        filterCriterion: params.filterCriterion,
                        recorderDocument: params.recorderDocument,
                    },
                );
                const plan = toAgentCreatePlan(metadataMutation.plan);
                const plannedFiles = metadataMutation.impact.affectedPaths;

                if (params.dryRun) {
                    return {
                        success: true,
                        dryRun: true,
                        rev: check.currentRev,
                        target: targetPath,
                        data: {
                            filePath: newFilePath,
                            dryRun: true,
                            rev: check.currentRev,
                            target: targetPath,
                            plannedChanges: {
                                files: plannedFiles.length > 0 ? [...plannedFiles] : [newFilePath, path.join(this.configRootPath, CONFIGURATION_XML)],
                                summary: `Создание объекта ${targetPath}`,
                            },
                        },
                    };
                }

                const executor = new MutationPlanExecutor(this.configRootPath);
                const execResult = await executor.execute(plan);
                if (execResult.success && execResult.data) {
                    const newRev = await calculateRevision(newFilePath);
                    return {
                        ...execResult,
                        rev: newRev,
                        target: targetPath,
                        data: {
                            ...execResult.data,
                            rev: newRev,
                            target: targetPath,
                        },
                    };
                }
                return execResult;
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // planDeleteObject
    // ─────────────────────────────────────────────────────────────────────────

    /** Builds the serializable multi-file delete plan without applying filesystem effects. */
    async planDeleteObject(params: DeleteObjectParams): Promise<MutationPlan<AgentResult>> {
        const { dotPath } = parseSourceAddress(params.path);
        if (dotPath.split('.').length !== 2) {
            throw new AgentPathError('INVALID_AGENT_PATH', `deleteObject supports only a root object path: "${params.path}".`);
        }
        const resolved = await this.context.resolveContainedAgentPath(params.path);
        const planned = await planDeleteMetadataObject(
            { configurationRootPath: this.configRootPath },
            {
                type: resolved.rootTag as MetadataType,
                name: resolved.objectName,
            },
        );
        return toAgentDeletePlan(planned.plan);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteObject
    // ─────────────────────────────────────────────────────────────────────────

    async deleteObject(params: DeleteObjectParams): Promise<AgentResult<MutationResultData>> {
        try {
            const { dotPath } = parseSourceAddress(params.path);
            if (dotPath.split('.').length !== 2) {
                return {
                    success: false,
                    code: 'INVALID_AGENT_PATH',
                    error: `deleteObject принимает только корневой путь объекта: "${params.path}".`,
                };
            }
            const resolved = await this.context.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'delete');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            return await this.context.withTargetMutationLock<MutationResultData>(filePath, async () => {
                const check = await this.context.checkMutationPreconditions<MutationResultData>(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

                const metadataMutation = await planDeleteMetadataObject(
                    { configurationRootPath: this.configRootPath },
                    {
                        type: resolved.rootTag as MetadataType,
                        name: resolved.objectName,
                    },
                );
                const plan = toAgentDeletePlan(metadataMutation.plan);
                const plannedFiles = metadataMutation.impact.affectedPaths;

                if (params.dryRun) {
                    return {
                        success: true,
                        dryRun: true,
                        rev: check.currentRev,
                        target: params.path,
                        data: {
                            dryRun: true,
                            rev: check.currentRev,
                            target: params.path,
                            plannedChanges: {
                                files: plannedFiles.length > 0 ? [...plannedFiles] : [filePath, path.join(this.configRootPath, CONFIGURATION_XML)],
                                summary: `Удаление объекта ${params.path}`,
                            },
                        },
                    };
                }

                const executor = new MutationPlanExecutor(this.configRootPath);
                const execResult = await executor.execute(plan);
                if (execResult.success) {
                    const newRev = ZERO_REVISION;
                    return {
                        success: true,
                        rev: newRev,
                        target: params.path,
                        data: { rev: newRev, target: params.path },
                    };
                }
                return {
                    success: false,
                    error: execResult.error,
                    code: execResult.code,
                };
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // planRenameObject
    // ─────────────────────────────────────────────────────────────────────────

    /** Builds the serializable multi-file rename plan without applying filesystem effects. */
    async planRenameObject(params: RenameObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        const { resolved, metadataType } = await this.context.resolveRootMetadataObjectMutation(params.path, 'renameObject');
        const { objectName, filePath } = resolved;
        const newName = params.newName?.trim();
        const planned = await planRenameMetadataObject(
            { configurationRootPath: this.configRootPath },
            { type: metadataType, oldName: objectName, newName: newName ?? '' },
        );
        const newFilePath = path.join(path.dirname(filePath), `${newName ?? ''}.xml`);
        return {
            ...planned.plan,
            kind: 'agent.renameObject',
            result: { success: true, data: { filePath: newFilePath } },
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // renameObject
    // ─────────────────────────────────────────────────────────────────────────

    async renameObject(params: RenameObjectParams): Promise<AgentResult<CreateObjectResult>> {
        try {
            const { dotPath } = parseSourceAddress(params.path);
            if (dotPath.split('.').length !== 2) {
                return {
                    success: false,
                    code: 'INVALID_AGENT_PATH',
                    error: `renameObject принимает только корневой путь объекта: "${params.path}".`,
                };
            }
            const resolved = await this.context.resolveContainedAgentPath(params.path);
            if (resolved.nestedType !== undefined || resolved.tabularSection !== undefined) {
                return {
                    success: false,
                    code: 'INVALID_AGENT_PATH',
                    error: `renameObject не поддерживает вложенные пути метаданных: "${params.path}".`,
                };
            }
            const { filePath } = resolved;

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            const newName = params.newName?.trim();

            return await this.context.withTargetMutationLock(filePath, async () => {
                const check = await this.context.checkMutationPreconditions<CreateObjectResult>(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

                const plan = await this.planRenameObject(params);
                const newFilePath = plan.result.data?.filePath
                    ?? path.join(path.dirname(filePath), `${newName ?? ''}.xml`);
                const plannedFiles = Array.from(new Set(
                    plan.steps
                        .flatMap((step) => {
                            if ('targetPath' in step && 'sourcePath' in step) {
                                return [step.sourcePath, step.targetPath];
                            }
                            if ('targetPath' in step) {
                                return [step.targetPath];
                            }
                            return [];
                        })
                        .filter((p): p is string => typeof p === 'string'),
                ));

                if (params.dryRun) {
                    return {
                        success: true,
                        dryRun: true,
                        rev: check.currentRev,
                        target: params.path,
                        data: {
                            filePath: newFilePath,
                            dryRun: true,
                            rev: check.currentRev,
                            target: params.path,
                            plannedChanges: {
                                files: plannedFiles.length > 0 ? plannedFiles : [filePath, newFilePath, path.join(this.configRootPath, CONFIGURATION_XML)],
                                summary: `Переименование объекта ${params.path} в ${newName}`,
                            },
                        },
                    };
                }

                const executor = new MutationPlanExecutor(this.configRootPath);
                const execResult = await executor.execute(plan);
                if (execResult.success && execResult.data) {
                    const newRev = await calculateRevision(newFilePath);
                    return {
                        ...execResult,
                        rev: newRev,
                        target: params.path,
                        data: {
                            ...execResult.data,
                            filePath: newFilePath,
                            rev: newRev,
                            target: params.path,
                        },
                    };
                }
                return execResult;
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // planDuplicateObject
    // ─────────────────────────────────────────────────────────────────────────

    /** Builds the serializable multi-file root duplicate plan without applying filesystem effects. */
    async planDuplicateObject(params: DuplicateObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        const { resolved, metadataType } = await this.context.resolveRootMetadataObjectMutation(params.path, 'duplicateObject');
        const newName = params.newName?.trim() ?? '';
        const planned = await planDuplicateMetadataObject(
            { configurationRootPath: this.configRootPath },
            { type: metadataType, sourceName: resolved.objectName, newName },
        );
        const newFilePath = path.join(path.dirname(resolved.filePath), `${newName}.xml`);
        return {
            ...planned.plan,
            kind: 'agent.duplicateObject',
            result: { success: true, data: { filePath: newFilePath } },
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // duplicateObject
    // ─────────────────────────────────────────────────────────────────────────

    async duplicateObject(params: DuplicateObjectParams): Promise<AgentResult<CreateObjectResult>> {
        try {
            const { dotPath } = parseSourceAddress(params.path);
            if (dotPath.split('.').length !== 2) {
                return {
                    success: false,
                    code: 'INVALID_AGENT_PATH',
                    error: `duplicateObject принимает только корневой путь объекта: "${params.path}".`,
                };
            }
            const resolved = await this.context.resolveContainedAgentPath(params.path);
            if (resolved.nestedType !== undefined || resolved.tabularSection !== undefined) {
                return {
                    success: false,
                    code: 'INVALID_AGENT_PATH',
                    error: `duplicateObject не поддерживает вложенные пути метаданных: "${params.path}".`,
                };
            }
            const { filePath } = resolved;
            const newName = params.newName?.trim() ?? '';

            return await this.context.withTargetMutationLock<CreateObjectResult>(filePath, async () => {
                const check = await this.context.checkMutationPreconditions<CreateObjectResult>(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

                const plan = await this.planDuplicateObject(params);
                const newFilePath = plan.result.data?.filePath
                    ?? path.join(path.dirname(filePath), `${newName}.xml`);
                const plannedFiles = Array.from(new Set(
                    plan.steps
                        .filter((step) => !isReadOnlyAssertionStep(step))
                        .flatMap((step) => {
                            if ('targetPath' in step && 'sourcePath' in step) {
                                return [step.sourcePath, step.targetPath];
                            }
                            if ('targetPath' in step) {
                                return [step.targetPath];
                            }
                            return [];
                        })
                        .filter((candidate): candidate is string => typeof candidate === 'string'),
                ));

                if (params.dryRun) {
                    return {
                        success: true,
                        dryRun: true,
                        rev: check.currentRev,
                        target: params.path,
                        data: {
                            filePath: newFilePath,
                            dryRun: true,
                            rev: check.currentRev,
                            target: params.path,
                            plannedChanges: {
                                files: plannedFiles,
                                summary: `Дублирование объекта ${params.path} в ${newName}`,
                            },
                        },
                    };
                }

                const execResult = await new MutationPlanExecutor(this.configRootPath).execute(plan);
                if (execResult.success) {
                    const newRev = await calculateRevision(newFilePath);
                    return {
                        ...execResult,
                        rev: newRev,
                        target: params.path,
                        data: {
                            ...execResult.data,
                            filePath: newFilePath,
                            rev: newRev,
                            target: params.path,
                        },
                    };
                }
                return execResult;
            });
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
                    if (!objectName) { continue; }
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

    // ─────────────────────────────────────────────────────────────────────────
    // listChildren
    // ─────────────────────────────────────────────────────────────────────────

    async listChildren(params: ListChildrenParams): Promise<AgentResult<{ children: MetadataChildInfo[] }>> {
        try {
            const resolved = await this.context.resolveContainedAgentPath(params.path);
            try {
                await fs.promises.access(resolved.filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${resolved.filePath}` };
            }
            const validatedRoot = await this.context.validateExternalDataSourcePath(resolved);
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
    // getYaml
    // ─────────────────────────────────────────────────────────────────────────

    async getYaml(params: GetYamlParams): Promise<AgentResult<{ yaml: string }>> {
        try {
            const { path: objectPath } = params;

            if (!objectPath || typeof objectPath !== 'string') {
                return { success: false, error: 'Параметр path обязателен.' };
            }

            const { dotPath: getYamlDotPath } = parseSourceAddress(objectPath);
            const dotIdx = getYamlDotPath.indexOf('.');
            if (dotIdx === -1) {
                return { success: false, error: 'Параметр path должен быть вида "Тип.Имя", например "Catalog.Товары".' };
            }
            const type = getYamlDotPath.slice(0, dotIdx);
            const name = getYamlDotPath.slice(dotIdx + 1);

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

            if (type === MetadataType.ExternalDataSource && getYamlDotPath.split('.').length !== 2) {
                return { success: false, error: 'getYaml поддерживает только корневой путь ExternalDataSource. Для таблиц используйте getProperties.' };
            }

            const xmlFilePath = (await this.context.resolveContainedAgentPath(`${type}.${name}`)).filePath;

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
}
