import * as fs from 'fs';
import * as path from 'path';

export interface GuardDetection {
  readonly hasConfigurationXml: boolean;
  readonly missingFiles: string[];
}

export function detectDeployGuards(
  relativeFiles: readonly string[],
  configRoot: string,
): GuardDetection {
  let hasConfigurationXml = false;
  const missingFiles: string[] = [];

  for (const file of relativeFiles) {
    const lower = file.toLowerCase();
    if (lower === 'configuration.xml' || lower.endsWith('/configuration.xml')) {
      hasConfigurationXml = true;
    }

    if (!fs.existsSync(path.resolve(configRoot, file))) {
      missingFiles.push(file);
    }
  }

  return { hasConfigurationXml, missingFiles };
}
