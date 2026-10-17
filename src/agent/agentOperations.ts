// src/agent/agentOperations.ts
// Agent API — бизнес-логика без зависимостей от vscode.
// Unified facade delegating to specialized domain operations:
// - AgentMetadataCrudOperations: root CRUD, duplicate, rename, list, YAML
// - AgentChildStructureOperations: attributes, tabular sections, columns
// - AgentPropertyOperations: properties, types, EventSubscription sources

import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import { assertPathWithinRoot } from '../services/configurationSession/pathBoundary';
import { getMetadataTypeDescriptorByRootTag } from '../constants/metadataTypeDescriptors';
import { validateElementName } from '../utils/elementNameValidator';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { AgentPathError, parseSourceAddress, resolveAgentPath } from './agentPathResolver';
import {
    type AgentOperationsContext,
    acquireTargetMutationLock,
    checkMutationPreconditions,
    externalDataSourceTableNames,
    readValidatedMetadataDocument,
} from './agentOperationsShared';
import { AgentMetadataCrudOperations } from './agentMetadataCrudOperations';
import { AgentChildStructureOperations } from './agentChildStructureOperations';
import { AgentPropertyOperations } from './agentPropertyOperations';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';
import type {
    AddAttributeParams,
    AddTabularSectionColumnParams,
    AddTabularSectionParams,
    AgentResult,
    CreateObjectParams,
    CreateObjectResult,
    DeleteAttributeParams,
    DeleteObjectParams,
    DeleteTabularSectionParams,
    DuplicateObjectParams,
    GetPropertiesParams,
    GetPropertiesResult,
    GetSourceParams,
    GetSourceResult,
    GetTypeParams,
    GetTypeResult,
    GetYamlParams,
    ListChildrenParams,
    ListObjectsParams,
    MetadataChildInfo,
    MutationResultData,
    ObjectInfo,
    RenameObjectParams,
    SetPropertiesParams,
    SetSourceParams,
    SetTypeParams,
} from './types';

export { acquireTargetMutationLock } from './agentOperationsShared';

export class AgentOperations implements AgentOperationsContext {
    readonly configRootPath: string;
    private readonly crudOps: AgentMetadataCrudOperations;
    private readonly childStructureOps: AgentChildStructureOperations;
    private readonly propertyOps: AgentPropertyOperations;

    constructor(configRootPath: string) {
        this.configRootPath = configRootPath;
        this.crudOps = new AgentMetadataCrudOperations(this);
        this.childStructureOps = new AgentChildStructureOperations(this);
        this.propertyOps = new AgentPropertyOperations(this);
    }

    // ─── AgentOperationsContext ──────────────────────────────────────────────

    async withTargetMutationLock<T>(
        targetPath: string,
        action: () => Promise<AgentResult<T>>
    ): Promise<AgentResult<T>> {
        const release = await acquireTargetMutationLock(targetPath);
        try {
            return await action();
        } finally {
            release();
        }
    }

    async checkMutationPreconditions<T = MutationResultData>(
        filePath: string,
        target: string,
        options?: { dryRun?: boolean; ifRev?: string },
    ): Promise<{ proceed: boolean; errorResult?: AgentResult<T>; currentRev: string }> {
        return checkMutationPreconditions<T>(filePath, target, options);
    }

    async resolveContainedAgentPath(agentPath: string): Promise<ReturnType<typeof resolveAgentPath>> {
        const resolved = resolveAgentPath(this.configRootPath, agentPath);
        await assertPathWithinRoot(this.configRootPath, resolved.filePath);
        return resolved;
    }

    async resolveRootMetadataObjectMutation(
        agentPath: unknown,
        operation: 'renameObject' | 'duplicateObject',
    ): Promise<{ readonly resolved: ReturnType<typeof resolveAgentPath>; readonly metadataType: MetadataType }> {
        const dotPath = typeof agentPath === 'string' ? parseSourceAddress(agentPath).dotPath : '';
        const segmentCount = dotPath ? dotPath.split('.').length : 0;
        if (segmentCount !== 2) {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `${operation} supports only a root object path (RootTag.Name): "${String(agentPath)}".`,
            );
        }
        const resolved = await this.resolveContainedAgentPath(agentPath as string);
        if (resolved.nestedType !== undefined || resolved.tabularSection !== undefined) {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `${operation} does not support nested metadata paths: "${String(agentPath)}".`,
            );
        }
        const metadataType = getMetadataTypeDescriptorByRootTag(resolved.rootTag)?.type;
        if (!metadataType) {
            throw new Error(`Unsupported metadata root type: ${resolved.rootTag}`);
        }
        return { resolved, metadataType };
    }

    async validateExternalDataSourcePath(
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

    async resolveEventSubscriptionPath(agentPath: string): Promise<ReturnType<typeof resolveAgentPath>> {
        const resolved = await this.resolveContainedAgentPath(agentPath);
        const { dotPath } = parseSourceAddress(agentPath);
        if (dotPath.split('.').length !== 2 || resolved.rootTag !== 'EventSubscription') {
            throw new AgentPathError(
                'INVALID_AGENT_PATH',
                `Source supports only an EventSubscription root path (EventSubscription.Name): "${agentPath}".`,
            );
        }
        return resolved;
    }

    // ─── Metadata CRUD Operations ────────────────────────────────────────────

    async createObject(params: CreateObjectParams): Promise<AgentResult<CreateObjectResult>> {
        return this.crudOps.createObject(params);
    }

    async planCreateObject(params: CreateObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        return this.crudOps.planCreateObject(params);
    }

    async deleteObject(params: DeleteObjectParams): Promise<AgentResult<MutationResultData>> {
        return this.crudOps.deleteObject(params);
    }

    async planDeleteObject(params: DeleteObjectParams): Promise<MutationPlan<AgentResult>> {
        return this.crudOps.planDeleteObject(params);
    }

    async renameObject(params: RenameObjectParams): Promise<AgentResult<CreateObjectResult>> {
        return this.crudOps.renameObject(params);
    }

    async planRenameObject(params: RenameObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        return this.crudOps.planRenameObject(params);
    }

    async duplicateObject(params: DuplicateObjectParams): Promise<AgentResult<CreateObjectResult>> {
        return this.crudOps.duplicateObject(params);
    }

    async planDuplicateObject(params: DuplicateObjectParams): Promise<MutationPlan<AgentResult<{ filePath: string }>>> {
        return this.crudOps.planDuplicateObject(params);
    }

    async listObjects(params: ListObjectsParams): Promise<AgentResult<{ objects: ObjectInfo[] }>> {
        return this.crudOps.listObjects(params);
    }

    async listChildren(params: ListChildrenParams): Promise<AgentResult<{ children: MetadataChildInfo[] }>> {
        return this.crudOps.listChildren(params);
    }

    async getYaml(params: GetYamlParams): Promise<AgentResult<{ yaml: string }>> {
        return this.crudOps.getYaml(params);
    }

    // ─── Child Structure Operations ──────────────────────────────────────────

    async addAttribute(params: AddAttributeParams): Promise<AgentResult<MutationResultData>> {
        return this.childStructureOps.addAttribute(params);
    }

    async deleteAttribute(params: DeleteAttributeParams): Promise<AgentResult<MutationResultData>> {
        return this.childStructureOps.deleteAttribute(params);
    }

    async addTabularSection(params: AddTabularSectionParams): Promise<AgentResult<MutationResultData>> {
        return this.childStructureOps.addTabularSection(params);
    }

    async deleteTabularSection(params: DeleteTabularSectionParams): Promise<AgentResult<MutationResultData>> {
        return this.childStructureOps.deleteTabularSection(params);
    }

    async addTabularSectionColumn(params: AddTabularSectionColumnParams): Promise<AgentResult<MutationResultData>> {
        return this.childStructureOps.addTabularSectionColumn(params);
    }

    // ─── Property & Type Operations ──────────────────────────────────────────

    async getProperties(params: GetPropertiesParams): Promise<AgentResult<GetPropertiesResult>> {
        return this.propertyOps.getProperties(params);
    }

    async setProperties(params: SetPropertiesParams): Promise<AgentResult<MutationResultData>> {
        return this.propertyOps.setProperties(params);
    }

    async getType(params: GetTypeParams): Promise<AgentResult<GetTypeResult>> {
        return this.propertyOps.getType(params);
    }

    async setType(params: SetTypeParams): Promise<AgentResult<MutationResultData>> {
        return this.propertyOps.setType(params);
    }

    async getSource(params: GetSourceParams): Promise<AgentResult<GetSourceResult>> {
        return this.propertyOps.getSource(params);
    }

    async setSource(params: SetSourceParams): Promise<AgentResult<MutationResultData>> {
        return this.propertyOps.setSource(params);
    }
}
