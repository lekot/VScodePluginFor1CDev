import * as fs from 'fs';
import * as path from 'path';
import { TreeNode } from '../models/treeNode';
import { validateElementName } from '../utils/elementNameValidator';
import { assertCfeGenericCreateAllowed } from '../extensionSupport/cfeProject/mutationPolicy';
import { requireDocumentWriteFormatProfile } from '../utils/format/formatRank';
import { XMLWriter } from '../utils/XMLWriter';
import { xmlParser } from '../utils/xml/xmlCore';
import { buildXmlString } from '../utils/xml/xmlFileIo';
import {
  addDesignerFormReferenceInParsed,
  removeDesignerFormFromOwnerInParsed,
} from '../utils/xml/xmlFormReferenceService';
import { hashContent } from './configurationSession/atomicFileStorage';
import type {
  MutationPlan,
  MutationStep,
} from './configurationSession/mutationPlan';
import { readMutationExpectation } from './filesystemReadSemantics';
import { runConfigurationPlan } from './configurationSession/configurationMutationGateway';
import { Logger } from '../utils/logger';

const FORM_XML = 'Form.xml';
const CONFIGURATION_XML = 'Configuration.xml';

/** Directory that contains Configuration.xml (Designer root or EDT project root). */
export async function findConfigurationRootDir(typeFolderPath: string): Promise<string> {
  let dir = typeFolderPath;
  for (let depth = 0; depth < 16; depth++) {
    const candidate = path.join(dir, CONFIGURATION_XML);
    try {
      await fs.promises.access(candidate);
      return dir;
    } catch {
      // not found, continue
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      break;
    }
    dir = parentDir;
  }
  return path.dirname(typeFolderPath);
}

export async function resolveProjectFormatVersion(configRootPath: string): Promise<string> {
  try {
    const configXmlPath = path.join(configRootPath, CONFIGURATION_XML);
    const content = await fs.promises.readFile(configXmlPath, 'utf-8');
    const match = content.match(/<MetaDataObject[^>]*\sversion="([^"]+)"/i);
    return match ? match[1] : '8.3.24';
  } catch {
    return '8.3.24';
  }
}

function getSiblingNames(parentNode: TreeNode): string[] {
  return (parentNode.children || []).map((c) => c.name);
}

/** Minimal Ext/Form.xml content for a new form (Designer). */
export function buildMinimalExtFormXml(targetVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="${targetVersion}">
\t<Events/>
\t<ChildItems/>
\t<Attributes/>
\t<Commands/>
</Form>
`;
}

export async function planCreateForm(
  parentNode: TreeNode,
  formName: string,
): Promise<{ plan: MutationPlan<void>; configRootPath: string; formMetaPath: string }> {
  const name = formName.trim();
  const err = validateElementName(name, getSiblingNames(parentNode));
  if (err) {
    throw new Error(err);
  }
  if (parentNode.id !== 'Forms') {
    throw new Error('Создание формы: выберите узел «Forms» в дереве метаданных.');
  }
  const formsPath = parentNode.filePath;
  if (!formsPath) {
    throw new Error('Папка форм: не задан путь к каталогу Forms.');
  }
  const formOwner = parentNode.parent;
  await assertCfeGenericCreateAllowed(formsPath, name, {
    isRootObjectCreate: false,
    ownerMetadataXmlPath: formOwner?.filePath,
  });
  const configRootPath = await findConfigurationRootDir(formsPath);
  const targetVersion = await resolveProjectFormatVersion(configRootPath);
  let formsStat: fs.Stats | undefined;
  try {
    formsStat = await fs.promises.stat(formsPath);
  } catch {
    // directory does not exist yet
  }
  if (formsStat && !formsStat.isDirectory()) {
    throw new Error(`Папка форм не найдена: ${formsPath}`);
  }
  const formMetaPath = path.join(formsPath, `${name}.xml`);
  const extRoot = path.join(formsPath, name);
  const [metaExists, extRootExists] = await Promise.all([
    fs.promises.access(formMetaPath).then(() => true).catch(() => false),
    fs.promises.access(extRoot).then(() => true).catch(() => false),
  ]);
  if (metaExists || extRootExists) {
    throw new Error(`Форма с именем «${name}» уже существует.`);
  }

  const steps: MutationStep[] = [];

  // 1. Prepare owner metadata update step first (if owner XML exists)
  const owner = parentNode.parent;
  const ownerXmlPath = owner?.filePath;
  if (ownerXmlPath && ownerXmlPath.toLowerCase().endsWith('.xml')) {
    const ownerExists = await fs.promises.access(ownerXmlPath).then(() => true).catch(() => false);
    if (ownerExists) {
      const ownerContent = await fs.promises.readFile(ownerXmlPath, 'utf-8');
      requireDocumentWriteFormatProfile(ownerContent);
      const parsed = xmlParser.parse(ownerContent);
      const state = { changed: false };
      const updated = addDesignerFormReferenceInParsed(parsed, name, state);
      if (state.changed) {
        steps.push({
          type: 'writeFile',
          targetPath: ownerXmlPath,
          content: buildXmlString(updated),
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent(ownerContent) },
        });
      }
    }
  }

  // 2. Ensure forms directory exists
  steps.push({
    type: 'ensureDirectory',
    targetPath: formsPath,
  });

  // 3. Write minimal Form metadata XML
  const formMetaContent = XMLWriter.buildMinimalElementContent('Form', name, targetVersion);
  steps.push({
    type: 'writeFile',
    targetPath: formMetaPath,
    content: formMetaContent,
    encoding: 'utf8',
    expected: { state: 'missing' },
  });

  // 4. Ensure ext directory and write Ext/Form.xml
  const extDir = path.join(extRoot, 'Ext');
  steps.push({
    type: 'ensureDirectory',
    targetPath: extDir,
  });
  const formXmlPath = path.join(extDir, FORM_XML);
  steps.push({
    type: 'writeFile',
    targetPath: formXmlPath,
    content: buildMinimalExtFormXml(targetVersion),
    encoding: 'utf8',
    expected: { state: 'missing' },
  });

  // 5. Ensure Form module directory and write Module.bsl
  const formModuleDir = path.join(extDir, 'Form');
  steps.push({
    type: 'ensureDirectory',
    targetPath: formModuleDir,
  });
  const modulePath = path.join(formModuleDir, 'Module.bsl');
  steps.push({
    type: 'writeFile',
    targetPath: modulePath,
    content: '',
    encoding: 'utf8',
    expected: { state: 'missing' },
  });

  const plan: MutationPlan<void> = {
    kind: 'createForm',
    steps,
    result: undefined,
  };

  return { plan, configRootPath, formMetaPath };
}

export async function createForm(parentNode: TreeNode, formName: string): Promise<void> {
  const { plan, configRootPath, formMetaPath } = await planCreateForm(parentNode, formName);
  await runConfigurationPlan(configRootPath, plan);
  Logger.info(`Created form: ${formMetaPath}`);
}

export async function planDeleteForm(
  node: TreeNode,
): Promise<{ plan: MutationPlan<void>; configRootPath: string }> {
  const parent = node.parent;
  if (!parent || parent.id !== 'Forms') {
    throw new Error('Удаление формы: ожидался родительский узел «Forms».');
  }

  const fp = node.filePath;
  if (!fp) {
    throw new Error('Файл элемента не найден.');
  }
  try {
    await fs.promises.access(fp);
  } catch {
    throw new Error('Файл элемента не найден.');
  }

  const configRootPath = await findConfigurationRootDir(path.dirname(fp));
  const steps: MutationStep[] = [];

  // 1. Remove form reference from owner XML
  const owner = parent.parent;
  const ownerXmlPath = owner?.filePath;
  if (ownerXmlPath && ownerXmlPath.toLowerCase().endsWith('.xml')) {
    const ownerExists = await fs.promises.access(ownerXmlPath).then(() => true).catch(() => false);
    if (ownerExists) {
      const ownerContent = await fs.promises.readFile(ownerXmlPath, 'utf-8');
      requireDocumentWriteFormatProfile(ownerContent);
      const parsed = xmlParser.parse(ownerContent);
      const state = { changed: false };
      const updated = removeDesignerFormFromOwnerInParsed(parsed, node.name, state);
      if (state.changed) {
        steps.push({
          type: 'writeFile',
          targetPath: ownerXmlPath,
          content: buildXmlString(updated),
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent(ownerContent) },
        });
      }
    }
  }

  // 2. Delete form files
  const lower = fp.toLowerCase();
  if (lower.endsWith('.xml')) {
    const extRoot = path.join(path.dirname(fp), path.basename(fp, path.extname(fp)));
    steps.push({
      type: 'deletePath',
      targetPath: fp,
      expected: await readMutationExpectation(fp),
    });
    const extExpectation = await readMutationExpectation(extRoot);
    if (extExpectation.state !== 'missing') {
      steps.push({
        type: 'deletePath',
        targetPath: extRoot,
        expected: extExpectation,
      });
    }
  } else {
    steps.push({
      type: 'deletePath',
      targetPath: fp,
      expected: await readMutationExpectation(fp),
    });
  }

  const plan: MutationPlan<void> = {
    kind: 'deleteForm',
    steps,
    result: undefined,
  };

  return { plan, configRootPath };
}

export async function deleteForm(node: TreeNode): Promise<void> {
  const { plan, configRootPath } = await planDeleteForm(node);
  await runConfigurationPlan(configRootPath, plan);
  Logger.info(`Deleted form ${node.name}`);
}
