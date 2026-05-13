import * as path from 'path';

export function resolveXdtoPackageSchemaPath(metadataXmlPath: string, nodeName: string): string {
  return path.join(path.dirname(metadataXmlPath), nodeName, 'Ext', 'Package.xdto');
}
