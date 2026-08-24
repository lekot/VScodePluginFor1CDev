import * as fs from 'fs';
import * as path from 'path';
import { parseCfeObjectIdentity } from '../extensionSupport/cfeProject/ownership';
import { CfeProjectError } from '../extensionSupport/cfeProject/types';

/**
 * Generic form-editor writes are forbidden for an adopted CFE form. The form
 * metadata remains the source of truth, so an ordinary non-CFE form keeps its
 * established editor behavior even when no CFE project is open.
 */
export async function assertGenericFormMutationAllowed(formXmlPath: string): Promise<void> {
  const metadataPath = formMetadataPath(formXmlPath);
  let metadata: string;
  try {
    metadata = await fs.promises.readFile(metadataPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  let identity;
  try {
    identity = parseCfeObjectIdentity(metadata, metadataPath);
  } catch {
    if (hasAdoptedOwnershipMarker(metadata)) {
      throw adoptedFormMutationError();
    }
    // A malformed non-CFE neighbour must not change generic editor behavior.
    return;
  }
  if (identity.type === 'Form' && identity.ownership === 'adopted') {
    throw adoptedFormMutationError();
  }
}

function hasAdoptedOwnershipMarker(metadata: string): boolean {
  return /<(?:[\p{L}_][\p{L}\p{N}_-]*:)?ObjectBelonging\b[^>]*>\s*Adopted\s*<\/(?:[\p{L}_][\p{L}\p{N}_-]*:)?ObjectBelonging\s*>/iu.test(metadata);
}

function adoptedFormMutationError(): CfeProjectError {
  return new CfeProjectError(
    'CFE_ADOPTED_OPERATION_REQUIRED',
    'Заимствованную форму CFE можно изменять только командой расширения формы.',
  );
}

function formMetadataPath(formXmlPath: string): string {
  const formDirectory = path.dirname(path.dirname(formXmlPath));
  return path.join(path.dirname(formDirectory), `${path.basename(formDirectory)}.xml`);
}
