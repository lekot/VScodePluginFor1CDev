import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const fsPromises = require('fs/promises') as typeof import('fs/promises');

async function executeBslMergePreview(input: MergeExecutorInput) {
  return executeMergeInputWithRuntime(input);
}

import {
  indexBslModuleSource,
  type BslModuleIdentity,
} from '../../../src/compareMerge/bsl/bslModuleIndexer';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { createBslRoutineLogicalMergePlan } from '../../../src/compareMerge/bsl/bslRoutineLogicalMerge';
import { hashText } from '../../../src/compareMerge/bsl/bslRoutineLogicalScanner';
import { parseBslRoutines } from '../../../src/bsl/routineRangeProvider';
import { captureBslRoutineSpan } from '../../../src/compareMerge/linkedDesignerRoutineSpan';
import { composeBslCandidates } from '../../../src/compareMerge/linkedDesignerBslMaterializer';
import type { LinkedDesignerMaterializerContext } from '../../../src/compareMerge/linkedDesignerTypes';
import type {
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalSnapshot,
} from '../../../src/compareMerge/bsl/bslRoutineMergePlanTypes';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import { formXmlAdapter } from '../../../src/compareMerge/adapters/formXmlAdapter';
import { metadataXmlAdapter } from '../../../src/compareMerge/adapters/xmlMetadataAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import type { MergeExecutorInput } from '../../../src/compareMerge/merge/mergeExecutor';
import { hashXmlText } from '../../../src/compareMerge/xml/xmlPatch';
import { executeMergeInputWithRuntime } from './mergeMutationTestSupport';
import {
  createMergePreview,
  validateMergePreflight,
  type BackupPlan,
  type MergeCandidate,
  type MergeOperation,
  type PreflightResult,
  type RollbackPlan,
} from '../../../src/compareMerge/merge/mergePlanner';

suite('MergeExecutor XML and file operations', () => {
  const tempDirs: string[] = [];

  teardown(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
    );
  });

  test('applies XML patch, file copy and existing BSL logical operation in one approved preview', async () => {
    const context = await createContext(tempDirs);
    const preflight = createApprovedPreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(
      result.applied.map((item) => item.kind),
      ['xmlNodeReplace', 'fileCopy', 'bslLogicalRoutineMerge']
    );
    assert.strictEqual(await readText(context.xmlPath), context.nextXml);
    assert.strictEqual(await readText(context.fileTargetPath), context.fileSource);
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
    assert.strictEqual(await readText(context.xmlBackupPath), context.oldXml);
    assert.strictEqual(await readText(context.fileBackupPath), context.fileTargetOld);
    assert.strictEqual(await readText(context.bslBackupPath), context.oldBsl);
  });

  test('applies selected adapter XML property patch with selector pointer only', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-adapter-xml-'));
    tempDirs.push(rootDir);
    const snapshotDir = path.join(rootDir, 'snapshot');
    const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
    tempDirs.push(backupDir);
    const xmlPath = path.join(rootDir, 'Catalogs', 'Products.xml');
    const sourcePath = path.join(snapshotDir, 'Catalogs', 'Products.xml');
    const backupPath = path.join(backupDir, 'Products.xml.bak');
    const leftXml = '\uFEFF' + [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>Old goods</Synonym>',
      '    <Comment>Keep local comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\r\n') + '\r\n';
    const rightXml = '\uFEFF' + [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>New goods</Synonym>',
      '    <Comment>Incoming comment not selected</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\r\n') + '\r\n';
    const expectedXml = '\uFEFF' + [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>New goods</Synonym>',
      '    <Comment>Keep local comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\r\n') + '\r\n';

    await fs.mkdir(path.dirname(xmlPath), { recursive: true });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(xmlPath, leftXml, 'utf8');
    await fs.writeFile(sourcePath, rightXml, 'utf8');

    const session = await makeSession(rootDir, snapshotDir);
    const adapterResult = await metadataXmlAdapter.compare(
      makeXmlAdapterInput(session, rootDir, snapshotDir, xmlPath, leftXml, rightXml)
    );
    const synonym = requireTreeNodeByLabel(adapterResult.nodes, 'Synonym');
    const candidateResult = await adapterResult.candidateFactories.get(synonym.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const candidate = candidateResult.candidate;
    const sourceWitness = candidate.xmlPatch?.sourceWitnesses?.find((item) => item.sourceId === 'right-source');
    assert.strictEqual(sourceWitness?.expectedHash, createHash('sha256').update(Buffer.from(rightXml, 'utf8')).digest('hex'));

    const previewId = 'preview-selected-xml-property';
    const preview = createMergePreview({
      session,
      previewId,
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [candidate],
      currentTargetHashes: {
        [candidate.targetUri!]: hashText(leftXml),
      },
    });
    assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

    session.approvePreview(previewId);
    const operationId = preview.preview.operations[0].operationId;
    const preflight = validateMergePreflight({
      session,
      previewId,
      approvedPreviewId: previewId,
      currentTargetHashes: {
        [candidate.targetUri!]: hashText(leftXml),
      },
      backupPlan: {
        previewId,
        strategy: 'copyBeforeWrite',
        items: [
          {
            operationId,
            targetUri: candidate.targetUri!,
            backupUri: pathToFileURL(backupPath).toString(),
            expectedOldHash: hashText(leftXml),
          },
        ],
      },
      rollbackPlan: {
        previewId,
        strategy: 'restoreBackups',
        items: [
          {
            operationId,
            targetUri: candidate.targetUri!,
            backupUri: pathToFileURL(backupPath).toString(),
            restoreHash: hashText(leftXml),
          },
        ],
      },
    });
    assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));

    const result = await executeBslMergePreview({ session, preflight });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), ['xmlNodeReplace']);
    assert.strictEqual(await readText(xmlPath), expectedXml);
    assert.strictEqual(await readText(backupPath), leftXml);
  });

  test('applies multiple selected XML property patches from the same file as one atomic write', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-adapter-xml-bulk-'));
    tempDirs.push(rootDir);
    const snapshotDir = path.join(rootDir, 'snapshot');
    const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
    tempDirs.push(backupDir);
    const xmlPath = path.join(rootDir, 'Catalogs', 'Products.xml');
    const sourcePath = path.join(snapshotDir, 'Catalogs', 'Products.xml');
    const firstBackupPath = path.join(backupDir, 'Products.first.xml.bak');
    const secondBackupPath = path.join(backupDir, 'Products.second.xml.bak');
    const leftXml = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>Old goods</Synonym>',
      '    <Comment>Keep local comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');
    const rightXml = [
      '<MetaDataObject>',
      '  <Properties>',
      '    <Name>Products</Name>',
      '    <Synonym>New goods</Synonym>',
      '    <Comment>Incoming comment</Comment>',
      '  </Properties>',
      '</MetaDataObject>',
    ].join('\n');

    await fs.mkdir(path.dirname(xmlPath), { recursive: true });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(xmlPath, leftXml, 'utf8');
    await fs.writeFile(sourcePath, rightXml, 'utf8');

    const session = await makeSession(rootDir, snapshotDir);
    const adapterResult = await metadataXmlAdapter.compare(
      makeXmlAdapterInput(session, rootDir, snapshotDir, xmlPath, leftXml, rightXml)
    );
    const synonym = requireTreeNodeByLabel(adapterResult.nodes, 'Synonym');
    const comment = requireTreeNodeByLabel(adapterResult.nodes, 'Comment');
    const firstCandidateResult = await adapterResult.candidateFactories.get(synonym.id)!();
    const secondCandidateResult = await adapterResult.candidateFactories.get(comment.id)!();
    assert.strictEqual(firstCandidateResult.ok, true);
    assert.strictEqual(secondCandidateResult.ok, true);
    const candidates = [firstCandidateResult.candidate, secondCandidateResult.candidate];

    const previewId = 'preview-bulk-xml-properties';
    const preview = createMergePreview({
      session,
      previewId,
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates,
      currentTargetHashes: {
        [candidates[0].targetUri!]: hashText(leftXml),
      },
    });
    assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

    session.approvePreview(previewId);
    const preflight = validateMergePreflight({
      session,
      previewId,
      approvedPreviewId: previewId,
      currentTargetHashes: {
        [candidates[0].targetUri!]: hashText(leftXml),
      },
      backupPlan: {
        previewId,
        strategy: 'copyBeforeWrite',
        items: preview.preview.operations.map((operation, index) => ({
          operationId: operation.operationId,
          targetUri: operation.targetUri!,
          backupUri: pathToFileURL(index === 0 ? firstBackupPath : secondBackupPath).toString(),
          expectedOldHash: hashText(leftXml),
        })),
      },
      rollbackPlan: {
        previewId,
        strategy: 'restoreBackups',
        items: preview.preview.operations.map((operation, index) => ({
          operationId: operation.operationId,
          targetUri: operation.targetUri!,
          backupUri: pathToFileURL(index === 0 ? firstBackupPath : secondBackupPath).toString(),
          restoreHash: hashText(leftXml),
        })),
      },
    });
    assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));

    const result = await executeBslMergePreview({ session, preflight });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), [
      'xmlNodeReplace',
      'xmlNodeReplace',
    ]);
    assert.strictEqual(await readText(xmlPath), rightXml);
    assert.strictEqual(await readText(firstBackupPath), leftXml);
  });

  test('previews, approves, and executes a Designer placement together with a selected descendant property', async () => {
    const context = await createFormMoveContext(tempDirs, 'preview-designer-placement-e2e');
    const { preflight, backupPaths } = createApprovedFormMovePreflight(context);

    const result = await executeBslMergePreview({ session: context.session, preflight });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(
      result.applied.map((operation) => operation.kind),
      ['xmlNodeMove', 'xmlNodeReplace'],
    );
    const mergedXml = await readText(context.xmlPath);
    assert.ok(mergedXml.indexOf('UsualGroup name="Destination" id="200"') <
      mergedXml.indexOf('InputField name="Field" id="101"'));
    assert.ok(mergedXml.indexOf('InputField name="Field" id="101"') <
      mergedXml.indexOf('Button name="Stay" id="201"'));
    assert.match(mergedXml, /<Title(?:\s[^>]*)?>Incoming title<\/Title>/u);
    assert.match(mergedXml, /<FutureSetting>target-only<\/FutureSetting>/u);
    assert.deepStrictEqual(await Promise.all(backupPaths.map((backupPath) => readText(backupPath))), [
      context.leftXml,
      context.leftXml,
    ]);
  });

  test('rejects a stale incoming Form.xml witness during leased execution before writing the target', async () => {
    const context = await createFormMoveContext(tempDirs, 'preview-designer-placement-stale-witness');
    const { preflight, backupPaths } = createApprovedFormMovePreflight(context);
    await fs.writeFile(context.sourcePath, context.rightXml.replace('Incoming title', 'Changed after preview'), 'utf8');

    const result = await executeBslMergePreview({ session: context.session, preflight });

    assert.strictEqual(result.applied.length, 0);
    assert.ok(result.failed.length >= 1);
    assert.ok(result.failed.every((operation) => operation.code === 'MERGE_WITNESS_MISMATCH'));
    assert.strictEqual(await readText(context.xmlPath), context.leftXml);
    assert.deepStrictEqual(await Promise.all(backupPaths.map(exists)), backupPaths.map(() => false));
  });

  test('rejects a changed target-side dependency witness under lease before any XML write', async () => {
    const context = await createFormMoveContext(tempDirs, 'preview-designer-placement-stale-target-dependency', true);
    const { preflight, backupPaths } = createApprovedFormMovePreflight(context);
    const changedOwnerDescriptor = '<MetaDataObject version="2.20"><Configuration><Comment>changed</Comment></Configuration></MetaDataObject>';
    assert.notStrictEqual(
      hashText(await readText(context.ownerDescriptorPath)),
      hashText(changedOwnerDescriptor),
      'the fixture mutation must change the raw dependency bytes',
    );
    await fs.writeFile(context.ownerDescriptorPath, changedOwnerDescriptor, 'utf8');

    const result = await executeBslMergePreview({ session: context.session, preflight });

    assert.strictEqual(result.applied.length, 0);
    assert.ok(result.failed.length >= 1, JSON.stringify(result.failed));
    assert.ok(result.failed.every((operation) => operation.code === 'MERGE_WITNESS_MISMATCH'), JSON.stringify(result.failed));
    assert.strictEqual(await readText(context.xmlPath), context.leftXml);
    assert.deepStrictEqual(await Promise.all(backupPaths.map(exists)), backupPaths.map(() => false));
  });

  test('rejects semantically invalid final XML before writing the target', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-semantic-xml-invalid-'));
    tempDirs.push(rootDir);
    const snapshotDir = path.join(rootDir, 'snapshot');
    const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
    tempDirs.push(backupDir);
    const xmlPath = path.join(rootDir, 'Catalogs', 'Products', 'Forms', 'Edit', 'Ext', 'Form.xml');
    const sourcePath = path.join(snapshotDir, 'Catalogs', 'Products', 'Forms', 'Edit', 'Ext', 'Form.xml');
    const backupPath = path.join(backupDir, 'Form.xml.bak');
    const leftXml = '<Form><ChildItems><InputField name="A" id="1"/><InputField name="B" id="2"/></ChildItems><Attributes/><Commands/></Form>';
    const rightXml = leftXml.replace('id="2"', 'id="1"');
    const targetUri = pathToFileURL(xmlPath).toString();

    await fs.mkdir(path.dirname(xmlPath), { recursive: true });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(xmlPath, leftXml, 'utf8');
    await fs.writeFile(sourcePath, rightXml, 'utf8');

    const session = await makeSession(rootDir, snapshotDir);
    const candidate: MergeCandidate = {
      kind: 'xmlNodeReplace',
      sourceId: 'right-source',
      snapshotId: 'snapshot-right-1',
      nodeId: 'xml:form:duplicate-id',
      targetUri,
      expectedOldHash: hashXmlText(leftXml),
      newHash: hashXmlText(rightXml),
      xmlPatch: {
        kind: 'replaceNode',
        target: {
          filePath: targetUri,
          pointer: '/Form/ChildItems/InputField[1]',
          displayPath: 'Form/ChildItems/InputField[1]',
        },
        expectedOldHash: hashXmlText(leftXml),
        newHash: hashXmlText(rightXml),
        replacementXml: '<InputField name="B" id="1"/>',
        semanticKind: 'formXml',
        sourceWitnesses: [{
          sourceId: 'right-source',
          relativePath: path.relative(snapshotDir, sourcePath),
          expectedHash: createHash('sha256').update(Buffer.from(rightXml, 'utf8')).digest('hex'),
          kind: 'file',
        }],
      },
    };
    const previewId = 'preview-semantic-xml-invalid';
    const preview = createMergePreview({
      session,
      previewId,
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:00.000Z',
      candidates: [candidate],
      currentTargetHashes: { [targetUri]: hashXmlText(leftXml) },
    });
    assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));
    const operation = preview.preview.operations[0]!;
    session.approvePreview(previewId);
    const preflight = validateMergePreflight({
      session,
      previewId,
      approvedPreviewId: previewId,
      currentTargetHashes: { [targetUri]: hashXmlText(leftXml) },
      backupPlan: {
        previewId,
        strategy: 'copyBeforeWrite',
        items: [{ operationId: operation.operationId, targetUri, backupUri: pathToFileURL(backupPath).toString(), expectedOldHash: hashXmlText(leftXml) }],
      },
      rollbackPlan: {
        previewId,
        strategy: 'restoreBackups',
        items: [{ operationId: operation.operationId, targetUri, backupUri: pathToFileURL(backupPath).toString(), restoreHash: hashXmlText(leftXml) }],
      },
    });
    assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));

    const result = await executeBslMergePreview({ session, preflight });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed[0]?.code, 'XML_FORM_DUPLICATE_ID');
    assert.strictEqual(await readText(xmlPath), leftXml);
    assert.strictEqual(await exists(backupPath), false);
  });

  test('applies BSL routine insert from incoming source text', async () => {
    const context = await createRoutineChangeContext(tempDirs, 'bslRoutineInsert');
    const preflight = createApprovedRoutinePreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), ['bslRoutineInsert']);
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
    assert.strictEqual(await readText(context.bslBackupPath), context.oldBsl);
  });

  test('applies BSL routine delete from target source range', async () => {
    const context = await createRoutineChangeContext(tempDirs, 'bslRoutineDelete');
    const preflight = createApprovedRoutinePreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.deepStrictEqual(result.applied.map((item) => item.kind), ['bslRoutineDelete']);
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
    assert.strictEqual(await readText(context.bslBackupPath), context.oldBsl);
  });

  test('allows deleting the last procedure or function with English or Russian module directive', async () => {
    for (const routineCase of [
      { kind: 'procedure' as const, directive: '&AtClient', text: deletedRoutine() },
      { kind: 'procedure' as const, directive: '&НаКлиенте', text: ['Процедура Removed()', '  Value = 0;', 'КонецПроцедуры'].join('\n') },
      { kind: 'function' as const, directive: '&AtClient', text: ['Function Removed()', '  Return 0;', 'EndFunction'].join('\n') },
      { kind: 'function' as const, directive: '&НаКлиенте', text: ['Функция Removed()', '  Возврат 0;', 'КонецФункции'].join('\n') },
    ]) {
      const context = await createRoutineChangeContext(tempDirs, 'bslRoutineDelete', true, {
        leaveEmptyAfterDelete: true,
        routineKind: routineCase.kind,
        routineText: routineCase.text,
      });
      const preflight = createApprovedRoutinePreflight(context);
      const result = await executeBslMergePreview({ session: context.session, preflight });

      assert.strictEqual(result.failed.length, 0, `${routineCase.kind} ${routineCase.directive}: ${JSON.stringify(result.failed)}`);
      assert.deepStrictEqual(result.applied.map((item) => item.kind), ['bslRoutineDelete']);
      assert.strictEqual(await readText(context.bslPath), '');
    }
  });

  test('deletes an annotated BSL routine together with its target directive envelope', async () => {
    const context = await createRoutineChangeContext(tempDirs, 'bslRoutineDelete', true);
    const preflight = createApprovedRoutinePreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
    assert.strictEqual((await readText(context.bslPath)).includes('&AtClient'), false);
  });

  test('inserts an annotated BSL routine with its source directive', async () => {
    const context = await createRoutineChangeContext(tempDirs, 'bslRoutineInsert', true);
    const preflight = createApprovedRoutinePreflight(context);
    assert.ok(preflight.operations[0]?.bslRoutine?.sourceTextRange);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.failed.length, 0, JSON.stringify(result.failed));
    assert.strictEqual(await readText(context.bslPath), context.nextBsl);
  });

  test('rejects a decorated BSL routine delete without a target text envelope', async () => {
    const context = await createRoutineChangeContext(tempDirs, 'bslRoutineDelete', true);
    const candidate = routineChangeCandidate('bslRoutineDelete', context.targetUri, context.oldBsl, context.nextBsl, true);
    candidate.bslRoutine!.targetTextRange = undefined;
    const preview = createMergePreview({
      session: context.session,
      previewId: 'preview-bsl-delete-without-envelope',
      targetSourceId: 'left-source',
      snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
      createdAt: '2026-05-30T10:10:01.000Z',
      candidates: [candidate],
      currentTargetHashes: { [context.targetUri]: hashText(context.oldBsl) },
    });

    assert.strictEqual(preview.ok, false);
    assert.ok(preview.diagnostics.some((diagnostic) => diagnostic.code === 'MERGE_BSL_ROUTINE_TARGET_TEXT_RANGE_MISSING'));
  });

  test('fails closed for nested English and Russian conditional compilation around a routine', () => {
    const source = [
      '#If Client Then',
      '#Если Сервер Тогда',
      'Procedure NestedConditionals()',
      'EndProcedure',
      '#КонецЕсли',
      '#EndIf',
      '// #Если НеУчитывать Тогда',
      '// #КонецЕсли',
      'Procedure OutsideConditionals()',
      'EndProcedure',
    ].join('\n');
    const routines = parseBslRoutines(source).routines;
    const nested = routines.find((routine) => routine.normalizedName === 'nestedconditionals');
    const outside = routines.find((routine) => routine.normalizedName === 'outsideconditionals');
    assert.ok(nested);
    assert.ok(outside);
    assert.strictEqual(captureBslRoutineSpan(source, nested!), undefined);
    assert.ok(captureBslRoutineSpan(source, outside!), 'comment text that resembles directives must not open a conditional block');
  });

  test('captures Russian and English routine directives across blank and comment-only lines', () => {
    const source = [
      '&НаКлиенте',
      '// attached annotation comment',
      '',
      '&Before("Open")',
      '// comment between annotations and routine',
      'Procedure Decorated() AtClient',
      'EndProcedure',
    ].join('\n');
    const routine = parseBslRoutines(source).routines.find((item) => item.normalizedName === 'decorated');
    assert.ok(routine);
    const captured = captureBslRoutineSpan(source, routine!);
    assert.ok(captured);
    assert.strictEqual(captured!.sourceTextRange.startLine, 1);
    assert.strictEqual(captured!.sourceText, source);
  });

  test('keeps a single leading BOM while composing multiple annotated routines from a BOM source module', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-bsl-bom-batch-'));
    tempDirs.push(rootDir);
    const snapshotDir = path.join(rootDir, 'snapshot');
    const relativePath = path.join('Catalogs', 'Products', 'Forms', 'Edit', 'Ext', 'Module.bsl');
    const targetPath = path.join(rootDir, relativePath);
    const sourcePath = path.join(snapshotDir, relativePath);
    const targetContent = '\uFEFFProcedure Existing()\r\nEndProcedure\r\n';
    const sourceContent = [
      '\uFEFF&НаКлиенте',
      'Procedure AddedOnClient()',
      'EndProcedure',
      '&НаСервере',
      'Function AddedOnServer()',
      '    Return True;',
      'EndFunction',
    ].join('\r\n') + '\r\n';
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(targetPath, targetContent, 'utf8');
    await fs.writeFile(sourcePath, sourceContent, 'utf8');
    const session = await makeSession(rootDir, snapshotDir);
    const sourceRoutines = parseBslRoutines(sourceContent).routines;
    assert.strictEqual(sourceRoutines.length, 2);
    const spans = sourceRoutines.map((routine) => captureBslRoutineSpan(sourceContent, routine));
    assert.ok(spans.every((span) => span), 'each source routine must have an exact envelope');
    assert.strictEqual(spans[0]!.sourceText, [
      '&НаКлиенте',
      'Procedure AddedOnClient()',
      'EndProcedure',
    ].join('\r\n'));
    assert.strictEqual(spans[0]!.sourceTextRange.startColumn, 2, 'the source BOM stays outside the first routine envelope');

    const targetUri = pathToFileURL(targetPath).toString();
    const targetHash = hashTestBuffer(Buffer.from(targetContent, 'utf8'));
    const sourceHash = hashTestBuffer(Buffer.from(sourceContent, 'utf8'));
    const candidates: MergeCandidate[] = sourceRoutines.map((routine, index) => ({
      kind: 'bslRoutineInsert',
      sourceId: 'right-source',
      snapshotId: 'snapshot-right-1',
      nodeId: `bsl-routine:${routine.normalizedName}`,
      targetUri,
      expectedOldHash: targetHash,
      newHash: sourceHash,
      bslRoutine: {
        kind: 'insertRoutine',
        targetPath: targetUri,
        expectedOldHash: targetHash,
        newHash: sourceHash,
        routine: {
          name: routine.name,
          normalizedName: routine.normalizedName,
          kind: routine.kind,
          exported: routine.exported,
        },
        sourceText: spans[index]!.sourceText,
        sourceRange: routine.range,
        sourceTextRange: spans[index]!.sourceTextRange,
      },
    }));
    const context: LinkedDesignerMaterializerContext = {
      targetRootPath: rootDir,
      sourceRootPath: snapshotDir,
      targetSourceId: 'left-source',
      sourceId: 'right-source',
      rightSnapshotId: 'snapshot-right-1',
      session,
      candidateFactories: new Map(),
      packagesByNodeId: new Map(),
      formModules: [{
        moduleId: 'Catalog.Products.Form.Edit.Module',
        targetRelativePath: relativePath,
        sourceRelativePath: relativePath,
        targetHash,
        sourceHash,
        targetContent,
        sourceContent,
        routineCandidateIds: new Map(),
      }],
    };
    const composed = await composeBslCandidates(context, candidates);
    assert.ok('outputs' in composed, JSON.stringify('diagnostics' in composed ? composed.diagnostics : []));
    const result = [...composed.outputs.values()][0]!;
    assert.ok(result.startsWith('\uFEFF'), 'the target BOM remains at offset zero');
    assert.strictEqual(result.indexOf('\uFEFF', 1), -1, 'the source BOM must not be copied into the target body');
    assert.ok(result.includes('&НаКлиенте\r\nProcedure AddedOnClient()'));
    assert.ok(result.includes('&НаСервере\r\nFunction AddedOnServer()'));
    assert.ok(result.includes('Procedure Existing()'), 'unselected target routines remain intact');
  });

  test('ignores conditional-looking lines inside a multiline BSL string', () => {
    const source = [
      'Procedure BuildText()',
      '    Text = "Start of text',
      '#Если Fake Тогда',
      '#КонецЕсли',
      'End of text";',
      'EndProcedure',
      'Procedure AfterText()',
      'EndProcedure',
    ].join('\n');
    const routine = parseBslRoutines(source).routines.find((item) => item.normalizedName === 'aftertext');
    assert.ok(routine);
    assert.ok(captureBslRoutineSpan(source, routine!), 'directive-like string lines must not block an unrelated routine');
  });

  test('rejects fileCopy source outside the right source root', async () => {
    const context = await createFileCopyOnlyContext(tempDirs, { sourceOutsideRightRoot: true });
    const preflight = createApprovedFileCopyOnlyPreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 1, JSON.stringify(result.failed));
    assert.strictEqual(result.failed[0].operationId, context.operationId);
    assert.strictEqual(result.failed[0].code, 'MERGE_SOURCE_OUTSIDE_ROOT');
    assert.strictEqual(await readText(context.fileTargetPath), context.fileTargetOld);
  });

  test('rejects folderCopy source outside the right source root', async () => {
    const context = await createFolderCopyOnlyContext(tempDirs, { sourceOutsideRightRoot: true });
    const preflight = await createApprovedFolderCopyOnlyPreflight(context);

    const result = await executeBslMergePreview({
      session: context.session,
      preflight,
    });

    assert.strictEqual(result.applied.length, 0);
    assert.strictEqual(result.failed.length, 1, JSON.stringify(result.failed));
    assert.strictEqual(result.failed[0].operationId, context.operationId);
    assert.strictEqual(result.failed[0].code, 'MERGE_SOURCE_OUTSIDE_ROOT');
    assert.strictEqual(await readText(path.join(context.folderTargetPath, 'old.txt')), 'old folder file');
  });
});

interface ExecutionContext {
  bslBackupPath: string;
  bslPath: string;
  fileBackupPath: string;
  fileSource: string;
  fileSourcePath: string;
  fileTargetOld: string;
  fileTargetPath: string;
  nextBsl: string;
  nextXml: string;
  oldBsl: string;
  oldXml: string;
  operationIds: string[];
  previewId: string;
  session: CompareSession;
  targetUris: string[];
  xmlBackupPath: string;
  xmlPath: string;
}

interface RoutineChangeContext {
  bslBackupPath: string;
  bslPath: string;
  nextBsl: string;
  oldBsl: string;
  operationId: string;
  previewId: string;
  session: CompareSession;
  targetUri: string;
}

interface BulkRollbackContext {
  firstBackupPath: string;
  firstOperationId: string;
  firstSource: string;
  firstSourcePath: string;
  firstTargetOld: string;
  firstTargetPath: string;
  previewId: string;
  secondBackupPath: string;
  secondOperationId: string;
  secondSource: string;
  secondSourcePath: string;
  secondTargetOld: string;
  secondTargetPath: string;
  session: CompareSession;
  targetUris: string[];
}

interface FileCopyOnlyContext {
  fileBackupPath: string;
  fileSource: string;
  fileSourcePath: string;
  fileTargetOld: string;
  fileTargetPath: string;
  operationId: string;
  previewId: string;
  session: CompareSession;
  targetUri: string;
}

interface FolderCopyOnlyContext {
  folderBackupPath: string;
  folderSourcePath: string;
  folderTargetPath: string;
  operationId: string;
  previewId: string;
  session: CompareSession;
  targetUri: string;
}

interface FormMoveContext {
  backupDir: string;
  leftXml: string;
  operations: readonly MergeOperation[];
  ownerDescriptorPath: string;
  previewId: string;
  rightXml: string;
  session: CompareSession;
  sourcePath: string;
  targetUri: string;
  xmlPath: string;
}

async function createFormMoveContext(tempDirs: string[], previewId: string, includeTargetDependencyWitness = false): Promise<FormMoveContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-form-placement-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const backupDir = path.join(path.dirname(rootDir), path.basename(rootDir) + '-backups');
  tempDirs.push(backupDir);
  const relativePath = path.join('Catalogs', 'Products', 'Forms', 'Edit', 'Ext', 'Form.xml');
  const xmlPath = path.join(rootDir, relativePath);
  const sourcePath = path.join(snapshotDir, relativePath);
  const ownerDescriptorPath = path.join(rootDir, 'Catalogs', 'Products.xml');
  const ownerDescriptor = '<MetaDataObject version="2.20"><Configuration/></MetaDataObject>';
  const leftXml = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems><UsualGroup name="Source" id="100"><ChildItems><InputField name="Field" id="101"><Title>Local title</Title><FutureSetting>target-only</FutureSetting></InputField></ChildItems></UsualGroup><UsualGroup name="Destination" id="200"><ChildItems><Button name="Stay" id="201"/></ChildItems></UsualGroup></ChildItems></Form>';
  const rightXml = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems><UsualGroup name="Source" id="100"><ChildItems/></UsualGroup><UsualGroup name="Destination" id="200"><ChildItems><InputField name="Field" id="101"><Title>Incoming title</Title></InputField><Button name="Stay" id="201"/></ChildItems></UsualGroup></ChildItems></Form>';

  await fs.mkdir(path.dirname(xmlPath), { recursive: true });
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(xmlPath, leftXml, 'utf8');
  await fs.writeFile(sourcePath, rightXml, 'utf8');
  await fs.writeFile(ownerDescriptorPath, ownerDescriptor, 'utf8');

  const session = await makeSession(rootDir, snapshotDir);
  const adapterInput = makeXmlAdapterInput(session, rootDir, snapshotDir, xmlPath, leftXml, rightXml);
  const adapterResult = await formXmlAdapter.compare({
    ...adapterInput,
    artifactPaths: { left: xmlPath, right: sourcePath },
    match: {
      ...adapterInput.match,
      left: adapterInput.match.left && { ...adapterInput.match.left, descriptorPath: pathToFileURL(xmlPath).toString() },
      right: adapterInput.match.right && { ...adapterInput.match.right, descriptorPath: pathToFileURL(sourcePath).toString() },
    },
  });
  const placement = requireTreeNodeByLabel(adapterResult.nodes, 'Размещение: Field');
  const title = requireTreeNodeByLabel(adapterResult.nodes, 'Title');
  const placementResult = await adapterResult.candidateFactories.get(placement.id)!();
  const titleResult = await adapterResult.candidateFactories.get(title.id)!();
  if (!placementResult.ok || !titleResult.ok) {
    throw new Error('Form placement adapter did not produce both selected candidates.');
  }

  const targetDependencyWitness = includeTargetDependencyWitness ? [{
    sourceId: 'left-source',
    relativePath: 'Catalogs/Products.xml',
    expectedHash: createHash('sha256').update(Buffer.from(ownerDescriptor, 'utf8')).digest('hex'),
    kind: 'file' as const,
  }] : undefined;
  const candidates: MergeCandidate[] = [placementResult.candidate, titleResult.candidate].map((candidate) => ({
    ...candidate,
    sourceWitnesses: targetDependencyWitness,
  }));
  const previewResult = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates,
    currentTargetHashes: {
      [placementResult.candidate.targetUri!]: hashXmlText(leftXml),
    },
  });
  if (!previewResult.ok) {
    throw new Error('Form placement preview failed: ' + JSON.stringify(previewResult.diagnostics));
  }
  assert.deepStrictEqual(previewResult.preview.operations.map((operation) => operation.kind), [
    'xmlNodeMove',
    'xmlNodeReplace',
  ]);

  return {
    backupDir,
    leftXml,
    operations: previewResult.preview.operations,
    ownerDescriptorPath,
    previewId,
    rightXml,
    session,
    sourcePath,
    targetUri: placementResult.candidate.targetUri!,
    xmlPath,
  };
}

function createApprovedFormMovePreflight(context: FormMoveContext): {
  preflight: PreflightResult;
  backupPaths: string[];
} {
  context.session.approvePreview(context.previewId);
  const backupPaths = context.operations.map((_, index) =>
    path.join(context.backupDir, 'Form-' + index + '.xml.bak'));
  const backupItems = context.operations.map((operation, index) => ({
    operationId: operation.operationId,
    targetUri: operation.targetUri!,
    backupUri: pathToFileURL(backupPaths[index]!).toString(),
    expectedOldHash: hashText(context.leftXml),
  }));
  const result = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: { [context.targetUri]: hashText(context.leftXml) },
    backupPlan: {
      previewId: context.previewId,
      strategy: 'copyBeforeWrite',
      items: backupItems,
    },
    rollbackPlan: {
      previewId: context.previewId,
      strategy: 'restoreBackups',
      items: backupItems.map((item) => ({ ...item, restoreHash: item.expectedOldHash })),
    },
  });
  if (!result.ok) {
    throw new Error('Form placement preflight failed: ' + JSON.stringify(result.diagnostics));
  }
  return { preflight: result, backupPaths };
}

async function createContext(tempDirs: string[]): Promise<ExecutionContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-xml-file-bsl-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
  tempDirs.push(backupDir);
  const xmlPath = path.join(rootDir, 'Catalogs', 'Products.xml');
  const fileTargetPath = path.join(rootDir, 'Templates', 'Print.mxl');
  const fileSourcePath = path.join(snapshotDir, 'Templates', 'Print.mxl');
  const bslPath = path.join(rootDir, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
  const xmlBackupPath = path.join(backupDir, 'Products.xml.bak');
  const fileBackupPath = path.join(backupDir, 'Print.mxl.bak');
  const bslBackupPath = path.join(backupDir, 'ObjectModule.bsl.bak');
  const oldXml = '<Object><Name>Old</Name></Object>';
  const nextXml = '<Object><Name>New</Name></Object>';
  const fileTargetOld = 'old template';
  const fileSource = 'new template';
  const oldBsl = baseRoutine();
  const nextBsl = incomingRoutine();

  await fs.mkdir(path.dirname(xmlPath), { recursive: true });
  await fs.writeFile(xmlPath, oldXml, 'utf8');
  await fs.mkdir(path.dirname(fileTargetPath), { recursive: true });
  await fs.writeFile(fileTargetPath, fileTargetOld, 'utf8');
  await fs.mkdir(path.dirname(fileSourcePath), { recursive: true });
  await fs.writeFile(fileSourcePath, fileSource, 'utf8');
  await fs.mkdir(path.dirname(bslPath), { recursive: true });
  await fs.writeFile(bslPath, oldBsl, 'utf8');

  const session = await makeSession(rootDir, snapshotDir);
  const plan = createPlan(oldBsl, nextBsl, bslPath, rootDir);
  const previewId = 'preview-bulk-execute';
  const candidates: MergeCandidate[] = [
    xmlCandidate(xmlPath, oldXml, nextXml),
    fileCopyCandidate(fileSourcePath, fileTargetPath, fileTargetOld, fileSource),
    bslCandidate(plan, bslPath, oldBsl, nextBsl, rootDir),
  ];
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates,
    currentTargetHashes: Object.fromEntries(
      candidates.map((candidate) => [candidate.targetUri!, candidate.expectedOldHash!])
    ),
  });
  assert.strictEqual(preview.ok, true);

  return {
    bslBackupPath,
    bslPath,
    fileBackupPath,
    fileSource,
    fileSourcePath,
    fileTargetOld,
    fileTargetPath,
    nextBsl,
    nextXml,
    oldBsl,
    oldXml,
    operationIds: preview.preview.operations.map((operation) => operation.operationId),
    previewId,
    session,
    targetUris: preview.preview.operations.map((operation) => operation.targetUri!),
    xmlBackupPath,
    xmlPath,
  };
}

function createApprovedPreflight(context: ExecutionContext): PreflightResult {
  context.session.approvePreview(context.previewId);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [pathToFileURL(context.xmlPath).toString()]: hashText(context.oldXml),
      [pathToFileURL(context.fileTargetPath).toString()]: hashText(context.fileTargetOld),
      [pathToFileURL(context.bslPath).toString()]: hashText(context.oldBsl),
    },
    backupPlan: backupPlan(context),
    rollbackPlan: rollbackPlan(context),
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

async function createRoutineChangeContext(
  tempDirs: string[],
  kind: 'bslRoutineInsert' | 'bslRoutineDelete',
  withAtClient = false,
  options: { leaveEmptyAfterDelete?: boolean; routineKind?: 'procedure' | 'function'; routineText?: string } = {},
): Promise<RoutineChangeContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-bsl-routine-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
  tempDirs.push(backupDir);
  const bslPath = path.join(rootDir, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
  const bslBackupPath = path.join(backupDir, `${kind}.bsl.bak`);
  const targetUri = pathToFileURL(bslPath).toString();
  const incomingRoutine = kind === 'bslRoutineInsert' ? insertedRoutine() : options.routineText ?? deletedRoutine();
  const oldBsl = kind === 'bslRoutineInsert'
    ? existingRoutine()
    : options.leaveEmptyAfterDelete
      ? [...(withAtClient ? ['&AtClient'] : []), incomingRoutine].join('\n')
      : [existingRoutine(), ...(withAtClient ? ['&AtClient'] : []), incomingRoutine].join('\n');
  const nextBsl = kind === 'bslRoutineInsert'
    ? [existingRoutine(), ...(withAtClient ? ['&AtClient'] : []), incomingRoutine].join('\n')
    : options.leaveEmptyAfterDelete ? '' : existingRoutine();

  await fs.mkdir(path.dirname(bslPath), { recursive: true });
  await fs.writeFile(bslPath, oldBsl, 'utf8');

  const session = await makeSession(rootDir, snapshotDir);
  const previewId = `preview-${kind}`;
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates: [routineChangeCandidate(kind, targetUri, oldBsl, nextBsl, withAtClient, options)],
    currentTargetHashes: {
      [targetUri]: hashText(oldBsl),
    },
  });
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

  return {
    bslBackupPath,
    bslPath,
    nextBsl,
    oldBsl,
    operationId: preview.preview.operations[0].operationId,
    previewId,
    session,
    targetUri,
  };
}

function createApprovedRoutinePreflight(context: RoutineChangeContext): PreflightResult {
  context.session.approvePreview(context.previewId);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [context.targetUri]: hashText(context.oldBsl),
    },
    backupPlan: {
      previewId: context.previewId,
      strategy: 'copyBeforeWrite',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.bslBackupPath).toString(),
          expectedOldHash: hashText(context.oldBsl),
        },
      ],
    },
    rollbackPlan: {
      previewId: context.previewId,
      strategy: 'restoreBackups',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.bslBackupPath).toString(),
          restoreHash: hashText(context.oldBsl),
        },
      ],
    },
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

async function createBulkRollbackContext(tempDirs: string[]): Promise<BulkRollbackContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-bulk-rollback-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
  tempDirs.push(backupDir);
  const firstSourcePath = path.join(snapshotDir, 'Templates', 'First.mxl');
  const firstTargetPath = path.join(rootDir, 'Templates', 'First.mxl');
  const secondSourcePath = path.join(snapshotDir, 'Templates', 'Second.mxl');
  const secondTargetPath = path.join(rootDir, 'Templates', 'Second.mxl');
  const firstBackupPath = path.join(backupDir, 'First.mxl.bak');
  const secondBackupPath = path.join(backupDir, 'Second.mxl.bak');
  const firstTargetOld = 'first old template';
  const firstSource = 'first incoming template';
  const secondTargetOld = 'second old template';
  const secondSource = 'second incoming template';

  await fs.mkdir(path.dirname(firstSourcePath), { recursive: true });
  await fs.mkdir(path.dirname(firstTargetPath), { recursive: true });
  await fs.writeFile(firstSourcePath, firstSource, 'utf8');
  await fs.writeFile(firstTargetPath, firstTargetOld, 'utf8');
  await fs.writeFile(secondSourcePath, secondSource, 'utf8');
  await fs.writeFile(secondTargetPath, secondTargetOld, 'utf8');

  const session = await makeSession(rootDir, snapshotDir);
  const previewId = 'preview-bulk-rollback';
  const candidates: MergeCandidate[] = [
    fileCopyCandidate(firstSourcePath, firstTargetPath, firstTargetOld, firstSource),
    fileCopyCandidate(secondSourcePath, secondTargetPath, secondTargetOld, secondSource),
  ];
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates,
    currentTargetHashes: Object.fromEntries(
      candidates.map((candidate) => [candidate.targetUri!, candidate.expectedOldHash!])
    ),
  });
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

  return {
    firstBackupPath,
    firstOperationId: preview.preview.operations[0].operationId,
    firstSource,
    firstSourcePath,
    firstTargetOld,
    firstTargetPath,
    previewId,
    secondBackupPath,
    secondOperationId: preview.preview.operations[1].operationId,
    secondSource,
    secondSourcePath,
    secondTargetOld,
    secondTargetPath,
    session,
    targetUris: preview.preview.operations.map((operation) => operation.targetUri!),
  };
}

function createApprovedBulkRollbackPreflight(context: BulkRollbackContext): PreflightResult {
  context.session.approvePreview(context.previewId);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [context.targetUris[0]!]: hashText(context.firstTargetOld),
      [context.targetUris[1]!]: hashText(context.secondTargetOld),
    },
    backupPlan: {
      previewId: context.previewId,
      strategy: 'copyBeforeWrite',
      items: [
        {
          operationId: context.firstOperationId,
          targetUri: context.targetUris[0]!,
          backupUri: pathToFileURL(context.firstBackupPath).toString(),
          expectedOldHash: hashText(context.firstTargetOld),
        },
        {
          operationId: context.secondOperationId,
          targetUri: context.targetUris[1]!,
          backupUri: pathToFileURL(context.secondBackupPath).toString(),
          expectedOldHash: hashText(context.secondTargetOld),
        },
      ],
    },
    rollbackPlan: {
      previewId: context.previewId,
      strategy: 'restoreBackups',
      items: [
        {
          operationId: context.firstOperationId,
          targetUri: context.targetUris[0]!,
          backupUri: pathToFileURL(context.firstBackupPath).toString(),
          restoreHash: hashText(context.firstTargetOld),
        },
        {
          operationId: context.secondOperationId,
          targetUri: context.targetUris[1]!,
          backupUri: pathToFileURL(context.secondBackupPath).toString(),
          restoreHash: hashText(context.secondTargetOld),
        },
      ],
    },
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

async function createFileCopyOnlyContext(
  tempDirs: string[],
  options: { sourceOutsideRightRoot?: boolean } = {}
): Promise<FileCopyOnlyContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-file-copy-only-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const outsideDir = path.join(rootDir, '..', `${path.basename(rootDir)}-outside`);
  tempDirs.push(outsideDir);
  const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
  tempDirs.push(backupDir);
  const fileSourcePath = path.join(
    options.sourceOutsideRightRoot ? outsideDir : snapshotDir,
    'Templates',
    'Print.mxl'
  );
  const fileTargetPath = path.join(rootDir, 'Templates', 'Print.mxl');
  const fileBackupPath = path.join(backupDir, 'Print.mxl.bak');
  const fileTargetOld = 'old template';
  const fileSource = 'incoming template';

  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.mkdir(path.dirname(fileSourcePath), { recursive: true });
  await fs.mkdir(path.dirname(fileTargetPath), { recursive: true });
  await fs.writeFile(fileSourcePath, fileSource, 'utf8');
  await fs.writeFile(fileTargetPath, fileTargetOld, 'utf8');

  const session = await makeSession(rootDir, snapshotDir);
  const previewId = options.sourceOutsideRightRoot
    ? 'preview-file-copy-outside-source'
    : 'preview-file-copy-only';
  const candidate = fileCopyCandidate(fileSourcePath, fileTargetPath, fileTargetOld, fileSource);
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates: [candidate],
    currentTargetHashes: {
      [candidate.targetUri!]: candidate.expectedOldHash!,
    },
  });
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

  return {
    fileBackupPath,
    fileSource,
    fileSourcePath,
    fileTargetOld,
    fileTargetPath,
    operationId: preview.preview.operations[0].operationId,
    previewId,
    session,
    targetUri: preview.preview.operations[0].targetUri!,
  };
}

function createApprovedFileCopyOnlyPreflight(context: FileCopyOnlyContext): PreflightResult {
  context.session.approvePreview(context.previewId);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [context.targetUri]: hashText(context.fileTargetOld),
    },
    backupPlan: {
      previewId: context.previewId,
      strategy: 'copyBeforeWrite',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.fileBackupPath).toString(),
          expectedOldHash: hashText(context.fileTargetOld),
        },
      ],
    },
    rollbackPlan: {
      previewId: context.previewId,
      strategy: 'restoreBackups',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.fileBackupPath).toString(),
          restoreHash: hashText(context.fileTargetOld),
        },
      ],
    },
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

async function createFolderCopyOnlyContext(
  tempDirs: string[],
  options: { sourceOutsideRightRoot?: boolean } = {}
): Promise<FolderCopyOnlyContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-folder-copy-only-'));
  tempDirs.push(rootDir);
  const snapshotDir = path.join(rootDir, 'snapshot');
  const outsideDir = path.join(rootDir, '..', `${path.basename(rootDir)}-outside`);
  tempDirs.push(outsideDir);
  const backupDir = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-backups`);
  tempDirs.push(backupDir);
  const folderSourcePath = path.join(
    options.sourceOutsideRightRoot ? outsideDir : snapshotDir,
    'Catalogs',
    'Incoming'
  );
  const folderTargetPath = path.join(rootDir, 'Catalogs', 'Incoming');
  const folderBackupPath = path.join(backupDir, 'Incoming.bak');

  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.mkdir(folderSourcePath, { recursive: true });
  await fs.mkdir(folderTargetPath, { recursive: true });
  await fs.writeFile(path.join(folderSourcePath, 'incoming.txt'), 'incoming folder file', 'utf8');
  await fs.writeFile(path.join(folderTargetPath, 'old.txt'), 'old folder file', 'utf8');

  const sourceHash = await hashTestDirectory(folderSourcePath);
  const targetHash = await hashTestDirectory(folderTargetPath);
  const session = await makeSession(rootDir, snapshotDir);
  const previewId = options.sourceOutsideRightRoot
    ? 'preview-folder-copy-outside-source'
    : 'preview-folder-copy-only';
  const targetUri = pathToFileURL(folderTargetPath).toString();
  const candidate: MergeCandidate = {
    kind: 'folderCopy',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'folder:incoming',
    targetUri,
    expectedOldHash: targetHash,
    newHash: sourceHash,
    fileOperation: {
      kind: 'folderCopy',
      sourcePath: pathToFileURL(folderSourcePath).toString(),
      targetPath: targetUri,
      expectedOldHash: targetHash,
      sourceHash,
      destructive: true,
    },
  };
  const preview = createMergePreview({
    session,
    previewId,
    targetSourceId: 'left-source',
    snapshotIds: { left: 'snapshot-left-1', right: 'snapshot-right-1' },
    createdAt: '2026-05-30T10:10:00.000Z',
    candidates: [candidate],
    currentTargetHashes: {
      [targetUri]: targetHash,
    },
  });
  assert.strictEqual(preview.ok, true, JSON.stringify(preview.diagnostics));

  return {
    folderBackupPath,
    folderSourcePath,
    folderTargetPath,
    operationId: preview.preview.operations[0].operationId,
    previewId,
    session,
    targetUri,
  };
}

async function createApprovedFolderCopyOnlyPreflight(
  context: FolderCopyOnlyContext
): Promise<PreflightResult> {
  context.session.approvePreview(context.previewId);
  const targetHash = await hashTestDirectory(context.folderTargetPath);
  const preflight = validateMergePreflight({
    session: context.session,
    previewId: context.previewId,
    approvedPreviewId: context.previewId,
    currentTargetHashes: {
      [context.targetUri]: targetHash,
    },
    backupPlan: {
      previewId: context.previewId,
      strategy: 'copyBeforeWrite',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.folderBackupPath).toString(),
          expectedOldHash: targetHash,
        },
      ],
    },
    rollbackPlan: {
      previewId: context.previewId,
      strategy: 'restoreBackups',
      items: [
        {
          operationId: context.operationId,
          targetUri: context.targetUri,
          backupUri: pathToFileURL(context.folderBackupPath).toString(),
          restoreHash: targetHash,
        },
      ],
    },
  });
  assert.strictEqual(preflight.ok, true, JSON.stringify(preflight.diagnostics));
  return preflight;
}

function nodeTestFileSystem() {
  return {
    mkdir(directoryPath: string, options: { recursive: true }) {
      return fs.mkdir(directoryPath, options);
    },
    realpath(filePath: string) {
      return fs.realpath(filePath);
    },
    readFile(filePath: string, encoding: 'utf8') {
      return fs.readFile(filePath, encoding);
    },
    open(filePath: string, flags: 'wx') {
      return fs.open(filePath, flags);
    },
    rename(oldPath: string, newPath: string) {
      return fs.rename(oldPath, newPath);
    },
    copyFile(sourcePath: string, targetPath: string) {
      return fs.copyFile(sourcePath, targetPath);
    },
    rm(filePath: string, options: { force: true }) {
      return fs.rm(filePath, options);
    },
  };
}

function routineChangeCandidate(
  kind: 'bslRoutineInsert' | 'bslRoutineDelete',
  targetUri: string,
  oldBsl: string,
  nextBsl: string,
  withAtClient = false,
  options: { routineKind?: 'procedure' | 'function'; routineText?: string } = {},
): MergeCandidate {
  const routineBody = kind === 'bslRoutineInsert' ? insertedRoutine() : options.routineText ?? deletedRoutine();
  const routineText = withAtClient ? `&AtClient\n${routineBody}` : routineBody;
  const targetRoutine = parseBslRoutines(oldBsl).routines.find((routine) => routine.name === 'Removed');
  const incomingModule = kind === 'bslRoutineInsert'
    ? [existingRoutine(), ...(withAtClient ? ['&AtClient'] : []), routineBody].join('\n')
    : routineText;
  const sourceRoutine = parseBslRoutines(incomingModule).routines.find((routine) =>
    routine.name === (kind === 'bslRoutineInsert' ? 'Added' : 'Removed')
  );
  const targetTextRange = withAtClient && kind === 'bslRoutineDelete'
    ? {
      startLine: targetRoutine!.range.startLine - 1,
      startColumn: 1,
      endLine: targetRoutine!.range.endLine,
      endColumn: targetRoutine!.range.endColumn,
    }
    : undefined;
  const sourceRange = kind === 'bslRoutineInsert' ? sourceRoutine?.range : undefined;
  const sourceTextRange = withAtClient && kind === 'bslRoutineInsert'
    ? {
      startLine: sourceRoutine!.range.startLine - 1,
      startColumn: 1,
      endLine: sourceRoutine!.range.endLine,
      endColumn: sourceRoutine!.range.endColumn,
    }
    : undefined;
  return {
    kind,
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: `bsl:${kind}:added`,
    targetUri,
    expectedOldHash: hashText(oldBsl),
    newHash: hashText(nextBsl),
    bslRoutine: {
      kind: kind === 'bslRoutineInsert' ? 'insertRoutine' : 'deleteRoutine',
      targetPath: targetUri,
      expectedOldHash: hashText(oldBsl),
      newHash: hashText(nextBsl),
      routine: {
        name: kind === 'bslRoutineInsert' ? 'Added' : 'Removed',
        normalizedName: kind === 'bslRoutineInsert' ? 'added' : 'removed',
        kind: kind === 'bslRoutineInsert' ? 'function' : options.routineKind ?? 'procedure',
        exported: false,
      },
      sourceText: routineText,
      sourceRange,
      targetRange:
        kind === 'bslRoutineDelete'
          ? targetRoutine?.range
          : undefined,
      ...(sourceTextRange ? { sourceTextRange } : {}),
      ...(targetTextRange ? { targetTextRange } : {}),
    },
  } as unknown as MergeCandidate;
}

function xmlCandidate(xmlPath: string, oldXml: string, nextXml: string): MergeCandidate {
  const targetUri = pathToFileURL(xmlPath).toString();
  return {
    kind: 'xmlNodeReplace',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'xml:name',
    targetUri,
    expectedOldHash: hashText(oldXml),
    newHash: hashText(nextXml),
    xmlPatch: {
      kind: 'replaceNode',
      target: {
        filePath: targetUri,
        pointer: '/Object/Name',
        displayPath: 'Object/Name',
      },
      expectedOldHash: hashText(oldXml),
      newHash: hashText(nextXml),
      replacementXml: '<Name>New</Name>',
    },
  };
}

function fileCopyCandidate(
  sourcePath: string,
  targetPath: string,
  oldText: string,
  sourceText: string
): MergeCandidate {
  const targetUri = pathToFileURL(targetPath).toString();
  return {
    kind: 'fileCopy',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'file:template',
    targetUri,
    expectedOldHash: hashText(oldText),
    newHash: hashText(sourceText),
    fileOperation: {
      kind: 'fileCopy',
      sourcePath: pathToFileURL(sourcePath).toString(),
      targetPath: targetUri,
      expectedOldHash: hashText(oldText),
      sourceHash: hashText(sourceText),
      destructive: false,
    },
  };
}

function bslCandidate(
  plan: BslRoutineLogicalMergePlan,
  targetPath: string,
  oldBsl: string,
  nextBsl: string,
  rootDir: string
): MergeCandidate {
  return {
    kind: 'bslLogicalRoutineMerge',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId: 'bsl:run',
    targetUri: pathToFileURL(targetPath).toString(),
    expectedOldHash: hashText(oldBsl),
    newHash: hashText(nextBsl),
    logicalRoutine: {
      moduleId: 'Catalog.Products.Object',
      current: snapshot(oldBsl, targetPath, rootDir),
      plan,
    },
  };
}

function backupPlan(context: ExecutionContext): BackupPlan {
  return {
    previewId: context.previewId,
    strategy: 'copyBeforeWrite',
    items: [
      backupItem(context, 0, context.xmlBackupPath, hashText(context.oldXml)),
      backupItem(context, 1, context.fileBackupPath, hashText(context.fileTargetOld)),
      backupItem(context, 2, context.bslBackupPath, hashText(context.oldBsl)),
    ],
  };
}

function rollbackPlan(context: ExecutionContext): RollbackPlan {
  const backups = backupPlan(context);
  return {
    previewId: context.previewId,
    strategy: 'restoreBackups',
    items: backups.items.map((item) => ({
      operationId: item.operationId,
      targetUri: item.targetUri,
      backupUri: item.backupUri,
      restoreHash: item.expectedOldHash,
    })),
  };
}

function backupItem(
  context: ExecutionContext,
  index: number,
  backupPath: string,
  expectedOldHash: string
): BackupPlan['items'][number] {
  return {
    operationId: context.operationIds[index]!,
    targetUri: context.targetUris[index]!,
    backupUri: pathToFileURL(backupPath).toString(),
    expectedOldHash,
  };
}

function createPlan(
  oldBsl: string,
  nextBsl: string,
  targetPath: string,
  rootDir: string
): BslRoutineLogicalMergePlan {
  const base = snapshot(oldBsl, targetPath, rootDir);
  return createBslRoutineLogicalMergePlan({
    moduleId: 'Catalog.Products.Object',
    base,
    current: base,
    incoming: snapshot(nextBsl, targetPath, rootDir),
  });
}

function snapshot(
  source: string,
  filePath: string,
  configRoot: string
): BslRoutineLogicalSnapshot {
  const module = indexBslModuleSource({
    identity: makeIdentity(filePath, configRoot),
    source,
  });
  return {
    source,
    routine: module.routines[0],
  };
}

function makeIdentity(filePath: string, configRoot: string): BslModuleIdentity {
  return {
    sourceId: 'left-source',
    side: 'left',
    filePath,
    configRoot,
    metadataType: 'Catalog',
    objectName: 'Products',
    moduleKind: 'Object',
    moduleId: 'Catalog.Products.Object',
    displayName: 'Catalog.Products.Object',
  };
}

async function makeSession(rootDir: string, snapshotDir: string): Promise<CompareSession> {
  await fs.mkdir(snapshotDir, { recursive: true });
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Current workspace',
        rootUri: pathToFileURL(rootDir).toString(),
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'snapshot',
        displayName: 'Incoming snapshot',
        rootUri: pathToFileURL(snapshotDir).toString(),
        writable: false,
      },
    ],
  });
  session.registerSnapshot(snapshotContract('snapshot-left-1', 'left-source', rootDir, false));
  session.registerSnapshot(snapshotContract('snapshot-right-1', 'right-source', snapshotDir, true));
  return session;
}

function makeXmlAdapterInput(
  session: CompareSession,
  rootDir: string,
  snapshotDir: string,
  xmlPath: string,
  left: string,
  right: string
): AdapterCompareInput {
  return {
    strategy: 'full',
    leftInventory: { rootPath: rootDir, objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: snapshotDir, objects: [], artifactsByObjectId: new Map() },
    match: {
      left: {
        objectId: 'left-products',
        qualifiedName: 'Catalog.Products',
        metadataType: 'Catalog',
        uuid: 'catalog-products',
        descriptorPath: pathToFileURL(xmlPath).toString(),
        containerPath: path.dirname(xmlPath),
      },
      right: {
        objectId: 'right-products',
        qualifiedName: 'Catalog.Products',
        metadataType: 'Catalog',
        uuid: 'catalog-products',
        descriptorPath: pathToFileURL(path.join(snapshotDir, 'Catalogs', 'Products.xml')).toString(),
        containerPath: path.join(snapshotDir, 'Catalogs', 'Products'),
      },
    },
    session,
    artifactPaths: {
      left: xmlPath,
      right: path.join(snapshotDir, 'Catalogs', 'Products.xml'),
    },
    snapshots: { left, right },
  };
}

function requireTreeNodeByLabel(
  nodes: readonly CompareTreeNode[],
  label: string
): CompareTreeNode {
  const found: CompareTreeNode[] = [];
  const visitNode = (node: CompareTreeNode) => {
    if (node.label === label) {
      found.push(node);
    }
    node.children.forEach(visitNode);
  };
  nodes.forEach(visitNode);
  assert.strictEqual(found.length, 1, `Expected exactly one node with label ${label}.`);
  return found[0]!;
}

function snapshotContract(
  snapshotId: string,
  sourceId: string,
  root: string,
  readOnly: boolean
) {
  return {
    snapshotId,
    sourceId,
    snapshotRoot: pathToFileURL(root).toString(),
    origin: pathToFileURL(root).toString(),
    createdAt: '2026-05-30T10:00:00.000Z',
    retentionUntil: '2026-05-30T12:00:00.000Z',
    sourceRevision: `test:${sourceId}`,
    readOnly,
    cleanupPolicy: 'manual' as const,
    contentHash: `sha256:${sourceId}`,
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

function existingRoutine(): string {
  return ['Procedure Existing()', '  Value = 1;', 'EndProcedure'].join('\n');
}

function insertedRoutine(): string {
  return ['Function Added()', '  Return 42;', 'EndFunction'].join('\n');
}

function deletedRoutine(): string {
  return ['Procedure Removed()', '  Value = 0;', 'EndProcedure'].join('\n');
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashTestDirectory(directoryPath: string): Promise<string> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      parts.push(`dir:${entry.name}:${await hashTestDirectory(entryPath)}`);
    } else if (entry.isFile()) {
      parts.push(`file:${entry.name}:${hashTestBuffer(await fs.readFile(entryPath))}`);
    }
  }

  return hashText(parts.join('\n'));
}

function hashTestBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
