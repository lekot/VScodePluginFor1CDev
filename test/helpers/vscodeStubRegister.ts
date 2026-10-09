import { installVscodeModuleStubForCoreTests } from './vscodeModuleStub';
import { configureConfigurationMutationGateway } from '../../src/services/configurationSession/configurationMutationGateway';

installVscodeModuleStubForCoreTests();
configureConfigurationMutationGateway(
  async (_path, _kind, op) => op(),
);

