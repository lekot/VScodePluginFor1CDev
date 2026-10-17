// src/agent/agentChildStructureOperations.ts
// Handles attributes, tabular sections, and tabular section columns for Agent API.

import * as fs from 'fs';
import { validateElementName } from '../utils/elementNameValidator';
import {
    assertCfeGenericCreateAllowed,
    assertCfeGenericMutationAllowed,
} from '../extensionSupport/cfeProject/mutationPolicy';
import { parseSourceAddress } from './agentPathResolver';
import { XMLWriter } from '../utils/XMLWriter';
import { MetadataType } from '../models/treeNode';
import { calculateRevision } from './agentRevision';
import {
    type AgentOperationsContext,
    mutationFailure,
} from './agentOperationsShared';
import type {
    AddAttributeParams,
    AddTabularSectionColumnParams,
    AddTabularSectionParams,
    AgentResult,
    DeleteAttributeParams,
    DeleteTabularSectionParams,
    MutationResultData,
} from './types';

export class AgentChildStructureOperations {
    constructor(private readonly context: AgentOperationsContext) {}

    // ─────────────────────────────────────────────────────────────────────────
    // addAttribute
    // ─────────────────────────────────────────────────────────────────────────

    async addAttribute(params: AddAttributeParams): Promise<AgentResult<MutationResultData>> {
        try {
            const resolved = await this.context.resolveContainedAgentPath(params.path);
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

            return await this.context.withTargetMutationLock(filePath, async () => {
                const check = await this.context.checkMutationPreconditions(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

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
                                files: [filePath],
                                summary: `Добавление реквизита ${params.name.trim()} в ${params.path}`,
                            },
                        },
                    };
                }

                await XMLWriter.addNestedElement(filePath, 'Attribute', params.name.trim(), {}, rootTag as MetadataType, objectName);

                const newRev = await calculateRevision(filePath);
                return {
                    success: true,
                    rev: newRev,
                    target: params.path,
                    data: { rev: newRev, target: params.path },
                };
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteAttribute
    // ─────────────────────────────────────────────────────────────────────────

    async deleteAttribute(params: DeleteAttributeParams): Promise<AgentResult<MutationResultData>> {
        try {
            const resolved = await this.context.resolveContainedAgentPath(params.path);
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

            const { dotPath } = parseSourceAddress(params.path);
            const segments = dotPath.split('.');
            if (segments.length !== 4 && segments.length !== 6) {
                return { success: false, error: `Некорректный путь для deleteAttribute: "${params.path}". Ожидается 4 или 6 сегментов.` };
            }

            return await this.context.withTargetMutationLock(filePath, async () => {
                const check = await this.context.checkMutationPreconditions(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

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
                                files: [filePath],
                                summary: `Удаление реквизита ${params.path}`,
                            },
                        },
                    };
                }

                if (segments.length === 4) {
                    // RootTag.ObjectName.Attribute.AttrName
                    await XMLWriter.removeNestedElement(filePath, 'Attribute', resolved.nestedName!);
                } else if (segments.length === 6) {
                    // RootTag.ObjectName.TabularSection.TSName.Attribute.ColName
                    await XMLWriter.removeAttributeFromTabularSection(filePath, resolved.tabularSection!, resolved.nestedName!);
                }

                const newRev = await calculateRevision(filePath);
                return {
                    success: true,
                    rev: newRev,
                    target: params.path,
                    data: { rev: newRev, target: params.path },
                };
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addTabularSection
    // ─────────────────────────────────────────────────────────────────────────

    async addTabularSection(params: AddTabularSectionParams): Promise<AgentResult<MutationResultData>> {
        try {
            const resolved = await this.context.resolveContainedAgentPath(params.path);
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

            return await this.context.withTargetMutationLock(filePath, async () => {
                const check = await this.context.checkMutationPreconditions(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

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
                                files: [filePath],
                                summary: `Добавление табличной части ${params.name.trim()} в ${params.path}`,
                            },
                        },
                    };
                }

                await XMLWriter.addNestedElement(filePath, 'TabularSection', params.name.trim(), {}, rootTag as MetadataType, objectName);

                const newRev = await calculateRevision(filePath);
                return {
                    success: true,
                    rev: newRev,
                    target: params.path,
                    data: { rev: newRev, target: params.path },
                };
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // deleteTabularSection
    // ─────────────────────────────────────────────────────────────────────────

    async deleteTabularSection(params: DeleteTabularSectionParams): Promise<AgentResult<MutationResultData>> {
        try {
            const { dotPath } = parseSourceAddress(params.path);
            const segments = dotPath.split('.');
            if (segments.length !== 4 || segments[2] !== 'TabularSection') {
                return { success: false, error: `Неверный path для deleteTabularSection: "${params.path}". Ожидается формат: RootTag.ObjectName.TabularSection.TSName` };
            }

            const resolved = await this.context.resolveContainedAgentPath(params.path);
            const { filePath } = resolved;
            await assertCfeGenericMutationAllowed(filePath, 'delete');

            try {
                await fs.promises.access(filePath);
            } catch {
                return { success: false, error: `Файл объекта не найден: ${filePath}` };
            }

            return await this.context.withTargetMutationLock(filePath, async () => {
                const check = await this.context.checkMutationPreconditions(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

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
                                files: [filePath],
                                summary: `Удаление табличной части ${params.path}`,
                            },
                        },
                    };
                }

                await XMLWriter.removeNestedElement(filePath, 'TabularSection', resolved.nestedName!);
                const newRev = await calculateRevision(filePath);
                return {
                    success: true,
                    rev: newRev,
                    target: params.path,
                    data: { rev: newRev, target: params.path },
                };
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addTabularSectionColumn
    // ─────────────────────────────────────────────────────────────────────────

    async addTabularSectionColumn(params: AddTabularSectionColumnParams): Promise<AgentResult<MutationResultData>> {
        try {
            const { dotPath } = parseSourceAddress(params.path);
            const segments = dotPath.split('.');
            if (segments.length !== 4 || segments[2] !== 'TabularSection') {
                return {
                    success: false,
                    error: `Некорректный путь для addTabularSectionColumn: "${params.path}". Ожидается 4 сегмента вида RootTag.ObjectName.TabularSection.TSName.`,
                };
            }
            const resolved = await this.context.resolveContainedAgentPath(params.path);
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

            return await this.context.withTargetMutationLock(filePath, async () => {
                const check = await this.context.checkMutationPreconditions(filePath, params.path, params);
                if (!check.proceed) {
                    return check.errorResult!;
                }

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
                                files: [filePath],
                                summary: `Добавление колонки ${params.name.trim()} в ${params.path}`,
                            },
                        },
                    };
                }

                await XMLWriter.addAttributeToTabularSection(filePath, nestedName!, params.name.trim(), rootTag as MetadataType, objectName);

                const newRev = await calculateRevision(filePath);
                return {
                    success: true,
                    rev: newRev,
                    target: params.path,
                    data: { rev: newRev, target: params.path },
                };
            });
        } catch (err) {
            return mutationFailure(err);
        }
    }
}
