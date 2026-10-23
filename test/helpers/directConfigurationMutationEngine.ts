import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import type { AtomicFileSystem } from '../../src/services/configurationSession/atomicFileStorage';

/** Installs an explicit in-process test runner for legacy writer unit suites. */
export function installDirectConfigurationMutationEngineForTests(
  fileSystem?: AtomicFileSystem,
): () => void {
  const previousEngine = getConfigurationMutationEngine();
  setConfigurationMutationEngine(new ConfigurationMutationEngine({
    fileSystem,
    runMutation: async (_resourcePath, _kind, operation) => operation(),
  }));
  return () => setConfigurationMutationEngine(previousEngine);
}
