import { createHash } from 'crypto';
import type * as vscode from 'vscode';

export type PendingEventBinding =
  | { kind: 'form'; eventName: string; methodName: string }
  | {
      kind: 'element';
      elementId: string;
      eventName: string;
      methodName: string;
      hadPreviousValue: boolean;
      previousValue?: string;
    };

export interface PendingFormModuleTransaction {
  modulePath: string;
  moduleExisted: boolean;
  originalContent: string;
  generatedRegions: Array<{
    start: number;
    content: string;
  }>;
  expectedContentHash: string;
  bindings: PendingEventBinding[];
}

export function recordPendingModuleBinding(
  transactions: Map<string, PendingFormModuleTransaction> | undefined,
  documentKey: string,
  details: {
    modulePath: string;
    moduleExisted: boolean;
    inserted: {
      document: Pick<vscode.TextDocument, 'getText'>;
      originalText: string;
      addedText: string;
    };
    binding: PendingEventBinding;
  },
): void {
  if (!transactions) {
    return;
  }
  const transaction = transactions.get(documentKey) ?? {
    modulePath: details.modulePath,
    moduleExisted: details.moduleExisted,
    originalContent: details.inserted.originalText,
    generatedRegions: [],
    expectedContentHash: '',
    bindings: [],
  };
  transaction.generatedRegions.push({
    start: details.inserted.originalText.length,
    content: details.inserted.addedText,
  });
  transaction.expectedContentHash = createHash('sha256')
    .update(details.inserted.document.getText(), 'utf8')
    .digest('hex');
  transaction.bindings.push(details.binding);
  transactions.set(documentKey, transaction);
}
