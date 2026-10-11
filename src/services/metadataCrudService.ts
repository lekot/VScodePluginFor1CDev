import * as fs from 'fs';
import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import {
  assertMetadataCrudSupported,
  getMetadataTypeDescriptorByType,
} from '../constants/metadataTypeDescriptors';
import { rulesRegistry, metadataConverter } from '../rules';
import {
  buildRootObjectConfigurationContent,
  isRootObjectRegisteredInConfiguration,
} from './configurationXmlUpdater';
import { getDesignerTemplateXml } from './designerTemplateRepository';
import { substituteDesignerTemplate } from './designerTemplateSubstitutor';
import {
  generateChartOfAccountsXml,
  generatePredefinedAccountsXml,
  type ChartOfAccountsWizardParams,
} from './chartOfAccountsWizardService';
import {
  generateFilterCriterionXml,
  validateContentItemCompatibility,
  type FilterCriterionWizardParams,
} from './filterCriterionWizardService';
import { appendRegisterReferenceToRecorderDocumentXml } from './registerRecorderDocumentLinker';
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
import { XmlParser } from '../parsers/xmlParser';

/** Minimal root-path context for this foundation step; resolved configuration targets remain a follow-up. */
export interface MetadataCrudContext {
  readonly configurationRootPath: string;
}

export interface CreateMetadataObjectRequest {
  readonly type: MetadataType;
  readonly name: string;
  readonly synonym?: string;
  readonly properties?: Record<string, unknown>;
  readonly chartOfAccounts?: Omit<ChartOfAccountsWizardParams, 'name'>;
  readonly filterCriterion?: Omit<FilterCriterionWizardParams, 'name'>;
  readonly recorderDocument?: string;
}

export type ChartOfAccountsCreateOptions = Omit<ChartOfAccountsWizardParams, 'name'>;
export type FilterCriterionCreateOptions = Omit<FilterCriterionWizardParams, 'name'>;

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

  const recorderDocument = resolveRecorderDocument(request.recorderDocument);
  if (recorderDocument && request.type !== MetadataType.DocumentJournal && request.type !== MetadataType.AccumulationRegister) {
    throw new Error('recorderDocument is supported only when creating a DocumentJournal or AccumulationRegister.');
  }

  const configurationPath = path.join(context.configurationRootPath, CONFIGURATION_XML);
  const configurationContent = await fs.promises.readFile(configurationPath, 'utf8');
  const targetVersion = requireProjectWriteFormatProfile(configurationContent).version;
  const filterCriterion = request.type === MetadataType.FilterCriterion
    ? resolveFilterCriterionOptions(request, name)
    : undefined;
  if (filterCriterion) {
    for (const contentRef of filterCriterion.content) {
      await validateContentItemCompatibility(context.configurationRootPath, filterCriterion.types, contentRef);
    }
  }

  let recorderDocumentContent: string | undefined;
  let recorderDocumentOriginalContent: string | undefined;
  let recorderDocumentPath: string | undefined;
  let recorderDocumentExpected: Awaited<ReturnType<typeof readMutationExpectation>> | undefined;
  if (recorderDocument && request.type === MetadataType.DocumentJournal) {
    await resolveRegisteredRecorderDocument(context.configurationRootPath, recorderDocument);
  } else if (recorderDocument && request.type === MetadataType.AccumulationRegister) {
    const recorder = await resolveRegisteredRecorderDocument(context.configurationRootPath, recorderDocument);
    recorderDocumentPath = recorder.filePath;
    recorderDocumentExpected = recorder.expected;
    recorderDocumentOriginalContent = recorder.content;
    await assertCfeGenericMutationAllowed(recorderDocumentPath, 'update');
    recorderDocumentContent = appendRegisterReferenceToRecorderDocumentXml(
      recorder.content,
      'AccumulationRegister',
      name,
    );
  }

  const hasChartOfAccountsWizard = request.type === MetadataType.ChartOfAccounts && request.chartOfAccounts !== undefined;
  const hasFilterCriterionWizard = filterCriterion !== undefined;
  const rules = TEMPLATE_ONLY_TYPES.has(request.type)
    || hasChartOfAccountsWizard
    || hasFilterCriterionWizard
    || (request.type === MetadataType.DocumentJournal && recorderDocument !== undefined)
    ? undefined
    : rulesRegistry.get(rootTag);
  const specializedGenerator = hasChartOfAccountsWizard || hasFilterCriterionWizard;
  const templateXml = rules || specializedGenerator ? null : await getDesignerTemplateXml(rootTag);
  if (!rules && !specializedGenerator && templateXml === null) {
    throw new Error(`Type "${rootTag}" is not supported.`);
  }

  const uuid = generateSimpleUuid();
  let content: string;
  if (filterCriterion) {
    content = generateFilterCriterionXml({
      ...filterCriterion,
      name,
      synonym: filterCriterion.synonym ?? request.synonym ?? name,
    }, targetVersion);
  } else if (hasChartOfAccountsWizard) {
    content = generateChartOfAccountsXml({
      ...request.chartOfAccounts,
      name,
      synonym: request.chartOfAccounts.synonym ?? request.synonym ?? name,
    }, targetVersion);
  } else if (rules) {
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
      ...(request.type === MetadataType.DocumentJournal && recorderDocument
        ? { RecorderDocumentRef: `Document.${recorderDocument}` }
        : {}),
    });
  }
  content = normalizeMetaDataObjectRoot(
    injectInternalInfoIntoMetadataXml(content, rootTag, name),
    targetVersion,
  );

  const steps: MutationStep[] = [
    { type: 'ensureDirectory', targetPath: folderPath },
    { type: 'writeFile', targetPath: filePath, content, encoding: 'utf8', expected: fileExpected },
    { type: 'ensureDirectory', targetPath: elementDir },
  ];
  if (request.type === MetadataType.ChartOfAccounts) {
    const extDir = path.join(elementDir, 'Ext');
    const predefinedPath = path.join(extDir, 'Predefined.xml');
    const predefinedContent = generatePredefinedAccountsXml({
      ...request.chartOfAccounts,
      name,
    }, targetVersion);
    const predefinedExpected = await readMutationExpectation(predefinedPath);
    await assertPathWithinRoot(context.configurationRootPath, extDir);
    await assertPathWithinRoot(context.configurationRootPath, predefinedPath);
    steps.push({ type: 'ensureDirectory', targetPath: extDir });
    steps.push({ type: 'writeFile', targetPath: predefinedPath, content: predefinedContent, encoding: 'utf8', expected: predefinedExpected });
  }

  if (request.type === MetadataType.CommonModule) {
    const extPath = path.join(elementDir, 'Ext');
    const moduleDirectory = path.join(extPath, 'Module');
    const modulePath = path.join(moduleDirectory, 'Module.bsl');
    await assertPathWithinRoot(context.configurationRootPath, extPath);
    await assertPathWithinRoot(context.configurationRootPath, moduleDirectory);
    await assertPathWithinRoot(context.configurationRootPath, modulePath);
    steps.push({ type: 'ensureDirectory', targetPath: extPath });
    steps.push({ type: 'ensureDirectory', targetPath: moduleDirectory });
    steps.push({
      type: 'writeFile',
      targetPath: modulePath,
      content: '',
      encoding: 'utf8',
      expected: await readMutationExpectation(modulePath),
    });
  }

  const companionTask = request.type === MetadataType.BusinessProcess
    ? await planBusinessProcessTask(context.configurationRootPath, name, targetVersion)
    : undefined;
  if (companionTask) {
    steps.push(...companionTask.steps);
  }

  if (
    recorderDocumentPath
    && recorderDocumentContent !== undefined
    && recorderDocumentContent !== recorderDocumentOriginalContent
    && recorderDocumentExpected?.state === 'file'
  ) {
    steps.push({
      type: 'writeFile',
      targetPath: recorderDocumentPath,
      content: recorderDocumentContent,
      encoding: 'utf8',
      expected: recorderDocumentExpected,
    });
  }

  let nextConfigurationContent = buildRootObjectConfigurationContent(configurationContent, {
    type: 'add',
    rootTag,
    objectName: name,
  });
  if (companionTask?.registerInConfiguration) {
    nextConfigurationContent = buildRootObjectConfigurationContent(nextConfigurationContent, {
      type: 'add',
      rootTag: companionTask.rootTag,
      objectName: companionTask.name,
    });
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

function resolveRecorderDocument(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('recorderDocument must be a string when provided.');
  }
  const name = value.trim();
  if (name.length === 0) {
    return undefined;
  }
  const validation = validateElementName(name, []);
  if (validation) {
    throw new Error(`Invalid recorder document name "${name}": ${validation}`);
  }
  return name;
}

function resolveFilterCriterionOptions(
  request: CreateMetadataObjectRequest,
  name: string,
): Omit<FilterCriterionWizardParams, 'name'> {
  const properties = request.properties ?? {};
  const typed = request.filterCriterion;
  const propertyStrings = (value: unknown): string[] => {
    if (value === undefined) {
      return [];
    }
    return (Array.isArray(value) ? value : [value]).map(String);
  };
  const content = (typed?.content ?? propertyStrings(properties['Content']))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (content.length === 0) {
    throw new Error('FilterCriterion requires non-empty "Content" property with at least one metadata item reference.');
  }
  return {
    synonym: typed?.synonym ?? request.synonym ?? name,
    comment: typed?.comment ?? (typeof properties['Comment'] === 'string' ? properties['Comment'] : undefined),
    types: typed?.types ?? propertyStrings(properties['Type']),
    content,
    useStandardCommands: typed?.useStandardCommands
      ?? (typeof properties['UseStandardCommands'] === 'boolean' ? properties['UseStandardCommands'] : false),
  };
}

async function resolveRegisteredRecorderDocument(
  configurationRootPath: string,
  recorderDocumentName: string,
): Promise<{
  readonly filePath: string;
  readonly content: string;
  readonly expected: Awaited<ReturnType<typeof readMutationExpectation>>;
}> {
  const filePath = path.join(configurationRootPath, 'Documents', `${recorderDocumentName}.xml`);
  await assertPathWithinRoot(configurationRootPath, filePath);
  const expected = await readMutationExpectation(filePath);
  if (expected.state !== 'file') {
    throw new Error(`Recorder document is missing: ${filePath}`);
  }
  if (!await isRootObjectRegisteredInConfiguration(configurationRootPath, 'Document', recorderDocumentName)) {
    throw new Error(`Recorder document Document.${recorderDocumentName} is not registered in Configuration.xml.`);
  }
  const content = await fs.promises.readFile(filePath, 'utf8');
  if (expected.hash !== hashContent(content)) {
    throw new Error(`Recorder document changed while planning: ${filePath}`);
  }
  const parsed = XmlParser.parseString(content);
  const root = parsed['MetaDataObject'] as Record<string, unknown> | undefined;
  const document = root?.['Document'] as Record<string, unknown> | undefined;
  const properties = document?.['Properties'] as Record<string, unknown> | undefined;
  if (properties?.['Name'] !== recorderDocumentName) {
    throw new Error(`Recorder document identity does not match Document.${recorderDocumentName}.`);
  }
  return { filePath, content, expected };
}

async function planBusinessProcessTask(
  configurationRootPath: string,
  name: string,
  targetVersion: string,
): Promise<{
  readonly name: string;
  readonly rootTag: string;
  readonly registerInConfiguration: boolean;
  readonly steps: readonly MutationStep[];
} | undefined> {
  const taskDescriptor = getMetadataTypeDescriptorByType(MetadataType.Task);
  if (!taskDescriptor) {
    throw new Error('Task metadata descriptor is unavailable for BusinessProcess creation.');
  }
  const folderPath = path.join(configurationRootPath, taskDescriptor.designerFolder);
  const taskFilePath = path.join(folderPath, `${name}.xml`);
  const taskDirectoryPath = path.join(folderPath, name);
  await assertPathWithinRoot(configurationRootPath, folderPath);
  await assertPathWithinRoot(configurationRootPath, taskFilePath);
  await assertPathWithinRoot(configurationRootPath, taskDirectoryPath);

  const taskExpected = await readMutationExpectation(taskFilePath);
  const registered = await isRootObjectRegisteredInConfiguration(
    configurationRootPath,
    taskDescriptor.designerRootTag,
    name,
  );
  if (taskExpected.state === 'missing' || !registered) {
    await assertCfeGenericCreateAllowed(taskFilePath, name, { isRootObjectCreate: true });
  }
  if (taskExpected.state === 'directory') {
    throw new Error(`Companion Task path is a directory, expected a descriptor file: ${taskFilePath}`);
  }
  let steps: MutationStep[] = [];
  if (taskExpected.state === 'missing') {
    const templateXml = await getDesignerTemplateXml(taskDescriptor.designerRootTag);
    if (templateXml === null) {
      throw new Error(`Type "${taskDescriptor.designerRootTag}" is not supported; cannot create the BusinessProcess companion Task.`);
    }
    let taskContent = substituteDesignerTemplate(templateXml, {
      uuid: generateSimpleUuid(),
      Name: name,
      Synonym_ru: name,
    });
    taskContent = normalizeMetaDataObjectRoot(
      injectInternalInfoIntoMetadataXml(taskContent, taskDescriptor.designerRootTag, name),
      targetVersion,
    );
    steps = [
      { type: 'ensureDirectory', targetPath: folderPath },
      { type: 'writeFile', targetPath: taskFilePath, content: taskContent, encoding: 'utf8', expected: taskExpected },
      { type: 'ensureDirectory', targetPath: taskDirectoryPath },
    ];
  } else {
    const taskContent = await fs.promises.readFile(taskFilePath, 'utf8');
    const parsed = XmlParser.parseString(taskContent);
    const root = parsed['MetaDataObject'] as Record<string, unknown> | undefined;
    const task = root?.['Task'] as Record<string, unknown> | undefined;
    const properties = task?.['Properties'] as Record<string, unknown> | undefined;
    if (properties?.['Name'] !== name) {
      throw new Error(`Companion Task identity does not match Task.${name}.`);
    }
    if (taskExpected.hash !== hashContent(taskContent)) {
      throw new Error(`Companion Task changed while planning: ${taskFilePath}`);
    }
  }

  return {
    name,
    rootTag: taskDescriptor.designerRootTag,
    registerInConfiguration: !registered,
    steps,
  };
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
