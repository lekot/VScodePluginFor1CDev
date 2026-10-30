import { CONFIGURATION_XML } from '../../constants/fileNames';
import type { CompareMessage } from '../domain/compareContracts';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionMaterializerInput } from './extensionTransfer';
import type { MergeFileWitness } from '../merge/mergePreview';
import {
  preflightOwnRegisterRecorders,
  scanDocumentRegisterRecords,
  type RecorderDocumentVersion,
  type RecorderRegisterRequirement,
} from './extensionRegisterRecorderGuard';
import type { ExtensionObjectOutput } from './extensionMaterializerTypes';

type DiagnosticFactory = (message: string, sourceId: string, nodeId?: string) => CompareMessage;

export function buildRecorderPreflight(
  outputs: readonly ExtensionObjectOutput[],
  input: ExtensionMaterializerInput,
  makeDiagnostic: DiagnosticFactory,
): {
  readonly result: ReturnType<typeof preflightOwnRegisterRecorders>;
  readonly diagnostics: readonly CompareMessage[];
} {
  const diagnostics: CompareMessage[] = [];
  const registers: RecorderRegisterRequirement[] = [];
  const selectedDocumentOutputs: RecorderDocumentVersion[] = [];
  const provenTargetBases = new Map<string, ExtensionMetadataIndex>();
  for (const output of outputs) {
    if (output.row.targetBase) {provenTargetBases.set(output.row.targetBase.sourceId, output.row.targetBase);}
    const incoming = output.row.incoming;
    if (!incoming) {continue;}
    const descriptorWrite = output.writes.find((write) => write.relativePath === output.effectiveDescriptorRelativePath);
    const descriptorContent = descriptorWrite?.content ?? output.effectiveDescriptorContent;
    const descriptorRelativePath = descriptorWrite?.relativePath ?? output.effectiveDescriptorRelativePath;
    if (incoming.metadataType === 'Document') {
      if (!descriptorContent || !descriptorRelativePath) {
        diagnostics.push(makeDiagnostic('Выбранный Document output не содержит descriptor write для проверки RegisterRecords.', incoming.sourceId, output.row.id));
        continue;
      }
      const adoptedDocument = isAdoptedDocumentOutput(output);
      const scanned = scanDocumentRegisterRecords({
        artifactPath: descriptorRelativePath,
        xml: descriptorContent,
        adoptedDocument,
      });
      for (const error of scanned.errors) {
        diagnostics.push(makeDiagnostic(
          `Не удалось безопасно проверить RegisterRecords в ${error.artifactPath}: ${error.message}`,
          incoming.sourceId,
          output.row.id,
        ));
      }
      selectedDocumentOutputs.push({
        qualifiedName: incoming.qualifiedName,
        adoptedDocument,
        registerRecords: scanned,
        witnesses: descriptorWrite?.sourceWitnesses ?? output.effectiveDescriptorWitnesses ?? [],
      });
    }

    if (isRecorderRegisterType(incoming.metadataType)) {
      registers.push({
        qualifiedName: incoming.qualifiedName,
        metadataType: incoming.metadataType,
        isOwnFullCopy: output.row.action === 'full-copy' && incoming.identity?.ownership !== 'adopted',
        descriptorXml: descriptorContent,
      });
    }
  }

  const targetDocuments = input.target.objects
    .filter((object) => object.metadataType === 'Document')
    .map((object) => recorderDocumentFromIndex(input.target, object));
  const provenTargetBaseDocuments = [...provenTargetBases.values()].flatMap((root) => root.objects
    .filter((object) => object.metadataType === 'Document')
    .map((object) => recorderDocumentFromIndex(root, object)));

  return {
    result: preflightOwnRegisterRecorders({ registers, targetDocuments, provenTargetBaseDocuments, selectedDocumentOutputs }),
    diagnostics,
  };
}

export function addRecorderWitnesses(
  outputs: readonly ExtensionObjectOutput[],
  witnessesByRegister: ReadonlyMap<string, readonly MergeFileWitness[]>,
): ExtensionObjectOutput[] {
  return outputs.map((output) => {
    const qualifiedName = output.row.incoming?.qualifiedName;
    const descriptorPath = output.row.incoming?.descriptorRelativePath;
    const witnesses = qualifiedName ? witnessesByRegister.get(qualifiedName) : undefined;
    if (!descriptorPath || !witnesses || witnesses.length === 0) {return output;}
    return {
      ...output,
      writes: output.writes.map((write) => write.relativePath === descriptorPath
        ? { ...write, sourceWitnesses: dedupeWitnesses([...write.sourceWitnesses, ...witnesses]) }
        : write),
    };
  });
}

function recorderDocumentFromIndex(root: ExtensionMetadataIndex, object: ExtensionIndexedObject): RecorderDocumentVersion {
  const artifactPath = object.descriptorRelativePath ?? `Documents/${object.name}.xml`;
  const adoptedDocument = object.identity?.ownership === 'adopted';
  const registerRecords = object.descriptorContent
    ? scanDocumentRegisterRecords({ artifactPath, xml: object.descriptorContent, adoptedDocument })
    : {
      references: [],
      inheritsRegisterRecords: false,
      errors: [{ artifactPath, message: 'Captured descriptor bytes отсутствуют.' }],
    };
  if (!object.valid) {
    return {
      qualifiedName: object.qualifiedName,
      adoptedDocument,
      registerRecords: { references: [], inheritsRegisterRecords: false, errors: [{ artifactPath, message: 'Document descriptor не прошёл проверку identity.' }] },
      witnesses: recorderDocumentWitnesses(root, object),
    };
  }
  return {
    qualifiedName: object.qualifiedName,
    adoptedDocument,
    registerRecords,
    witnesses: recorderDocumentWitnesses(root, object),
  };
}

function recorderDocumentWitnesses(root: ExtensionMetadataIndex, object: ExtensionIndexedObject): MergeFileWitness[] {
  const witnesses: MergeFileWitness[] = [];
  if (root.configurationHash) {
    witnesses.push({ sourceId: root.sourceId, relativePath: CONFIGURATION_XML, expectedHash: root.configurationHash, kind: 'file' });
  }
  if (object.descriptorRelativePath && object.descriptorHash) {
    witnesses.push({ sourceId: object.sourceId, relativePath: object.descriptorRelativePath, expectedHash: object.descriptorHash, kind: 'file' });
  }
  return dedupeWitnesses(witnesses);
}

function isAdoptedDocumentOutput(output: ExtensionObjectOutput): boolean {
  return output.row.action === 'borrow-shell'
    || output.row.action === 'overlay-adopted'
    || output.row.action === 'adopted-cfe-copy'
    || (output.row.action !== 'adopted-to-cf-overlay' && output.row.incoming?.identity?.ownership === 'adopted');
}

function isRecorderRegisterType(metadataType: string): boolean {
  return metadataType === 'AccumulationRegister'
    || metadataType === 'AccountingRegister'
    || metadataType === 'CalculationRegister'
    || metadataType === 'InformationRegister';
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    byKey.set(`${witness.sourceId}\\0${witness.relativePath}\\0${witness.kind ?? 'file'}`, { ...witness });
  }
  return [...byKey.values()];
}
