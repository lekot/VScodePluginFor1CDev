import type { ExtensionMetadataReference } from './extensionDependencyScanner';
import type { ExtensionSemanticSelection } from './extensionTransfer';
import { sameExtensionRelativePath } from './extensionRoleRightsWholeTransferPolicy';
import type { ExtensionObjectOutput } from './extensionMaterializerTypes';

/** Identifies a selected Rights reference whose CFE declaration is checked as a batch. */
export function selectedAdoptedRightsReference(
  owner: ExtensionObjectOutput,
  reference: ExtensionMetadataReference,
  selectedSemantic: ReadonlyMap<string, readonly ExtensionSemanticSelection[]>,
  dependencyKey: (qualifiedName: string) => string,
): boolean {
  return (selectedSemantic.get(owner.row.id) ?? []).some((selection) =>
    selection.kind === 'roleRightsXml'
      && selection.adoptedRights !== undefined
      && sameExtensionRelativePath(selection.targetRelativePath, reference.artifactPath)
      && selection.requiredCfeDeclarationReferences?.some((qualifiedName) =>
        dependencyKey(qualifiedName) === dependencyKey(reference.qualifiedName),
      ) === true,
  );
}

/** Confirms a selected output adds the exact physical CFE declaration for a Rights reference. */
export function selectedOutputDeclaresCfeObject(
  output: ExtensionObjectOutput,
  reference: ExtensionMetadataReference,
  dependencyKey: (qualifiedName: string) => string,
): boolean {
  const incoming = output.row.incoming;
  const registration = output.addRegistration;
  return Boolean(incoming?.descriptorRelativePath
    && incoming.identity?.type === reference.metadataType
    && dependencyKey(incoming.qualifiedName) === dependencyKey(reference.qualifiedName)
    && output.writes.some((write) => sameExtensionRelativePath(write.relativePath, incoming.descriptorRelativePath!))
    && registration?.type === 'add'
    && registration.rootTag === reference.metadataType
    && dependencyKey(registration.objectName) === dependencyKey(reference.objectName));
}
