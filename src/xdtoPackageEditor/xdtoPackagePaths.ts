import * as path from 'path';
import * as fs from 'fs';

const XDTO_PACKAGE_SOURCE_FILES = ['Package.bin', 'Package.xdto'] as const;

export function resolveXdtoPackageSchemaPath(metadataXmlPath: string, nodeName: string): string {
  const extDir = path.join(path.dirname(metadataXmlPath), nodeName, 'Ext');
  for (const fileName of XDTO_PACKAGE_SOURCE_FILES) {
    const candidate = path.join(extDir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(extDir, 'Package.bin');
}

export function resolveXdtoPackageSchemaCandidates(metadataXmlPath: string, nodeName: string): string[] {
  const extDir = path.join(path.dirname(metadataXmlPath), nodeName, 'Ext');
  return XDTO_PACKAGE_SOURCE_FILES.map((fileName) => path.join(extDir, fileName));
}
