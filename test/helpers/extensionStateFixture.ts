import * as vscode from 'vscode';
import { createExtensionState, type ExtensionState } from '../../src/state/extensionState';
import type {
  ExtensionRuntimeHandles,
  ExtensionStateCompositionPort,
} from '../../src/state/extensionStateComposition';

export interface ExtensionStateFixture {
  readonly state: ExtensionState;
  readonly composition: ExtensionStateCompositionPort;
  publish(handles: Partial<ExtensionRuntimeHandles>): void;
  clear(): void;
  dispose(): Promise<void>;
}

/** Builds an isolated activation state with one test-owned cleanup callback. */
export function createExtensionStateFixture(
  handles: Partial<ExtensionRuntimeHandles> = {},
  extensionContext?: vscode.ExtensionContext,
): ExtensionStateFixture {
  const assembly = createExtensionState();
  if (extensionContext) {
    assembly.composition.initialize(extensionContext);
  }
  assembly.composition.bindDispose(async () => {
    assembly.composition.clear();
  });
  assembly.composition.publish(handles);

  return {
    state: assembly.state,
    composition: assembly.composition,
    publish: (nextHandles) => assembly.composition.publish(nextHandles),
    clear: () => assembly.composition.clear(),
    dispose: () => assembly.state.dispose(),
  };
}
