import * as fs from 'fs';
import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import {
  assertMetadataCrudSupported,
  getMetadataTypeDescriptorByType,
} from '../constants/metadataTypeDescriptors';
import { rulesRegistry, metadataConverter } from '../rules';
import { buildRootObjectConfigurationContent } from './configurationXmlUpdater';
import { getDesignerTemplateXml } from './designerTemplateRepository';
import { substituteDesignerTemplate } from './designerTemplateSubstitutor';
import { generatePredefinedAccountsXml } from './chartOfAccountsWizardService';
import { planCreateFilterCriterion } from './filterCriterionWizardService';
import { hashContent } from './configurationSession/atomicFileStorage';
import { assertPathWithinRoot } from './configurationSession/pathBoundary';
import type { MutationPlan, MutationStep } from './configurationSession/mutationPlan';
import { listXmlSiblingNames, readMutationExpectation } from './filesystemReadSemantics';
import { assertCfeGenericCreateAllowed, assertCfeGenericMutationAllowed } from '../extensionSupport/cfeProject/mutationPolicy';
import { validateElementName } from '../utils/elementNameValidator';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { requireProjectWriteFormatProfile } from '../utils/format/formatRank';
import { generateSimpleUuid } from '../utils/xml/xmlHelpers';
import { injectInternalInfoIntoMetadataXml } from '../utils/xml/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';

/** Minimal root-path context for this foundation step; resolved configuration targets remain a follow-up. */
export interface MetadataCrudContext {
  readonly configurationRootPath: string;
}

export interface CreateMetadataObjectRequest {
  readonly type: MetadataType;
  readonly name: string;
  readonly synonym?: string;
  readonly properties?: Record<string, unknown>;
}

export interface DeleteMetadataObjectRequest {
  readonly type: MetadataType;
  readonly name: string;
}

export interface MetadataMutationImpact {
  /** Paths touched by the plan, in first-seen order. */
  readonly affectedPaths: readonly string[];
  /** Paths written as files by the plan. */
  readonly writePaths: readonly string[];
  /** Directories the plan may create. */
  readonly directoryPaths: readonly string[];
  /** Paths removed by the plan. */
  readonly deletePaths: readonly string[];
}

export interface PlannedMetadataMutation<T> {
  readonly plan: MutationPlan<T>;
  readonly impact: MetadataMutationImpact;
}

const TEMPLATE_ONLY_TYPES = new Set([MetadataType.InformationRegister, MetadataType.AccumulationRegister]);

export async function planCreateMetadataObject(
  context: MetadataCrudContext,
  request: CreateMetadataObjectRequest,
): Promise<PlannedMetadataMutation<{ readonly filePath: string }>> {
  const descriptor = requireRootDescriptor(request.type);
  assertMetadataCrudSupported(request.type, 'create');

  if (!request.name || !request.name.trim()) {
    throw new Error('Parameter name is required and cannot be empty.');
  }
  const name = request.name.trim();
  const rootTag = descriptor.designerRootTag;
  const typeValidation = validateElementName(rootTag, []);
  if (typeValidation) {
    throw new Error(`Invalid type "${rootTag}": ${typeValidation}`);
  }

  await assertCfeGenericCreateAllowed(context.configurationRootPath, name, { isRootObjectCreate: true });

  const folderPath = path.join(context.configurationRootPath, descriptor.designerFolder);
  const nameValidation = validateElementName(name, await listXmlSiblingNames(folderPath));
  if (nameValidation) {
    throw new Error(nameValidation);
  }

  const filePath = path.join(folderPath, `${name}.xml`);
  const elementDir = path.join(folderPath, name);
  await assertPathWithinRoot(context.configurationRootPath, filePath);
  await assertPathWithinRoot(context.configurationRootPath, elementDir);
  const fileExpected = await readMutationExpectation(filePath);
  if (fileExpected.state !== 'missing') {
    throw new Error(`Object already exists: ${filePath}`);
  }
  const directoryExpected = await readMutationExpectation(elementDir);
  if (directoryExpected.state !== 'missing') {
    throw new Error(`Object directory already exists: ${elementDir}`);
  }

  if (request.type === MetadataType.FilterCriterion) {
    const properties = request.properties;
    const types = properties?.['Type'] !== undefined
      ? (Array.isArray(properties['Type']) ? properties['Type'].map(String) : [String(properties['Type'])])
      : [];
    const rawContent = properties?.['Content'] !== undefined
      ? (Array.isArray(properties['Content']) ? properties['Content'].map(String) : [String(properties['Content'])])
      : [];
    const content = rawContent.map((item) => item.trim()).filter((item) => item.length > 0);
    if (content.length === 0) {
      throw new Error('FilterCriterion requires non-empty "Content" property with at least one metadata item reference.');
    }
    const plan = await planCreateFilterCriterion(context.configurationRootPath, {
      name,
      synonym: request.synonym ?? name,
      comment: typeof properties?.['Comment'] === 'string' ? properties['Comment'] : undefined,
      types,
      content,
      useStandardCommands: typeof properties?.['UseStandardCommands'] === 'boolean'
        ? properties['UseStandardCommands']
        : false,
    });
    return planned(plan);
  }

  const rules = TEMPLATE_ONLY_TYPES.has(request.type) ? undefined : rulesRegistry.get(rootTag);
  const templateXml = rules ? null : await getDesignerTemplateXml(rootTag);
  if (!rules && templateXml === null) {
    throw new Error(`Type "${rootTag}" is not supported.`);
  }

  const configurationPath = path.join(context.configurationRootPath, CONFIGURATION_XML);
  const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
  const targetVersion = requireProjectWriteFormatProfile(configurationContent).version;
  const uuid = generateSimpleUuid();
  let content: string;
  if (rules) {
    let intermediate = metadataConverter.createDefaultIR(rules, { name, uuid });
    const overrides: Record<string, unknown> = {};
    if (request.synonym !== undefined) {
      overrides['Synonym'] = request.synonym;
    }
    if (request.properties) {
      Object.assign(overrides, request.properties);
    }
    if (Object.keys(overrides).length > 0) {
      intermediate = metadataConverter.mergeProperties(intermediate, overrides);
    }
    content = metadataConverter.irToXml(intermediate, rules);
  } else {
    content = substituteDesignerTemplate(templateXml!, {
      uuid,
      Name: name,
      Synonym_ru: request.synonym ?? name,
      uuidDim: generateSimpleUuid(),
      uuidResource: generateSimpleUuid(),
    });
  }
  content = normalizeMetaDataObjectRoot(
    injectInternalInfoIntoMetadataXml(content, rootTag, name),
    targetVersion,
  );
  const nextConfigurationContent = buildRootObjectConfigurationContent(configurationContent, {
    type: 'add',
    rootTag,
    objectName: name,
  });

  const steps: MutationStep[] = [
    { type: 'ensureDirectory', targetPath: folderPath },
    { type: 'writeFile', targetPath: filePath, content, encoding: 'utf8', expected: fileExpected },
    { type: 'ensureDirectory', targetPath: elementDir },
  ];
  if (request.type === MetadataType.ChartOfAccounts) {
    const extDir = path.join(elementDir, 'Ext');
    const predefinedPath = path.join(extDir, 'Predefined.xml');
    const predefinedContent = generatePredefinedAccountsXml({ name }, targetVersion);
    const predefinedExpected = await readMutationExpectation(predefinedPath);
    steps.push({ type: 'ensureDirectory', targetPath: extDir });
    steps.push({ type: 'writeFile', targetPath: predefinedPath, content: predefinedContent, encoding: 'utf8', expected: predefinedExpected });
  }
  steps.push({
    type: 'writeFile',
    targetPath: configurationPath,
    content: nextConfigurationContent,
    encoding: 'utf8',
    expected: { state: 'file', hash: hashContent(configurationContent) },
  });

  return planned({
    kind: 'metadata.create',
    steps,
    result: { filePath },
  });
}

export async function planDeleteMetadataObject(
  context: MetadataCrudContext,
  request: DeleteMetadataObjectRequest,
): Promise<PlannedMetadataMutation<void>> {
  const descriptor = requireRootDescriptor(request.type);
  assertMetadataCrudSupported(request.type, 'delete');

  const rootPath = context.configurationRootPath;
  const filePath = path.join(rootPath, descriptor.designerFolder, `${request.name}.xml`);
  const elementDir = path.join(rootPath, descriptor.designerFolder, request.name);
  const configurationPath = path.join(rootPath, CONFIGURATION_XML);
  await assertPathWithinRoot(rootPath, filePath);
  await assertPathWithinRoot(rootPath, elementDir);
  await assertPathWithinRoot(rootPath, configurationPath);
  await assertCfeGenericMutationAllowed(filePath, 'delete');

  const fileExpected = await readMutationExpectation(filePath);
  if (fileExpected.state !== 'file') {
    throw new Error(`Object file not found: ${filePath}`);
  }
  const directoryExpected = await readMutationExpectation(elementDir);
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
      type: 'remove',
      rootTag: descriptor.designerRootTag,
      objectName: request.name,
    }),
    encoding: 'utf8',
    expected: { state: 'file', hash: hashContent(configurationContent) },
  });

  return planned({ kind: 'metadata.delete', steps, result: undefined });
}

function requireRootDescriptor(type: MetadataType) {
  const descriptor = getMetadataTypeDescriptorByType(type);
  if (!descriptor?.structure.designerRootObject) {
    throw new Error(`Metadata type "${String(type)}" is not a supported Designer root object.`);
  }
  return descriptor;
}

function planned<T>(plan: MutationPlan<T>): PlannedMetadataMutation<T> {
  const affectedPaths: string[] = [];
  const writePaths: string[] = [];
  const directoryPaths: string[] = [];
  const deletePaths: string[] = [];
  const addUnique = (target: string[], value: string): void => {
    if (!target.includes(value)) {
      target.push(value);
    }
  };
  const addAffected = (value: string): void => addUnique(affectedPaths, value);

  for (const step of plan.steps) {
    if (step.type === 'writeFile') {
      addAffected(step.targetPath);
      addUnique(writePaths, step.targetPath);
    } else if (step.type === 'ensureDirectory') {
      addAffected(step.targetPath);
      addUnique(directoryPaths, step.targetPath);
    } else if (step.type === 'deletePath') {
      addAffected(step.targetPath);
      addUnique(deletePaths, step.targetPath);
    } else {
      addAffected(step.sourcePath);
      addAffected(step.targetPath);
    }
  }

  return {
    plan,
    impact: Object.freeze({
      affectedPaths: Object.freeze(affectedPaths),
      writePaths: Object.freeze(writePaths),
      directoryPaths: Object.freeze(directoryPaths),
      deletePaths: Object.freeze(deletePaths),
    }),
  };
}
