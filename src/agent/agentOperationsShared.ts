// src/agent/agentOperationsShared.ts
// Shared utilities, XML helpers, and context contract for AgentOperations domain modules.

import * as fs from 'fs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MetadataType } from '../models/treeNode';
import {
    CfeFilesystemMutationPolicyResolver,
} from '../extensionSupport/cfeProject/mutationPolicy';
import { CfeOwnershipError, type CfeObjectIdentity } from '../extensionSupport/cfeProject/ownership';
import {
    type MutationPlan,
} from '../services/configurationSession/mutationPlan';
import { projectMutationFailure } from '../services/configurationSession/mutationReceiptError';
import { configurationPathKey } from '../utils/configurationPathIdentity';
import { AgentPathError, resolveAgentPath } from './agentPathResolver';
import { calculateRevision, isValidRevisionFormat } from './agentRevision';
import type {
    AgentResult,
    MutationResultData,
    ObjectInfo,
} from './types';

// ─── XML-парсер для Configuration.xml ───

export const configParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
});

export function xmlValuesByLocalName(record: Record<string, unknown>, expectedName: string): unknown[] {
    return Object.entries(record)
        .filter(([key]) => key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) === expectedName : key === expectedName)
        .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

export function xmlRecords(value: unknown): Record<string, unknown>[] {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    );
}

export function firstXmlRecord(record: Record<string, unknown>, expectedName: string): Record<string, unknown> | undefined {
    return xmlValuesByLocalName(record, expectedName).flatMap(xmlRecords)[0];
}

export function xmlText(value: unknown): string {
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

export async function readValidatedMetadataDocument(
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

export function externalDataSourceTableNames(root: Record<string, unknown>): string[] {
    const childObjects = firstXmlRecord(root, 'ChildObjects');
    if (!childObjects) {
        return [];
    }
    return xmlValuesByLocalName(childObjects, 'Table').map(xmlText).filter(Boolean);
}

export const cfeReadPolicyResolver = new CfeFilesystemMutationPolicyResolver();

export function mutationFailure(error: unknown): AgentResult<never> {
    const mutationProjection = projectMutationFailure(error);
    return {
        success: false,
        error: mutationProjection?.message ?? (error instanceof Error ? error.message : String(error)),
        ...(mutationProjection ? { code: mutationProjection.code, mutationFailure: mutationProjection } : {}),
        ...(!mutationProjection && (error instanceof CfeOwnershipError || error instanceof AgentPathError)
            ? { code: error.code }
            : {}),
    };
}

export const targetMutationLocks = new Map<string, Promise<void>>();

export async function acquireTargetMutationLock(targetPath: string): Promise<() => void> {
    const canonical = configurationPathKey(targetPath);
    const current = targetMutationLocks.get(canonical) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
        release = resolve;
    });
    const chained = current.then(() => next, () => next);
    targetMutationLocks.set(canonical, chained);
    await current.catch(() => undefined);
    return () => {
        release();
        if (targetMutationLocks.get(canonical) === chained) {
            targetMutationLocks.delete(canonical);
        }
    };
}

export async function checkMutationPreconditions<T = MutationResultData>(
    filePath: string,
    target: string,
    options?: { dryRun?: boolean; ifRev?: string },
): Promise<{ proceed: boolean; errorResult?: AgentResult<T>; currentRev: string }> {
    if (options?.ifRev !== undefined && !isValidRevisionFormat(options.ifRev)) {
        return {
            proceed: false,
            currentRev: '',
            errorResult: {
                success: false,
                code: 'INVALID_REVISION_FORMAT',
                error: 'Параметр ifRev должен быть SHA-256 хэшем из 64 строчных шестнадцатеричных символов.',
            },
        };
    }
    const currentRev = await calculateRevision(filePath);
    if (options?.ifRev !== undefined && options.ifRev !== currentRev) {
        return {
            proceed: false,
            currentRev,
            errorResult: {
                success: false,
                code: 'CONCURRENT_MODIFICATION_ERROR',
                error: `Объект ${target} изменился после получения ревизии; запись отменена.`,
                currentRev,
                target,
                data: {
                    target,
                    currentRev,
                } as unknown as T,
            },
        };
    }
    return { proceed: true, currentRev };
}

export async function readCfeOwnershipForRead(
    configurationRoot: string,
    metadataXmlPath: string,
): Promise<Pick<ObjectInfo, 'ownership' | 'sourceUuid'>> {
    const policy = await cfeReadPolicyResolver.resolve(configurationRoot);
    return policy
        ? ownershipFields(await cfeReadPolicyResolver.resolveObjectIdentity(policy, metadataXmlPath))
        : {};
}

export function ownershipFields(identity: CfeObjectIdentity): Pick<ObjectInfo, 'ownership' | 'sourceUuid'> {
    return {
        ownership: identity.ownership,
        ...(identity.sourceUuid ? { sourceUuid: identity.sourceUuid } : {}),
    };
}

export function extractChildObjects(parsed: unknown): Record<string, unknown> | null {
    if (!parsed || typeof parsed !== 'object') { return null; }
    const root = parsed as Record<string, unknown>;

    const metaDataObject = root['MetaDataObject'];
    if (!metaDataObject || typeof metaDataObject !== 'object') { return null; }

    const configuration = (metaDataObject as Record<string, unknown>)['Configuration'];
    if (!configuration || typeof configuration !== 'object') { return null; }

    const childObjects = (configuration as Record<string, unknown>)['ChildObjects'];
    if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
        return null;
    }
    return childObjects as Record<string, unknown>;
}

export function toAgentCreatePlan(
    plan: MutationPlan<{ readonly filePath: string }>,
): MutationPlan<AgentResult<{ filePath: string }>> {
    return {
        kind: 'agent.createObject',
        steps: plan.steps,
        result: { success: true, data: plan.result },
    };
}

export function toAgentDeletePlan(plan: MutationPlan<void>): MutationPlan<AgentResult> {
    return {
        kind: 'agent.deleteObject',
        steps: plan.steps,
        result: { success: true },
    };
}

export interface AgentOperationsContext {
    readonly configRootPath: string;
    withTargetMutationLock<T>(
        targetPath: string,
        action: () => Promise<AgentResult<T>>
    ): Promise<AgentResult<T>>;
    checkMutationPreconditions<T = MutationResultData>(
        filePath: string,
        target: string,
        options?: { dryRun?: boolean; ifRev?: string },
    ): Promise<{ proceed: boolean; errorResult?: AgentResult<T>; currentRev: string }>;
    resolveContainedAgentPath(agentPath: string): Promise<ReturnType<typeof resolveAgentPath>>;
    resolveRootMetadataObjectMutation(
        agentPath: unknown,
        operation: 'renameObject' | 'duplicateObject',
    ): Promise<{ readonly resolved: ReturnType<typeof resolveAgentPath>; readonly metadataType: MetadataType }>;
    validateExternalDataSourcePath(
        resolved: ReturnType<typeof resolveAgentPath>,
    ): Promise<Record<string, unknown> | undefined>;
    resolveEventSubscriptionPath(agentPath: string): Promise<ReturnType<typeof resolveAgentPath>>;
}
