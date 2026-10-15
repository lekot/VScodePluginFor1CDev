import { ConfigFormat } from '../../src/parsers/formatDetector';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import type { TreeLoadContext } from '../../src/types/treeLoadContext';
import { configurationPathKey } from '../../src/utils/configurationPathIdentity';

/** Creates an explicit, stable context for synthetic tree fixtures. */
export function fakeTreeLoadContext(
  configPath: string,
  format: ConfigFormat = ConfigFormat.Designer,
  configurationId = `test:${configurationPathKey(configPath)}`,
): TreeLoadContext {
  return Object.freeze({
    configurationId: configurationId as ConfigurationId,
    configPath,
    format,
  });
}
