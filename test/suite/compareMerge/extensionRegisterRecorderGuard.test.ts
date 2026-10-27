import * as assert from 'assert';

import {
  preflightOwnRegisterRecorders,
  scanDocumentRegisterRecords,
  type RecorderDocumentVersion,
  type RecorderRegisterRequirement,
} from '../../../src/compareMerge/extensions/extensionRegisterRecorderGuard';
import type { MergeFileWitness } from '../../../src/compareMerge/merge/mergePreview';

suite('Extension register recorder preflight (#336)', () => {
  test('scans only direct Document RegisterRecords MDObjectRef entries and marks adopted absence as inherited', () => {
    const documentXml = '<MetaDataObject><Document><Properties><Name>Catalog.NameNoise</Name><Comment>AccountingRegister.CommentNoise</Comment><RegisterRecords xmlns:xr="urn:xr" xmlns:xsi="urn:xsi"><xr:Item xsi:type="xr:MDObjectRef">AccountingRegister.Main</xr:Item><Wrapper><xr:Item xsi:type="xr:MDObjectRef">AccountingRegister.NestedNoise</xr:Item></Wrapper><xr:Item xsi:type="xs:string">AccountingRegister.OtherNoise</xr:Item></RegisterRecords></Properties></Document></MetaDataObject>';
    const explicit = scanDocumentRegisterRecords({ artifactPath: 'Documents/Recorder.xml', xml: documentXml, adoptedDocument: true });
    const missing = scanDocumentRegisterRecords({ artifactPath: 'Documents/Inherited.xml', xml: '<MetaDataObject><Document><Properties><Name>Recorder</Name></Properties></Document></MetaDataObject>', adoptedDocument: true });
    const ownMissing = scanDocumentRegisterRecords({ artifactPath: 'Documents/Own.xml', xml: '<MetaDataObject><Document><Properties><Name>Recorder</Name></Properties></Document></MetaDataObject>', adoptedDocument: false });

    assert.deepStrictEqual(explicit.errors, []);
    assert.deepStrictEqual(explicit.references, ['AccountingRegister.Main']);
    assert.strictEqual(explicit.inheritsRegisterRecords, false);
    assert.deepStrictEqual(missing.references, []);
    assert.strictEqual(missing.inheritsRegisterRecords, true);
    assert.deepStrictEqual(ownMissing.references, []);
    assert.strictEqual(ownMissing.inheritsRegisterRecords, false);
  });

  test('requires registrar coverage only for own full-copy registers and conditional RecorderSubordinate information registers', () => {
    const registers: RecorderRegisterRequirement[] = [
      requiredRegister('AccumulationRegister.A'),
      requiredRegister('AccountingRegister.A'),
      requiredRegister('CalculationRegister.A'),
      requiredRegister('InformationRegister.Subordinate', 'InformationRegister', informationRegisterXml('RecorderSubordinate')),
      requiredRegister('InformationRegister.Independent', 'InformationRegister', informationRegisterXml('Independent')),
      requiredRegister('InformationRegister.Default', 'InformationRegister'),
      { ...requiredRegister('AccountingRegister.B'), isOwnFullCopy: false },
    ];

    const result = preflightOwnRegisterRecorders({
      registers,
      targetDocuments: [],
      provenTargetBaseDocuments: [],
      selectedDocumentOutputs: [],
    });

    assert.deepStrictEqual(result.blockers.map(({ registerQualifiedName }) => registerQualifiedName), [
      'AccumulationRegister.A',
      'AccountingRegister.A',
      'CalculationRegister.A',
      'InformationRegister.Subordinate',
    ]);
  });

  test('accepts selected, target, or proven-base recorder Documents and returns their witnesses', () => {
    const register = requiredRegister('AccountingRegister.Main');
    const selectedWitness = witness('selected-doc', 'Documents/Selected.xml', 'selected-hash');
    const targetWitness = witness('target-root', 'Documents/Target.xml', 'target-hash');
    const baseWitness = witness('base-root', 'Documents/Base.xml', 'base-hash');
    const selected = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [],
      provenTargetBaseDocuments: [],
      selectedDocumentOutputs: [document('Document.Selected', ['AccountingRegister.Main'], false, [selectedWitness])],
    });
    const target = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [document('Document.Target', ['AccountingRegister.Main'], false, [targetWitness])],
      provenTargetBaseDocuments: [],
      selectedDocumentOutputs: [],
    });
    const base = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [],
      provenTargetBaseDocuments: [document('Document.Base', ['AccountingRegister.Main'], false, [baseWitness])],
      selectedDocumentOutputs: [],
    });

    assert.deepStrictEqual(selected.blockers, []);
    assert.deepStrictEqual(target.blockers, []);
    assert.deepStrictEqual(base.blockers, []);
    assert.deepStrictEqual(selected.witnessesByRegister.get(register.qualifiedName), [selectedWitness]);
    assert.deepStrictEqual(target.witnessesByRegister.get(register.qualifiedName), [targetWitness]);
    assert.deepStrictEqual(base.witnessesByRegister.get(register.qualifiedName), [baseWitness]);
  });

  test('selected own Document without RegisterRecords replaces target and base mappings', () => {
    const register = requiredRegister('CalculationRegister.Main');
    const target = document('Document.Recorder', ['CalculationRegister.Main'], false, [witness('target', 'Documents/Recorder.xml', 'old')]);
    const base = document('Document.Recorder', ['CalculationRegister.Main'], false, [witness('base', 'Documents/Recorder.xml', 'base')]);
    const selected = document('Document.Recorder', [], false, [witness('selected', 'Documents/Recorder.xml', 'new')]);

    const result = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [target],
      provenTargetBaseDocuments: [base],
      selectedDocumentOutputs: [selected],
    });

    assert.strictEqual(result.blockers.length, 1);
    assert.strictEqual(result.blockers[0]?.registerQualifiedName, register.qualifiedName);
    assert.ok(result.blockers[0]?.message.includes('Выберите или перенесите'));
    assert.strictEqual(result.witnessesByRegister.has(register.qualifiedName), false);
  });

  test('adopted Documents inherit absent RegisterRecords and union declared links with the base mapping', () => {
    const register = requiredRegister('AccumulationRegister.Main');
    const baseWitness = witness('base', 'Documents/Recorder.xml', 'base');
    const selectedWitness = witness('selected', 'Documents/Recorder.xml', 'selected');
    const baseDocument = document('Document.Recorder', ['AccumulationRegister.Main'], false, [baseWitness]);
    const adoptedWithoutList = document('Document.Recorder', [], true, [selectedWitness]);
    const adoptedWithList = document('Document.Recorder', ['AccumulationRegister.Main'], true, [selectedWitness]);
    const adoptedWithOtherList = document('Document.Recorder', ['CalculationRegister.Other'], true, [selectedWitness]);

    const inherited = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [],
      provenTargetBaseDocuments: [baseDocument],
      selectedDocumentOutputs: [adoptedWithoutList],
    });
    const explicitAdopted = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [],
      provenTargetBaseDocuments: [baseDocument],
      selectedDocumentOutputs: [adoptedWithList],
    });
    const explicitOtherAdopted = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [],
      provenTargetBaseDocuments: [baseDocument],
      selectedDocumentOutputs: [adoptedWithOtherList],
    });

    assert.deepStrictEqual(inherited.blockers, []);
    assert.deepStrictEqual(inherited.witnessesByRegister.get(register.qualifiedName), [baseWitness, selectedWitness]);
    assert.deepStrictEqual(explicitAdopted.blockers, []);
    assert.deepStrictEqual(explicitAdopted.witnessesByRegister.get(register.qualifiedName), [baseWitness, selectedWitness]);
    assert.deepStrictEqual(explicitOtherAdopted.blockers, []);
    assert.deepStrictEqual(explicitOtherAdopted.witnessesByRegister.get(register.qualifiedName), [baseWitness, selectedWitness]);
  });

  test('does not inherit base recorder mappings from an adopted Document with malformed RegisterRecords', () => {
    const register = requiredRegister('AccountingRegister.Main');
    const baseDocument = document('Document.Recorder', ['AccountingRegister.Main'], false, [witness('base', 'Documents/Recorder.xml', 'base')]);
    const malformedTarget: RecorderDocumentVersion = {
      ...document('Document.Recorder', ['CalculationRegister.Other'], true, [witness('target', 'Documents/Recorder.xml', 'target')]),
      registerRecords: {
        references: ['CalculationRegister.Other'],
        inheritsRegisterRecords: false,
        errors: [{ artifactPath: 'Documents/Recorder.xml', message: 'malformed RegisterRecords' }],
      },
    };

    const result = preflightOwnRegisterRecorders({
      registers: [register],
      targetDocuments: [malformedTarget],
      provenTargetBaseDocuments: [baseDocument],
      selectedDocumentOutputs: [],
    });

    assert.deepStrictEqual(result.blockers.map(({ registerQualifiedName }) => registerQualifiedName), [register.qualifiedName]);
  });

  test('does not use unselected incoming Documents as registrar candidates', () => {
    const result = preflightOwnRegisterRecorders({
      registers: [requiredRegister('AccountingRegister.Main')],
      targetDocuments: [],
      provenTargetBaseDocuments: [],
      selectedDocumentOutputs: [],
    });

    assert.strictEqual(result.blockers.length, 1);
  });
});

function requiredRegister(
  qualifiedName: string,
  metadataType = qualifiedName.slice(0, qualifiedName.indexOf('.')),
  descriptorXml?: string,
): RecorderRegisterRequirement {
  return { qualifiedName, metadataType, isOwnFullCopy: true, descriptorXml };
}

function document(
  qualifiedName: string,
  references: readonly string[],
  adoptedDocument: boolean,
  witnesses: readonly MergeFileWitness[],
): RecorderDocumentVersion {
  return {
    qualifiedName,
    adoptedDocument,
    registerRecords: { references, inheritsRegisterRecords: adoptedDocument && references.length === 0, errors: [] },
    witnesses,
  };
}

function witness(sourceId: string, relativePath: string, expectedHash: string): MergeFileWitness {
  return { sourceId, relativePath, expectedHash, kind: 'file' };
}

function informationRegisterXml(writeMode: string): string {
  return `<MetaDataObject><InformationRegister><Properties><WriteMode>${writeMode}</WriteMode></Properties></InformationRegister></MetaDataObject>`;
}
