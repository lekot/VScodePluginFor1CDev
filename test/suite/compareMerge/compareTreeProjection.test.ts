import * as assert from 'assert';
import * as path from 'path';

import type { BslRoutineInfo } from '../../../src/bsl/bslRoutineTypes';
import type { BslModuleDiagnostic, BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import type { BslRoutineDiffResult, BslRoutineDiffStatus } from '../../../src/compareMerge/bsl/bslRoutineDiff';
import type {
  CompareMessage,
  IdentityConflict,
  MatchResult,
  MetadataMatchDiagnostic,
  MetadataIdentity,
} from '../../../src/compareMerge/domain/compareContracts';
import { buildCompareTreeProjection } from '../../../src/compareMerge/projection/compareTreeProjection';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';

suite('CompareTreeProjection', () => {
  test('preserves blocking compare messages as merge-disabled diagnostic nodes', () => {
    const tree = buildCompareTreeProjection({
      messages: [
        {
          severity: 'error',
          code: 'SNAPSHOT_FAILED',
          phase: 'snapshot',
          sourceId: 'left-source',
          path: 'Configuration.xml',
          blocking: true,
          suggestedAction: 'Retry snapshot',
        },
      ],
    });

    const diagnostic = requireDiagnosticByMessage(tree.root, 'Retry snapshot');

    assert.strictEqual(diagnostic.status, 'changed');
    assert.strictEqual(diagnostic.mergeable, false);
    assert.deepStrictEqual(diagnostic.mergeState, {
      state: 'blocked',
      reason: 'Retry snapshot',
    });
    assert.ok(diagnostic.id.includes('SNAPSHOT_FAILED'));
    assert.ok(diagnostic.id.includes('sourceId%3Dleft-source'));
    assert.ok(diagnostic.payloadRef?.includes('sourceId=left-source'));
    assert.ok(diagnostic.payloadRef?.includes('path=Configuration.xml'));
  });

  test('projects identity conflicts as selectable metadata conflict nodes but keeps them merge-disabled', () => {
    const conflict = identityConflict({
      kind: 'sameNameDifferentUuid',
      blocking: true,
      message: 'Catalog.Products has different uuids.',
      identities: [
        metadataIdentity('left', 'Catalog.Products', 'left-uuid'),
        metadataIdentity('right', 'Catalog.Products', 'right-uuid'),
      ],
    });
    const tree = buildCompareTreeProjection({
      metadata: matchResult({ conflicts: [conflict] }),
    });

    const conflictNode = requireNodeByLabel(tree.root, 'Catalog.Products');

    assert.strictEqual(conflictNode.kind, 'metadataConflict');
    assert.strictEqual(conflictNode.status, 'changed');
    assert.strictEqual(conflictNode.mergeable, false);
    assert.ok(conflictNode.id.includes('sameNameDifferentUuid'));
    assert.ok(conflictNode.payloadRef?.includes('kind=sameNameDifferentUuid'));
    assert.deepStrictEqual(conflictNode.conflict, {
      kind: 'sameNameDifferentUuid',
      blocking: true,
      message: 'Catalog.Products has different uuids.',
    });
    assert.strictEqual(conflictNode.mergeState?.state, 'identityConflict');
  });

  test('projects registered BSL routine factories as mergeable including structural changes', () => {
    const tree = buildCompareTreeProjection({
      bsl: [
        {
          diff: bslDiff([
            ['changedRoutine', 'changed'],
            ['addedRoutine', 'added'],
            ['deletedRoutine', 'deleted'],
            ['reorderedRoutine', 'reordered'],
          ]),
          targetFilePath: path.join('left', 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
          mergeableRoutineIds: [
            'bsl:routine:Catalog.Products.Object:changedroutine',
            'bsl:routine:Catalog.Products.Object:addedroutine',
            'bsl:routine:Catalog.Products.Object:deletedroutine',
          ],
        },
      ],
    });

    const moduleNode = requireNode(tree.root, 'bsl:module:Catalog.Products.Object');
    const statuses = moduleNode.children.map((node) => [
      node.label,
      node.status,
      node.mergeable,
      node.mergeState?.state,
    ]);

    assert.deepStrictEqual(statuses, [
      ['changedRoutine', 'changed', true, 'ready'],
      ['addedRoutine', 'rightOnly', true, 'ready'],
      ['deletedRoutine', 'leftOnly', true, 'ready'],
      ['reorderedRoutine', 'changed', false, 'readOnly'],
    ]);
  });

  test('keeps added and deleted BSL routines read-only without registered factory', () => {
    const tree = buildCompareTreeProjection({
      bsl: [
        {
          diff: bslDiff([
            ['addedRoutine', 'added'],
            ['deletedRoutine', 'deleted'],
          ]),
          targetFilePath: path.join('left', 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
          mergeableRoutineIds: [],
        },
      ],
    });

    assert.strictEqual(
      requireNode(tree.root, 'bsl:routine:Catalog.Products.Object:addedroutine').mergeable,
      false
    );
    assert.strictEqual(
      requireNode(tree.root, 'bsl:routine:Catalog.Products.Object:addedroutine').mergeState?.state,
      'readOnly'
    );
    assert.strictEqual(
      requireNode(tree.root, 'bsl:routine:Catalog.Products.Object:deletedroutine').mergeable,
      false
    );
    assert.strictEqual(
      requireNode(tree.root, 'bsl:routine:Catalog.Products.Object:deletedroutine').mergeState?.state,
      'readOnly'
    );
  });

  test('does not mark changed BSL routine mergeable when service did not prove auto plan', () => {
    const tree = buildCompareTreeProjection({
      bsl: [
        {
          diff: bslDiff([['Save', 'changed']]),
          targetFilePath: 'Catalogs/Products/Ext/ObjectModule.bsl',
          mergeableRoutineIds: [],
        },
      ],
    });

    assert.strictEqual(requireNode(tree.root, 'bsl:routine:Catalog.Products.Object:save').mergeable, false);
  });

  test('marks BSL routine nodes mergeable only with unambiguous target and no blocking diagnostics', () => {
    const readyTree = buildCompareTreeProjection({
      bsl: [{ diff: bslDiff([['Save', 'changed']]), targetFilePath: 'Catalogs/Products/Ext/ObjectModule.bsl' }],
    });
    const ambiguousTree = buildCompareTreeProjection({
      bsl: [
        {
          diff: bslDiff([['Save', 'changed']]),
          targetFilePath: 'Catalogs/Products/Ext/ObjectModule.bsl',
          targetAmbiguous: true,
        },
      ],
    });
    const blockedTree = buildCompareTreeProjection({
      bsl: [
        {
          diff: bslDiff([['Save', 'changed']], [
            bslDiagnostic({
              code: 'BSL_MODULE_DUPLICATE_ROUTINE',
              blocking: true,
              message: 'Duplicate routine Save.',
            }),
          ]),
          targetFilePath: 'Catalogs/Products/Ext/ObjectModule.bsl',
        },
      ],
    });

    assert.strictEqual(requireNode(readyTree.root, 'bsl:routine:Catalog.Products.Object:save').mergeable, true);
    assert.strictEqual(
      requireNode(ambiguousTree.root, 'bsl:routine:Catalog.Products.Object:save').mergeable,
      false
    );
    assert.strictEqual(
      requireNode(blockedTree.root, 'bsl:routine:Catalog.Products.Object:save').mergeable,
      false
    );
  });

  test('blocks BSL routine mergeability when external module diagnostics are blocking', () => {
    const tree = buildCompareTreeProjection({
      bsl: [
        {
          diff: bslDiff([['Save', 'changed']]),
          diagnostics: [
            bslDiagnostic({
              code: 'BSL_MODULE_READ_FAILED',
              blocking: true,
              message: 'Cannot read target module.',
            }),
          ],
          targetFilePath: 'Catalogs/Products/Ext/ObjectModule.bsl',
        },
      ],
    });

    const routineNode = requireNode(tree.root, 'bsl:routine:Catalog.Products.Object:save');

    assert.strictEqual(routineNode.mergeable, false);
    assert.deepStrictEqual(routineNode.mergeState, {
      state: 'blocked',
      reason: 'Cannot read target module.',
    });
  });

  test('uses stable parent context in BSL diagnostic ids and payload refs', () => {
    const tree = buildCompareTreeProjection({
      bsl: [
        {
          diagnostics: [
            bslDiagnostic({
              code: 'BSL_MODULE_UNSUPPORTED_KIND',
              blocking: true,
              message: 'Catalog unsupported.',
              moduleId: 'Catalog.Products.Object',
              filePath: 'Catalogs/Products/Ext/ObjectModule.bsl',
            }),
          ],
        },
        {
          diagnostics: [
            bslDiagnostic({
              code: 'BSL_MODULE_UNSUPPORTED_KIND',
              blocking: true,
              message: 'Document unsupported.',
              moduleId: 'Document.Order.Object',
              filePath: 'Documents/Order/Ext/ObjectModule.bsl',
            }),
          ],
        },
      ],
    });

    const diagnostics = collectNodes(tree.root, (node) => node.kind === 'diagnostic');

    assert.strictEqual(diagnostics.length, 2);
    assert.strictEqual(new Set(diagnostics.map((node) => node.id)).size, 2);
    assert.strictEqual(new Set(diagnostics.map((node) => node.payloadRef)).size, 2);
    assert.ok(
      diagnostics.every((node) => node.id.includes('BSL_MODULE_UNSUPPORTED_KIND')),
      'diagnostic ids keep diagnostic code visible'
    );
    assert.ok(
      diagnostics.some((node) => node.payloadRef?.includes('Catalog.Products.Object')),
      'payload ref includes first module context'
    );
    assert.ok(
      diagnostics.some((node) => node.payloadRef?.includes('Document.Order.Object')),
      'payload ref includes second module context'
    );
  });

  test('keeps BSL diagnostic id and payload ref stable when earlier same-module diagnostic is inserted', () => {
    const targetDiagnostic = bslDiagnostic({
      code: 'BSL_MODULE_DUPLICATE_ROUTINE',
      blocking: true,
      message: 'Duplicate routine Save.',
      routineName: 'Save',
      range: { startLine: 10, startColumn: 1, endLine: 12, endColumn: 13 },
    });
    const baselineTree = buildCompareTreeProjection({
      bsl: [{ diagnostics: [targetDiagnostic] }],
    });
    const shiftedTree = buildCompareTreeProjection({
      bsl: [
        {
          diagnostics: [
            bslDiagnostic({
              code: 'BSL_MODULE_DUPLICATE_ROUTINE',
              blocking: true,
              message: 'Earlier duplicate routine Validate.',
              routineName: 'Validate',
              range: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 13 },
            }),
            targetDiagnostic,
          ],
        },
      ],
    });

    const baselineDiagnostic = requireDiagnosticByMessage(baselineTree.root, 'Duplicate routine Save.');
    const shiftedDiagnostic = requireDiagnosticByMessage(shiftedTree.root, 'Duplicate routine Save.');

    assert.strictEqual(shiftedDiagnostic.id, baselineDiagnostic.id);
    assert.strictEqual(shiftedDiagnostic.payloadRef, baselineDiagnostic.payloadRef);
    assert.ok(shiftedDiagnostic.payloadRef?.includes('routineName=Save'));
    assert.ok(shiftedDiagnostic.payloadRef?.includes('range=10%3A1-12%3A13'));
  });

  test('projects unsupported diagnostics as visible blocking messages', () => {
    const tree = buildCompareTreeProjection({
      bsl: [
        {
          diagnostics: [
            bslDiagnostic({
              code: 'BSL_MODULE_UNSUPPORTED_KIND',
              blocking: true,
              message: 'BSL module kind "ValueManagerModule" is not supported by procedural diff.',
            }),
          ],
        },
      ],
    });

    const diagnostic = collectNodes(
      tree.root,
      (node) => node.kind === 'diagnostic' && node.label === 'BSL_MODULE_UNSUPPORTED_KIND'
    )[0];

    assert.ok(diagnostic, 'Expected unsupported BSL diagnostic node to exist.');

    assert.strictEqual(diagnostic.kind, 'diagnostic');
    assert.strictEqual(diagnostic.status, 'changed');
    assert.strictEqual(diagnostic.mergeable, false);
    assert.strictEqual(diagnostic.rightValue, 'BSL module kind "ValueManagerModule" is not supported by procedural diff.');
    assert.strictEqual(diagnostic.mergeState?.state, 'blocked');
  });

  test('does not expose MVP wording in user-visible merge reasons', () => {
    const tree = buildCompareTreeProjection({
      metadata: matchResult({
        matches: [
          {
            left: metadataIdentity('left', 'Catalog.Products', 'left-uuid'),
            right: metadataIdentity('right', 'Catalog.ProductsRenamed', 'left-uuid'),
            matchKind: 'uuid',
            confidence: 'strong',
          },
        ],
        unmatchedRight: [metadataIdentity('right', 'Catalog.NewProducts', 'new-uuid')],
      }),
      bsl: [
        {
          diff: bslDiff([
            ['AddedRoutine', 'added'],
            ['DeletedRoutine', 'deleted'],
            ['ReorderedRoutine', 'reordered'],
          ]),
          targetFilePath: 'Catalogs/Products/Ext/ObjectModule.bsl',
        },
      ],
    });

    const visibleText = collectNodes(tree.root, () => true)
      .flatMap((node) => [
        node.label,
        node.leftValue,
        node.rightValue,
        node.mergeState?.reason,
        node.conflict?.message,
      ])
      .filter((value): value is string => typeof value === 'string')
      .join('\n');

    assert.doesNotMatch(visibleText, /\bMVP\b/i);
  });

  test('keeps metadata diagnostic id and payload ref stable when earlier same-code diagnostic is inserted', () => {
    const targetDiagnostic = metadataDiagnostic({
      code: 'METADATA_DUPLICATE_UUID',
      message: 'Target duplicate uuid.',
      sourceId: 'right-source',
      side: 'right',
      path: 'Catalogs/Products.xml',
    });
    const baselineTree = buildCompareTreeProjection({
      metadata: matchResult({ diagnostics: [targetDiagnostic] }),
    });
    const shiftedTree = buildCompareTreeProjection({
      metadata: matchResult({
        diagnostics: [
          metadataDiagnostic({
            code: 'METADATA_DUPLICATE_UUID',
            message: 'Earlier duplicate uuid.',
            sourceId: 'left-source',
            side: 'left',
            path: 'Catalogs/Counterparties.xml',
          }),
          targetDiagnostic,
        ],
      }),
    });

    const baselineDiagnostic = requireDiagnosticByMessage(baselineTree.root, 'Target duplicate uuid.');
    const shiftedDiagnostic = requireDiagnosticByMessage(shiftedTree.root, 'Target duplicate uuid.');

    assert.strictEqual(shiftedDiagnostic.id, baselineDiagnostic.id);
    assert.strictEqual(shiftedDiagnostic.payloadRef, baselineDiagnostic.payloadRef);
  });

  test('keeps compare message id and payload ref stable when earlier same-code message is inserted', () => {
    const targetMessage = compareMessage({
      code: 'SNAPSHOT_FAILED',
      suggestedAction: 'Retry right snapshot',
      sourceId: 'right-source',
      nodeId: 'Catalog.Products',
      path: 'Catalogs/Products.xml',
    });
    const baselineTree = buildCompareTreeProjection({ messages: [targetMessage] });
    const shiftedTree = buildCompareTreeProjection({
      messages: [
        compareMessage({
          code: 'SNAPSHOT_FAILED',
          suggestedAction: 'Retry left snapshot',
          sourceId: 'left-source',
          nodeId: 'Catalog.Counterparties',
          path: 'Catalogs/Counterparties.xml',
        }),
        targetMessage,
      ],
    });

    const baselineMessage = requireDiagnosticByMessage(baselineTree.root, 'Retry right snapshot');
    const shiftedMessage = requireDiagnosticByMessage(shiftedTree.root, 'Retry right snapshot');

    assert.strictEqual(shiftedMessage.id, baselineMessage.id);
    assert.strictEqual(shiftedMessage.payloadRef, baselineMessage.payloadRef);
  });

  test('keeps identity conflict id and payload ref stable when earlier conflict is inserted', () => {
    const targetConflict = identityConflict({
      kind: 'sameNameDifferentUuid',
      blocking: true,
      message: 'Catalog.Products has different uuids.',
      identities: [
        metadataIdentity('left', 'Catalog.Products', 'left-uuid'),
        metadataIdentity('right', 'Catalog.Products', 'right-uuid'),
      ],
    });
    const baselineTree = buildCompareTreeProjection({
      metadata: matchResult({ conflicts: [targetConflict] }),
    });
    const shiftedTree = buildCompareTreeProjection({
      metadata: matchResult({
        conflicts: [
          identityConflict({
            kind: 'sameNameDifferentUuid',
            blocking: true,
            message: 'Catalog.Counterparties has different uuids.',
            identities: [
              metadataIdentity('left', 'Catalog.Counterparties', 'left-counterparties-uuid'),
              metadataIdentity('right', 'Catalog.Counterparties', 'right-counterparties-uuid'),
            ],
          }),
          targetConflict,
        ],
      }),
    });

    const baselineConflict = requireNodeByLabel(baselineTree.root, 'Catalog.Products');
    const shiftedConflict = requireNodeByLabel(shiftedTree.root, 'Catalog.Products');

    assert.strictEqual(shiftedConflict.id, baselineConflict.id);
    assert.strictEqual(shiftedConflict.payloadRef, baselineConflict.payloadRef);
    assert.ok(shiftedConflict.payloadRef?.includes('kind=sameNameDifferentUuid'));
    assert.ok(shiftedConflict.payloadRef?.includes('qualifiedName=Catalog.Products'));
    assert.ok(shiftedConflict.payloadRef?.includes('uuid=left-uuid'));
    assert.ok(shiftedConflict.payloadRef?.includes('uuid=right-uuid'));
  });
});

function requireNode(root: CompareTreeNode, id: string): CompareTreeNode {
  const found = findNode(root, id);
  assert.ok(found, `Expected node ${id} to exist.`);
  return found;
}

function requireDiagnosticByMessage(root: CompareTreeNode, message: string): CompareTreeNode {
  const found = collectNodes(
    root,
    (node) => node.kind === 'diagnostic' && node.rightValue === message
  );
  assert.strictEqual(found.length, 1, `Expected exactly one diagnostic with message ${message}.`);
  return found[0]!;
}

function requireNodeByLabel(root: CompareTreeNode, label: string): CompareTreeNode {
  const found = collectNodes(root, (node) => node.label === label);
  assert.strictEqual(found.length, 1, `Expected exactly one node with label ${label}.`);
  return found[0]!;
}

function findNode(node: CompareTreeNode, id: string): CompareTreeNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function collectNodes(
  root: CompareTreeNode,
  predicate: (node: CompareTreeNode) => boolean
): CompareTreeNode[] {
  const found: CompareTreeNode[] = [];
  visit(root, (node) => {
    if (predicate(node)) {
      found.push(node);
    }
  });
  return found;
}

function visit(node: CompareTreeNode, callback: (node: CompareTreeNode) => void): void {
  callback(node);
  for (const child of node.children) {
    visit(child, callback);
  }
}

function matchResult(input: Partial<MatchResult>): MatchResult {
  return {
    matches: input.matches ?? [],
    conflicts: input.conflicts ?? [],
    diagnostics: input.diagnostics ?? [],
    unmatchedLeft: input.unmatchedLeft ?? [],
    unmatchedRight: input.unmatchedRight ?? [],
  };
}

function metadataDiagnostic(input: {
  code: MetadataMatchDiagnostic['code'];
  message: string;
  sourceId: string;
  side: MetadataMatchDiagnostic['side'];
  path: string;
}): MetadataMatchDiagnostic {
  return {
    severity: 'error',
    code: input.code,
    phase: 'compare',
    blocking: true,
    message: input.message,
    sourceId: input.sourceId,
    side: input.side,
    path: input.path,
    identities: [],
  };
}

function compareMessage(input: {
  code: CompareMessage['code'];
  suggestedAction: string;
  sourceId: string;
  nodeId: string;
  path: string;
}): CompareMessage {
  return {
    severity: 'error',
    code: input.code,
    phase: 'snapshot',
    sourceId: input.sourceId,
    nodeId: input.nodeId,
    path: input.path,
    blocking: true,
    suggestedAction: input.suggestedAction,
  };
}

function identityConflict(input: {
  kind: IdentityConflict['kind'];
  blocking: boolean;
  message: string;
  identities: MetadataIdentity[];
}): IdentityConflict {
  return {
    kind: input.kind,
    resolution: 'manual',
    blocking: input.blocking,
    message: input.message,
    identities: input.identities,
    qualifiedName: input.identities[0]?.qualifiedName,
  };
}

function metadataIdentity(side: 'left' | 'right', qualifiedName: string, uuid: string): MetadataIdentity {
  return {
    sourceId: `${side}-source`,
    side,
    metadataType: 'Catalog',
    qualifiedName,
    uuid,
    filePath: `${side}/${qualifiedName}.xml`,
    containerPath: `${side}/Catalogs`,
    objectPath: `${side}/Catalogs/Products`,
    nameSource: 'xmlPropertiesName',
    uuidSource: 'xmlAttribute',
    confidence: 'strong',
  };
}

function bslDiff(
  statuses: Array<[string, BslRoutineDiffStatus]>,
  diagnostics: BslModuleDiagnostic[] = []
): BslRoutineDiffResult {
  const leftIdentity = bslIdentity('left');
  const rightIdentity = bslIdentity('right');
  return {
    moduleId: 'Catalog.Products.Object',
    leftIdentity,
    rightIdentity,
    routines: statuses.map(([name, status], index) => ({
      name,
      normalizedName: name.toLowerCase(),
      status,
      left: status === 'added' ? undefined : routine(name, `left-${index}`),
      right: status === 'deleted' ? undefined : routine(name, `right-${index}`),
      leftIndex: status === 'added' ? undefined : index,
      rightIndex: status === 'deleted' ? undefined : index,
    })),
    diagnostics,
    canAutoMatch: !diagnostics.some((diagnostic) => diagnostic.blocking),
    summary: {
      added: statuses.filter(([, status]) => status === 'added').length,
      changed: statuses.filter(([, status]) => status === 'changed').length,
      deleted: statuses.filter(([, status]) => status === 'deleted').length,
      reordered: statuses.filter(([, status]) => status === 'reordered').length,
      unchanged: statuses.filter(([, status]) => status === 'unchanged').length,
    },
  };
}

function bslIdentity(side: 'left' | 'right'): BslModuleIdentity {
  return {
    sourceId: `${side}-source`,
    side,
    filePath: path.join(side, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
    configRoot: side,
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}

function routine(name: string, bodyHash: string): BslRoutineInfo {
  const range = { startLine: 1, startColumn: 1, endLine: 3, endColumn: 13 };
  return {
    name,
    normalizedName: name.toLowerCase(),
    kind: 'procedure',
    range,
    signatureRange: range,
    bodyRange: range,
    bodyHash,
    exported: false,
    directives: [],
    parameterText: '',
  };
}

function bslDiagnostic(input: {
  code: BslModuleDiagnostic['code'];
  blocking: boolean;
  message: string;
  moduleId?: string;
  filePath?: string;
  routineName?: string;
  range?: BslModuleDiagnostic['range'];
}): BslModuleDiagnostic {
  return {
    severity: input.blocking ? 'error' : 'warning',
    code: input.code,
    blocking: input.blocking,
    message: input.message,
    sourceId: 'left-source',
    side: 'left',
    filePath: input.filePath ?? 'Catalogs/Products/Ext/ObjectModule.bsl',
    moduleId: input.moduleId ?? 'Catalog.Products.Object',
    routineName: input.routineName,
    range: input.range,
  };
}
