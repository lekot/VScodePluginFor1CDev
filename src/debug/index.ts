import * as vscode from 'vscode';
import { BslDebugSession } from './bslDebugSession';
import { BslDebugConfigProvider } from './bslDebugConfigProvider';

export function registerDebugAdapter(context: vscode.ExtensionContext): void {
  const provider = new BslDebugConfigProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('bsl', provider)
  );

  const factory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new vscode.DebugAdapterInlineImplementation(new BslDebugSession() as any);
    }
  };
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('bsl', factory)
  );
}
