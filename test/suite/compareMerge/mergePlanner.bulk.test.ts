import * as assert from 'assert';
import * as path from 'path';

import {
  indexBslModuleSource,
  type BslModuleIdentity,
} from '../../../src/compareMerge/bsl/bslModuleIndexer';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import { hashText } from '../../../src/compareMerge/bsl/bslRoutineLogicalScanner';
import type { BslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineMergePlanTypes';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  ConfigurationCompareWorkspace,
  type ExecutableCandidateFactory,
} from '../../../src/compareMerge/configurationCompareWorkspace';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { MergeCandidate } from '../../../src/compareMerge/merge/mergePlanner';

suite('MergePlanner bulk preview', () => {
  test('workspace builds one preview from multiple selected executable nodes', async () => {
    const workspace = makeWorkspace();

    const selection = workspace.selectNodeIds(['xml:name', 'file:template', 'bsl:run']);
    const preview = await workspace.createPreviewForNodeIds(selection.executableNodeIds);

    assert.strictEqual(selection.canCreatePreview, true);
    assert.deepStrictEqual(selection.executableNodeIds, ['xml:name', 'file:template', 'bsl:run']);
    assert.strictEqual(preview.ok, true);
    assert.strictEqual(preview.preview.operationCount, 3);
    assert.deepStrictEqual(
      preview.preview.items.map((item) => item.nodeId),
      ['xml:name', 'file:template', 'bsl:run']
    );
  });
});

function makeWorkspace(): ConfigurationCompareWorkspace {
  return new ConfigurationCompareWorkspace({
    session: makeSession(),
    projection: {
      root: tree(),
      stats: { total: 4, different: 3, mergeable: 3 },
    },
    candidateFactories: new Map<string, ExecutableCandidateFactory>([
      ['xml:name', async () => ({ ok: true, candidate: xmlCandidate() })],
      ['file:template', async () => ({ ok: true, candidate: fileCandidate() })],
      ['bsl:run', async () => ({ ok: true, candidate: bslCandidate(createPlan()) })],
    ]),
    leftRootPath: path.join('repo', 'left'),
    rightRootPath: path.join('repo', 'right'),
    backupRootPath: path.join('repo', 'backups'),
    createdAt: new Date('2026-05-30T10:10:00.000Z'),
  });
}

function xmlCandidate(): MergeCandidate {
  const oldXml = '<Object><Name>Old</Name></Object>';
  const newXml = '<Object><Name>New</Name></Object>';
  return {
    kind: 'xmlNodeReplace',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'xml:name',
    targetUri: 'file:///repo/Catalogs/Products.xml',
    expectedOldHash: hashText(oldXml),
    newHash: hashText(newXml),
    xmlPatch: {
      kind: 'replaceNode',
      target: {
        filePath: 'file:///repo/Catalogs/Products.xml',
        pointer: '/Object/Name',
        displayPath: 'Object/Name',
      },
      expectedOldHash: hashText(oldXml),
      newHash: hashText(newXml),
      replacementXml: '<Name>New</Name>',
    },
  };
}

function fileCandidate(): MergeCandidate {
  return {
    kind: 'fileCopy',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'file:template',
    targetUri: 'file:///repo/Templates/Print.mxl',
    expectedOldHash: hashText('old template'),
    newHash: hashText('new template'),
    fileOperation: {
      kind: 'fileCopy',
      sourcePath: 'file:///snapshot/Templates/Print.mxl',
      targetPath: 'file:///repo/Templates/Print.mxl',
      expectedOldHash: hashText('old template'),
      sourceHash: hashText('new template'),
      destructive: false,
    },
  };
}

function bslCandidate(plan: BslRoutineLogicalMergePlan): MergeCandidate {
  const current = snapshot(baseRoutine());
  return {
    kind: 'bslLogicalRoutineMerge',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'bsl:run',
    targetUri: 'file:///repo/Catalogs/Products/Ext/ObjectModule.bsl',
    expectedOldHash: hashText(baseRoutine()),
    newHash: hashText(incomingRoutine()),
    logicalRoutine: {
      moduleId: 'Catalog.Products.Object',
      current,
      plan,
    },
  };
}

function tree(): CompareTreeNode {
  return {
    id: 'root',
    label: 'Root',
    kind: 'configCompare',
    status: 'changed',
    children: [
      node('xml:name', 'Name', 'metadataXml'),
      node('file:template', 'Print.mxl', 'binaryFile'),
      node('bsl:run', 'Run', 'bslRoutine'),
    ],
  };
}

function node(id: string, label: string, kind: string): CompareTreeNode {
  return {
    id,
    label,
    kind,
    status: 'changed',
    mergeable: true,
    mergeState: { state: 'ready' },
    children: [],
  };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Current workspace',
        rootUri: 'file:///repo',
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'snapshot',
        displayName: 'Incoming snapshot',
        rootUri: 'file:///snapshot',
        writable: false,
      },
    ],
  });
  session.registerSnapshot(snapshotContract('snapshot-left-1', 'left-source', 'left'));
  session.registerSnapshot(snapshotContract('snapshot-right-1', 'right-source', 'right'));
  return session;
}

function snapshotContract(snapshotId: string, sourceId: string, side: string) {
  return {
    snapshotId,
    sourceId,
    snapshotRoot: `file:///snapshot/${side}`,
    origin: `file:///${side}`,
    createdAt: '2026-05-30T10:00:00.000Z',
    retentionUntil: '2026-05-30T12:00:00.000Z',
    sourceRevision: `test:${side}`,
    readOnly: side === 'right',
    cleanupPolicy: 'manual' as const,
    contentHash: `sha256:${side}`,
  };
}

function createPlan(): BslRoutineLogicalMergePlan {
  const base = snapshot(baseRoutine());
  return createBslRoutineLogicalMergePlan({
    moduleId: 'Catalog.Products.Object',
    base,
    current: base,
    incoming: snapshot(incomingRoutine()),
  });
}

function snapshot(source: string) {
  const module = indexBslModuleSource({
    identity: makeIdentity(),
    source,
  });
  return {
    source,
    routine: module.routines[0],
  };
}

function makeIdentity(): BslModuleIdentity {
  return {
    sourceId: 'left-source',
    side: 'left',
    filePath: path.join('repo', 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
    configRoot: 'repo',
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}

function baseRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}

function incomingRoutine(): string {
  return [
    'Procedure Run()',
    '  If A Then',
    '    A = 1;',
    '  EndIf;',
    '  Try',
    '    C = 1;',
    '  Except',
    '    C = 0;',
    '  EndTry;',
    '  If B Then',
    '    B = 1;',
    '  EndIf;',
    'EndProcedure',
  ].join('\n');
}
