import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'Lekot.1c-metadata-tree-vscode';

function labels(result: vscode.CompletionList | vscode.CompletionItem[] | undefined): string[] {
  return completionItems(result).map(({ label }) => typeof label === 'string' ? label : label.label);
}

function completionItems(result: vscode.CompletionList | vscode.CompletionItem[] | undefined): vscode.CompletionItem[] {
  return Array.isArray(result) ? result : result?.items ?? [];
}

suite('Smoke: BSL completion', () => {
  test('returns static platform and current-module suggestions in a metadata workspace', async function () {
    this.timeout(25000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'CDT extension must be present');
    if (extension && !extension.isActive) {
      await extension.activate();
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Smoke requires the metadata fixture workspace');
    const source = [
      'Процедура ЛокальнаяПроцедура()',
      'КонецПроцедуры',
      '',
      'Новый Зап',
      'ЛокальнаяП',
      'КонецЦ',
      'КонецП',
      'Исключ',
    ].join('\n');
    const filePath = path.join(
      workspaceFolder.uri.fsPath,
      `.bsl-completion-smoke-${process.pid}-${Date.now()}.bsl`,
    );
    let document: vscode.TextDocument | undefined;

    try {
      await fs.promises.writeFile(filePath, source, 'utf8');
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      assert.strictEqual(document.languageId, 'bsl', 'temporary .bsl file must use the BSL language selector');
      await vscode.window.showTextDocument(document);

      const platformItems = await vscode.commands.executeCommand<
        vscode.CompletionList | vscode.CompletionItem[]
      >('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(3, 'Новый Зап'.length));
      assert.ok(labels(platformItems).includes('Запрос'), 'static platform completion should suggest the Query constructor');

      const localItems = await vscode.commands.executeCommand<
        vscode.CompletionList | vscode.CompletionItem[]
      >('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(4, 'ЛокальнаяП'.length));
      assert.ok(labels(localItems).includes('ЛокальнаяПроцедура'), 'completion should include a routine parsed from the current module');

      const loopEndItems = await vscode.commands.executeCommand<
        vscode.CompletionList | vscode.CompletionItem[]
      >('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(5, 'КонецЦ'.length));
      assert.ok(labels(loopEndItems).includes('КонецЦикла'), 'completion should suggest the BSL loop terminator');

      const procedureEndItems = await vscode.commands.executeCommand<
        vscode.CompletionList | vscode.CompletionItem[]
      >('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(6, 'КонецП'.length));
      assert.ok(labels(procedureEndItems).includes('КонецПроцедуры'), 'completion should suggest a BSL routine terminator');

      const exceptionResult = await vscode.commands.executeCommand<
        vscode.CompletionList | vscode.CompletionItem[]
      >('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(7, 'Исключ'.length));
      const exceptionItems = completionItems(exceptionResult);
      const exceptionKeyword = exceptionItems.find(({ label }) =>
        (typeof label === 'string' ? label : label.label) === 'Исключение',
      );
      assert.ok(exceptionKeyword, 'completion should suggest the BSL exception branch');
      assert.ok(exceptionKeyword?.sortText?.startsWith('0_'), 'the exception keyword should sort ahead of platform globals');
      const otherPlatformItems = exceptionItems.filter((item) => item.sortText && !item.sortText.startsWith('0_'));
      assert.ok(
        otherPlatformItems.every((item) => exceptionKeyword?.sortText! < item.sortText!),
        'the exception keyword should precede similarly prefixed platform names',
      );
    } finally {
      if (document && vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      await fs.promises.unlink(filePath).catch(() => undefined);
    }
  });
});
