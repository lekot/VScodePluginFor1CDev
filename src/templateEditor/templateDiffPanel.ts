import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../utils/logger';
import {
  GitHeadReadError,
  LinkedCancellation,
  readGitHeadProcess,
  type GitHeadReadDependencies,
  type GitHeadReadOptions,
} from './gitHeadReader';
import {
  buildPreviewCoreHtml,
  DCS_CORE_SCRIPTS,
  DCS_CORE_STYLES,
  isDataCompositionSchema,
  previewCoreRoot,
  TEMPLATE_CORE_SCRIPTS,
  TEMPLATE_CORE_STYLES,
} from './previewCoreHtml';

export { GitHeadReadError } from './gitHeadReader';
export type {
  GitHeadReadDependencies,
  GitHeadReadErrorCode,
  GitHeadReadOptions,
} from './gitHeadReader';

/** Scheme of the read-only documents that hold a compared revision for the XML diff. */
export const TEMPLATE_REVISION_SCHEME = '1c-template-revision';

export interface DiffSide {
  /** Document text; '' for a side that does not exist (a file added since HEAD). */
  text: string;
  label: string;
  /** What the plain XML diff opens for this side. */
  uri: vscode.Uri;
}

interface GitApi {
  git: { path?: string };
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

async function resolveGitExecutable(): Promise<string> {
  const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!gitExtension) {
    throw new Error('Встроенное расширение Git в VS Code недоступно.');
  }

  let gitPath: string | undefined;
  try {
    gitPath = (await gitExtension.activate()).getAPI(1).git.path;
  } catch {
    throw new Error('Не удалось активировать встроенное расширение Git в VS Code.');
  }
  if (!gitPath || !path.isAbsolute(gitPath)) {
    throw new Error('Встроенное расширение Git в VS Code не предоставило абсолютный путь к Git.');
  }
  return gitPath;
}

/** Holds compared revisions so that vscode.diff can open them as documents. */
export class TemplateRevisionContentProvider implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private next = 0;

  remember(text: string, fileName: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: TEMPLATE_REVISION_SCHEME,
      path: `/${this.next++}/${fileName}`,
    });
    this.texts.set(uri.toString(), text);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }
}

/** Text of `file` at git HEAD; '' when the file is not in HEAD. Rejects outside a repository. */
export async function readGitHead(
  file: string,
  options: GitHeadReadOptions = {},
  dependencies: GitHeadReadDependencies = {}
): Promise<string> {
  const cancellation = new LinkedCancellation(options.token);
  try {
    return await readGitHeadProcess(file, options, {
      ...dependencies,
      resolveGitExecutable: dependencies.resolveGitExecutable ?? resolveGitExecutable,
    }, cancellation);
  } finally {
    cancellation.dispose();
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Current text of a file: the open document when there is one (unsaved changes included). */
export async function readCurrent(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return stripBom(Buffer.from(bytes).toString('utf8'));
}

/** Opens the visual comparison of two spreadsheet templates or two data composition schemas. */
export function showTemplateDiff(
  extensionUri: vscode.Uri,
  title: string,
  left: DiffSide,
  right: DiffSide
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    '1c-template-diff',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [previewCoreRoot(extensionUri)],
    }
  );
  /* The listener goes first: the page posts 'ready' as soon as it loads. */
  panel.webview.onDidReceiveMessage((msg: unknown) => {
    const type = msg && typeof msg === 'object' ? (msg as { type?: unknown }).type : undefined;
    if (type === 'ready') {
      void panel.webview.postMessage({
        type: 'show',
        left: { text: left.text, label: left.label },
        right: { text: right.text, label: right.label },
      });
    } else if (type === 'showXml') {
      void vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${title} (XML)`);
    }
  });
  /* A side that does not exist ('') takes the kind of the other one. */
  const dcs = isDataCompositionSchema(left.text) || isDataCompositionSchema(right.text);
  panel.webview.html = buildPreviewCoreHtml(panel.webview, extensionUri, {
    title,
    body: '<div id="diff-panel"></div>',
    scripts: dcs
      ? [...DCS_CORE_SCRIPTS, 'host/dcs-diff.js']
      : [...TEMPLATE_CORE_SCRIPTS, 'host/template-diff.js'],
    styles: dcs ? DCS_CORE_STYLES : TEMPLATE_CORE_STYLES,
  });
  return panel;
}

function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) {
    return tab.uri;
  }
  return undefined;
}

/** Registers «compare with HEAD» and «compare two templates». */
export function registerTemplateDiffCommands(extensionUri: vscode.Uri): vscode.Disposable[] {
  const revisions = new TemplateRevisionContentProvider();
  const disposables: vscode.Disposable[] = [];
  registerOwned(disposables, () =>
    vscode.workspace.registerTextDocumentContentProvider(TEMPLATE_REVISION_SCHEME, revisions));

  registerOwned(disposables, () =>
    vscode.commands.registerCommand('1c-template-editor.compareWithHead', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!uri || uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('Выберите файл макета Template.xml.');
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Сравнение макета с HEAD',
          cancellable: true,
        },
        async (_progress, token) => {
          const operationCancellation = new LinkedCancellation(token);
          const headPromise = readGitHead(uri.fsPath, { token: operationCancellation });
          try {
            const [base, current] = await Promise.all([
              headPromise,
              readCurrent(uri),
            ]);
            if (token.isCancellationRequested) {
              return;
            }
            const name = path.basename(uri.fsPath);
            showTemplateDiff(
              extensionUri,
              `${relativeName(uri)} ↔ HEAD`,
              { text: base, label: 'HEAD', uri: revisions.remember(base, name) },
              { text: current, label: 'текущее состояние', uri }
            );
          } catch (err) {
            let displayError = err;
            operationCancellation.cancel();
            const headError = await headPromise.then(
              () => undefined,
              (headErr: unknown) => headErr
            );
            if (headError instanceof GitHeadReadError && headError.code === 'TERMINATION_FAILED') {
              displayError = headError;
            } else if (
              token.isCancellationRequested &&
              headError instanceof GitHeadReadError &&
              headError.code === 'CANCELLED'
            ) {
              return;
            }
            Logger.error('Template diff: git HEAD is not available', displayError);
            void vscode.window.showErrorMessage(
              `Не удалось получить версию из git: ${displayError instanceof Error ? displayError.message : String(displayError)}`
            );
          } finally {
            operationCancellation.dispose();
          }
        }
      );
    }));

  registerOwned(disposables, () =>
    vscode.commands.registerCommand(
      '1c-template-editor.compareFiles',
      async (arg?: unknown, selected?: unknown) => {
        const picked = Array.isArray(selected)
          ? selected.filter((u): u is vscode.Uri => u instanceof vscode.Uri)
          : [];
        let pair: vscode.Uri[] = picked.length === 2 ? picked : [];
        if (pair.length !== 2) {
          const first = targetUri(arg);
          if (!first) {
            void vscode.window.showWarningMessage('Выберите файл макета Template.xml.');
            return;
          }
          const other = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Сравнить',
            filters: { 'Макет 1С': ['xml'] },
          });
          if (!other || other.length === 0) {
            return;
          }
          pair = [other[0], first];
        }
        try {
          const [leftText, rightText] = await Promise.all(pair.map((u) => readCurrent(u)));
          showTemplateDiff(
            extensionUri,
            `${relativeName(pair[0])} ↔ ${relativeName(pair[1])}`,
            { text: leftText, label: relativeName(pair[0]), uri: pair[0] },
            { text: rightText, label: relativeName(pair[1]), uri: pair[1] }
          );
        } catch (err) {
          Logger.error('Template diff: failed to read files', err);
          void vscode.window.showErrorMessage('Не удалось прочитать макеты для сравнения.');
        }
      }
    ));
  return disposables;
}

function registerOwned(
  owned: vscode.Disposable[],
  register: () => vscode.Disposable,
): void {
  try {
    owned.push(register());
  } catch (error) {
    for (const disposable of owned.splice(0).reverse()) {
      try {
        disposable.dispose();
      } catch (disposeError) {
        Logger.warn('Template diff registration rollback failed', disposeError);
      }
    }
    throw error;
  }
}

/** «Documents/Invoice/Templates/Print» rather than the bare «Template.xml». */
function relativeName(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel.replace(/[\\/]Ext[\\/]Template\.xml$/i, '');
}
