import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildConfigurationCompare,
  type ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  createExtensionCompareTempRoot,
  metadataObjectXml,
  writeCompareBytes,
  writeDesignerConfiguration,
  type ExtensionCompareObjectFixture,
} from '../../helpers/extensionCompareFixtures';

const CONFIGURATION_NAME = 'Adopted Form visibility';
const CONFIGURATION_UUID = '11111111-1111-4111-8111-111111111111';
const OWNER_UUID = '22222222-2222-4222-8222-222222222222';
const CFE_OWNER_UUID = '33333333-3333-4333-8333-333333333333';
const NEW_FORM_UUID = '44444444-4444-4444-8444-444444444444';
const NEW_FORM_NAME = 'NewEditor';
const FORM_BLOCKER_REASON = 'Формы нет в захваченной базе; для новой формы нужен связанный перенос регистрации, дескриптора и файлов';

suite('Extension adopted source-only Form visibility (#335)', () => {
  for (const direction of ['cf-to-cfe', 'cfe-to-cf'] as const) {
    test(`shows a scoped read-only Form blocker and keeps independent properties selectable (${direction})`, async () => {
      const root = await createExtensionCompareTempRoot('issue335-adopted-form-visibility-');
      const target = path.join(root, direction === 'cf-to-cfe' ? 'target-cfe' : 'target-cf');
      const base = direction === 'cf-to-cfe' ? path.join(root, 'base-cf') : target;
      const source = path.join(root, direction === 'cf-to-cfe' ? 'source-cf' : 'source-cfe');
      let result: ConfigurationCompareResult | undefined;
      try {
        const baseOwner = ownerFixture({ synonym: 'Base value' });
        const targetOwner = direction === 'cf-to-cfe'
          ? ownerFixture({ synonym: 'Base value', adopted: true })
          : ownerFixture({ synonym: 'Current target value' });
        const sourceOwner = direction === 'cf-to-cfe'
          ? ownerFixture({ synonym: 'Incoming value', registeredForm: true })
          : ownerFixture({ synonym: 'Incoming value', adopted: true, registeredForm: true });

        if (direction === 'cf-to-cfe') {
          await writeDesignerConfiguration(base, {
            uuid: CONFIGURATION_UUID,
            name: CONFIGURATION_NAME,
            objects: [baseOwner],
          });
          await writeDesignerConfiguration(target, {
            uuid: CONFIGURATION_UUID,
            name: CONFIGURATION_NAME,
            purpose: 'Customization',
            namePrefix: 'Ext_',
            objects: [targetOwner],
          });
        } else {
          await writeDesignerConfiguration(target, {
            uuid: CONFIGURATION_UUID,
            name: CONFIGURATION_NAME,
            objects: [baseOwner],
          });
        }
        await writeDesignerConfiguration(source, {
          uuid: CONFIGURATION_UUID,
          name: CONFIGURATION_NAME,
          ...(direction === 'cfe-to-cf' ? { purpose: 'Customization', namePrefix: 'Ext_' } : {}),
          objects: [mdClassesFixture(sourceOwner)],
        });

        await writeNewFormPackage(source);
        const compareInput = {
          leftRootPath: target,
          rightRootPath: source,
          backupRootPath: path.join(root, 'backups'),
          extensionBaseRoots: direction === 'cf-to-cfe' ? { left: base } : { right: target },
        } as const;
        result = await buildConfigurationCompare(compareInput);

        const nodes = collectNodes(result.projection.root);
        const row = nodes.find((node) => node.kind === 'extensionMetadataObject' && node.label === 'Catalog.Products');
        assert.ok(row, 'the matched adopted owner remains visible');

        const blocker = collectNodes(row!).find((node) => node.kind === 'extensionSemanticFile'
          && node.mergeState?.reason === FORM_BLOCKER_REASON);
        assert.ok(blocker, `the unsupported new Form remains visible as a blocker: ${JSON.stringify(collectNodes(row!).map(describeNode))}`);
        assert.strictEqual(blocker!.mergeable, false);
        assert.strictEqual(blocker!.mergeState?.state, 'blocked');
        assert.strictEqual(
          (blocker!.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/'),
          'Catalogs/Products/Forms/NewEditor/Ext/Form.xml',
          'the virtual target path is derived from the target owner, not copied from the source root',
        );
        assert.ok(blocker!.conflict?.message.includes(FORM_BLOCKER_REASON));

        const phantomFormCandidate = collectNodes(row!).find((node) => node.mergeable === true
          && (node.rightValue?.includes(NEW_FORM_NAME)
            || node.mergeState?.targetFilePath?.replace(/\\/gu, '/').includes(`/Forms/${NEW_FORM_NAME}/`)));
        assert.strictEqual(phantomFormCandidate, undefined, 'no selectable Form registration/body candidate is fabricated');

        const synonym = collectNodes(row!).find((node) => node.kind === 'xmlProperty'
          && node.rightValue?.includes('Incoming value')
          && (node.mergeState?.targetFilePath ?? '').replace(/\\/gu, '/').endsWith('/Catalogs/Products.xml'));
        assert.ok(synonym, `the independent owner property remains visible: ${JSON.stringify(collectNodes(row!).map(describeNode))}`);
        assert.strictEqual(synonym!.mergeable, true, synonym!.mergeState?.reason ?? synonym!.conflict?.message);
        const selection = result.workspace.selectNodeIds([synonym!.id]);
        assert.strictEqual(selection.canCreatePreview, true, JSON.stringify(selection));
      } finally {
        result?.workspace.dispose();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }
});

function ownerFixture(input: {
  readonly synonym: string;
  readonly adopted?: boolean;
  readonly registeredForm?: boolean;
}): ExtensionCompareObjectFixture {
  const fixture: ExtensionCompareObjectFixture = {
    type: 'Catalog',
    name: 'Products',
    uuid: input.adopted ? CFE_OWNER_UUID : OWNER_UUID,
    ...(input.adopted ? { belonging: 'Adopted' as const, anchorUuid: OWNER_UUID } : {}),
    propertiesXml: `<Synonym>${xmlEscape(input.synonym)}</Synonym>`,
    childObjectsXml: input.registeredForm ? `<Form>${NEW_FORM_NAME}</Form>` : '',
  };
  return mdClassesFixture(fixture);
}

function mdClassesFixture(fixture: ExtensionCompareObjectFixture): ExtensionCompareObjectFixture {
  const descriptorXml = metadataObjectXml(fixture)
    .replace('<MetaDataObject', '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"');
  return { ...fixture, descriptorXml };
}

async function writeNewFormPackage(root: string): Promise<void> {
  await writeCompareBytes(root, `Catalogs/Products/Forms/${NEW_FORM_NAME}.xml`,
    `<?xml version="1.0"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Form uuid="${NEW_FORM_UUID}"><Properties><Name>${NEW_FORM_NAME}</Name><Synonym>Incoming form</Synonym></Properties></Form></MetaDataObject>`);
  await writeCompareBytes(root, `Catalogs/Products/Forms/${NEW_FORM_NAME}/Ext/Form.xml`,
    '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><AutoCommandBar/><ChildItems/><Attributes/><Commands/><Parameters/></Form>');
}

function collectNodes(root: CompareTreeNode): CompareTreeNode[] {
  return [root, ...root.children.flatMap(collectNodes)];
}

function describeNode(node: CompareTreeNode): Record<string, unknown> {
  return {
    label: node.label,
    kind: node.kind,
    mergeable: node.mergeable,
    rightValue: node.rightValue,
    target: node.mergeState?.targetFilePath,
    state: node.mergeState,
  };
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
