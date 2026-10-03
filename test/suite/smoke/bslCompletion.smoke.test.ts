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

function insertedText(item: vscode.CompletionItem | undefined): string | undefined {
  const insertText = item?.insertText;
  return typeof insertText === 'string' ? insertText : insertText?.value;
}

async function revealMetadataFile(filePath: string): Promise<void> {
  const metadataDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(metadataDocument);
  await vscode.commands.executeCommand('1c-metadata-tree.revealActiveFileInTree');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

function assertPathIsWithin(parentPath: string, targetPath: string): void {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to remove path outside its expected parent: ${target}`);
  }
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
    const commonModuleWorkspace = vscode.workspace.workspaceFolders?.find(({ uri }) =>
      fs.existsSync(path.join(uri.fsPath, 'CommonModules', 'мойМодульэ.xml')),
    );
    const commonModuleName = 'мойМодульэ';
    const catalogWorkspace = vscode.workspace.workspaceFolders?.find(({ uri }) =>
      fs.existsSync(path.join(uri.fsPath, 'Catalogs', 'TestCatalog1.xml')),
    );
    const callerName = `CompletionCaller${process.pid}`;
    const callerRoot = commonModuleWorkspace
      ? path.join(commonModuleWorkspace.uri.fsPath, 'CommonModules', callerName)
      : undefined;
    const source = [
      'Процедура ЛокальнаяПроцедура(Первый, Второй)',
      'КонецПроцедуры',
      '',
      'Новый Зап',
      'ЛокальнаяП',
      'КонецЦ',
      'КонецП',
      'Исключ',
      '',
      'Новый Структура("Код", 1,',
      'ЛокальнаяПроцедура(1,',
      'мойМодул',
      'ТекущаяД',
      'Справочники.TestCatalog1.Созд',
    ].join('\n');
    const filePath = callerRoot
      ? path.join(callerRoot, 'Ext', 'Module.bsl')
      : path.join(workspaceFolder?.uri.fsPath ?? '', `.bsl-completion-smoke-${process.pid}-${Date.now()}.bsl`);
    let document: vscode.TextDocument | undefined;

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
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

      const structureHelp = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        document.uri,
        new vscode.Position(9, 'Новый Структура("Код", 1,'.length),
      );
      assert.deepStrictEqual(
        structureHelp?.signatures.map(({ label }) => label),
        ['Структура(Ключи, Значение1, …)', 'Структура(ФиксированнаяСтруктура)'],
        'signature help should include the supported Structure overloads',
      );
      assert.strictEqual(structureHelp?.activeParameter, 1);

      const routineHelp = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        document.uri,
        new vscode.Position(10, 'ЛокальнаяПроцедура(1,'.length),
      );
      assert.strictEqual(
        routineHelp?.signatures[0].label,
        'ЛокальнаяПроцедура(Первый, Второй)',
        'signature help should read parameters from the current unsaved module',
      );
      assert.strictEqual(routineHelp?.activeParameter, 1);

      const currentDateResult = await vscode.commands.executeCommand<
        vscode.CompletionList | vscode.CompletionItem[]
      >('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(12, 'ТекущаяД'.length));
      const currentDate = completionItems(currentDateResult).find(({ label }) =>
        (typeof label === 'string' ? label : label.label) === 'ТекущаяДата',
      );
      assert.strictEqual(insertedText(currentDate), 'ТекущаяДата()$0', 'zero-argument platform methods should insert a closed call snippet');

      if (catalogWorkspace) {
        await vscode.commands.executeCommand('1c-metadata-tree.refresh');
        assert.strictEqual(
          await vscode.commands.executeCommand<boolean>('1c-metadata-tree.getTreeReadyForTest'),
          true,
          'metadata tree must load Catalogs before catalog member completion',
        );
        await revealMetadataFile(path.join(catalogWorkspace.uri.fsPath, 'Catalogs', 'TestCatalog1.xml'));
        await vscode.window.showTextDocument(document);
        const catalogPrefix = 'Справочники.TestCatalog1.Созд';
        const catalogOffset = document.getText().lastIndexOf(catalogPrefix) + catalogPrefix.length;
        const catalogPosition = document.positionAt(catalogOffset);
        const catalogResult = await vscode.commands.executeCommand<
          vscode.CompletionList | vscode.CompletionItem[]
        >('vscode.executeCompletionItemProvider', document.uri, catalogPosition);
        const catalogLabels = labels(catalogResult);
        assert.ok(catalogLabels.includes('СоздатьЭлемент'), `CatalogManager article should suggest СоздатьЭлемент; got: ${catalogLabels.join(', ')}`);
        assert.ok(catalogLabels.includes('СоздатьГруппу'), `CatalogManager article should suggest СоздатьГруппу; got: ${catalogLabels.join(', ')}`);
      }

      if (commonModuleWorkspace) {
        await vscode.commands.executeCommand('1c-metadata-tree.refresh');
        assert.strictEqual(
          await vscode.commands.executeCommand<boolean>('1c-metadata-tree.getTreeReadyForTest'),
          true,
          'metadata tree root should be loaded before revealing the CommonModule',
        );
        await revealMetadataFile(path.join(commonModuleWorkspace.uri.fsPath, 'CommonModules', `${commonModuleName}.xml`));
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('1c-metadata-tree.revealActiveFileInTree');

        const commonModulePrefix = 'мойМодул';
        const commonModuleOffset = document.getText().lastIndexOf(commonModulePrefix) + commonModulePrefix.length;
        assert.ok(commonModuleOffset >= commonModulePrefix.length, 'BSL document should contain the CommonModule prefix');
        const commonModulePosition = document.positionAt(commonModuleOffset);
        assert.strictEqual(
          document.lineAt(commonModulePosition.line).text.slice(0, commonModulePosition.character),
          commonModulePrefix,
          'completion cursor should be immediately after the screenshot prefix',
        );
        const commonModuleResult = await vscode.commands.executeCommand<
          vscode.CompletionList | vscode.CompletionItem[]
        >('vscode.executeCompletionItemProvider', document.uri, commonModulePosition);
        const commonModuleItems = completionItems(commonModuleResult);
        const commonModule = commonModuleItems.find(({ label }) =>
          (typeof label === 'string' ? label : label.label) === commonModuleName,
        );
        assert.ok(
          commonModule,
          `completion should include loaded мойМодульэ by мойМодул; got: ${labels(commonModuleResult).join(', ')}`,
        );
        assert.strictEqual(commonModule?.kind, vscode.CompletionItemKind.Module);
        assert.strictEqual(commonModule?.detail, 'Общий модуль метаданных');
      }
    } finally {
      if (document && vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      await fs.promises.unlink(filePath).catch(() => undefined);
      if (callerRoot && commonModuleWorkspace) {
        assertPathIsWithin(path.join(commonModuleWorkspace.uri.fsPath, 'CommonModules'), callerRoot);
        await fs.promises.rm(callerRoot, { recursive: true, force: true });
      }
    }
  });
});
