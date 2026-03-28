import * as assert from 'assert';
import { showIbcmdNotFoundDialog } from '../../src/services/ibcmd/showIbcmdNotFoundDialog';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('showIbcmdNotFoundDialog', () => {
  setup(() => {
    resetVscodeTestState();
  });

  teardown(() => {
    resetVscodeTestState();
  });

  test('opens settings when user chooses "Открыть настройки"', async () => {
    vscodeTestState.informationMessageResult = 'Открыть настройки';
    await showIbcmdNotFoundDialog();
    assert.ok(
      vscodeTestState.executedCommands.some(
        (args) =>
          args[0] === 'workbench.action.openSettings' && args[1] === '1cMetadataTree.ibcmd.path'
      ),
      `expected openSettings command, got: ${JSON.stringify(vscodeTestState.executedCommands)}`
    );
  });

  test('does not open settings when dialog is dismissed', async () => {
    vscodeTestState.informationMessageResult = undefined;
    await showIbcmdNotFoundDialog();
    assert.strictEqual(
      vscodeTestState.executedCommands.filter((a) => a[0] === 'workbench.action.openSettings').length,
      0
    );
  });
});
