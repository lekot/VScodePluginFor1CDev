import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createElement } from '../../src/services/elementOperations';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { XMLWriter } from '../../src/utils/XMLWriter';
import {
  cleanupTempDir,
  createConfigNode,
  createTempDir,
} from '../helpers/testHelpers';
import { installDirectConfigurationMutationEngineForTests } from '../helpers/directConfigurationMutationEngine';

suite('AccumulationRegister Attribute default XML integration', () => {
  let tmpDir: string;
  let restoreMutationEngine: (() => void) | undefined;

  suiteSetup(() => {
    restoreMutationEngine = installDirectConfigurationMutationEngineForTests();
  });

  suiteTeardown(() => {
    restoreMutationEngine?.();
    restoreMutationEngine = undefined;
  });

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-issue397-');
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  test('createElement omits unsupported defaults and retains supported register defaults', async () => {
    const registersPath = path.join(tmpDir, 'AccumulationRegisters');
    const registerPath = path.join(registersPath, 'Repro.xml');
    await fs.promises.mkdir(registersPath, { recursive: true });
    await XMLWriter.createMinimalElementFile(registerPath, 'AccumulationRegister', 'Repro', '2.20');

    const configNode = createConfigNode();
    const registersNode: TreeNode = {
      id: 'AccumulationRegisters',
      name: 'Накопительные регистры',
      type: MetadataType.AccumulationRegister,
      properties: {},
      filePath: registersPath,
      parent: configNode,
    };
    const registerNode: TreeNode = {
      id: 'AccumulationRegisters.Repro',
      name: 'Repro',
      type: MetadataType.AccumulationRegister,
      properties: {},
      filePath: registerPath,
      parent: registersNode,
    };

    await createElement(registerNode, 'AttributeProbe');

    const xml = await fs.promises.readFile(registerPath, 'utf8');
    const attributeXml = xml.match(/<Attribute\b[\s\S]*?<\/Attribute>/)?.[0];
    assert.ok(attributeXml, 'createElement writes the nested Attribute to the register XML');
    assert.match(attributeXml, /<Name>AttributeProbe<\/Name>/);
    assert.doesNotMatch(attributeXml, /<DataHistory(?:\s|>)/);
    assert.doesNotMatch(attributeXml, /<FillValue(?:\s|>)/);
    assert.doesNotMatch(attributeXml, /<FillFromFillingValue(?:\s|>)/);
    assert.match(attributeXml, /<Indexing>DontIndex<\/Indexing>/);
    assert.match(attributeXml, /<FullTextSearch>Use<\/FullTextSearch>/);
  });
});
