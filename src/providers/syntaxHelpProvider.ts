import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import type { SyntaxHelpArticle, SyntaxHelpItem, SyntaxHelpSource } from '../agent/agentSyntaxHelp';

export const SHOW_SYNTAX_HELP_COMMAND = '1c-metadata-tree.showSyntaxHelp';
export const SEARCH_SYNTAX_HELP_COMMAND = '1c-metadata-tree.searchSyntaxHelp';
const AGENT_SYNTAX_HELP_COMMAND = '1c-metadata-tree.agent.syntaxHelp';
const SYNTAX_HELP_PANEL_TYPE = '1c-metadata-tree.syntaxHelp';
const MAX_QUERY_LENGTH = 500;
const MAX_SEARCH_LINE_LENGTH = 2000;

interface SyntaxHelpSearchData {
  readonly line?: string;
  readonly terms?: string[];
  readonly query?: string;
  readonly total: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly items: SyntaxHelpItem[];
}

interface SyntaxHelpPick extends vscode.QuickPickItem {
  readonly item: SyntaxHelpItem;
}

function getSearchLineContext(line: string, cursorColumn: number): { line: string; cursorColumn: number } {
  const boundedCursor = Math.max(0, Math.min(cursorColumn, line.length));
  if (line.length <= MAX_SEARCH_LINE_LENGTH) { return { line, cursorColumn: boundedCursor }; }
  const start = Math.max(
    0,
    Math.min(boundedCursor - Math.floor(MAX_SEARCH_LINE_LENGTH / 2), line.length - MAX_SEARCH_LINE_LENGTH),
  );
  return {
    line: line.slice(start, start + MAX_SEARCH_LINE_LENGTH),
    cursorColumn: boundedCursor - start,
  };
}

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

markdown.validateLink = (href: string): boolean => {
  if (href.startsWith('#')) { return true; }
  try {
    return new URL(href).protocol === 'https:';
  } catch {
    return false;
  }
};
markdown.renderer.rules.image = (tokens, index): string => {
  const alt = markdown.utils.escapeHtml(tokens[index].content);
  return `<span class="image-alt">[Изображение: ${alt}]</span>`;
};
const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer): string => {
  const href = tokens[index].attrGet('href') ?? '';
  if (href.startsWith('https://')) {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, environment, renderer)
    : renderer.renderToken(tokens, index, options);
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value) { return undefined; }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'its.1c.ru' && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function renderSyntaxHelpHtml(article: SyntaxHelpArticle, cspSource: string): string {
  const sourceUrl = safeSourceUrl(article.sourceUrl);
  const sourceLink = sourceUrl
    ? `<footer><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник на ИТС</a></footer>`
    : '';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)} 'unsafe-inline'; font-src ${escapeHtml(cspSource)}; img-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(article.name)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; padding: 0 1.5rem 2rem; }
    main { max-width: 900px; margin: 0 auto; }
    h1, h2, h3, h4 { line-height: 1.3; margin-top: 1.8em; }
    h1 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .4em; }
    a { color: var(--vscode-textLink-foreground); }
    code, pre { font-family: var(--vscode-editor-font-family); }
    code { background: var(--vscode-textCodeBlock-background); padding: .1em .25em; border-radius: 3px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 1em; overflow-x: auto; border-radius: 4px; }
    pre code { padding: 0; background: transparent; }
    blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-descriptionForeground); }
    table { border-collapse: collapse; display: block; overflow-x: auto; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: .35em .7em; }
    th { background: var(--vscode-textCodeBlock-background); }
    footer { border-top: 1px solid var(--vscode-panel-border); margin-top: 2rem; padding-top: 1rem; }
    .image-alt { color: var(--vscode-descriptionForeground); font-style: italic; }
  </style>
</head>
<body>
  <main><article>${markdown.render(article.markdown)}</article>${sourceLink}</main>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function searchDataOf(value: unknown): SyntaxHelpSearchData | undefined {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)
    || !Array.isArray(value.data.items) || typeof value.data.total !== 'number'
    || typeof value.data.limit !== 'number' || typeof value.data.hasMore !== 'boolean') {
    return undefined;
  }
  return value.data as unknown as SyntaxHelpSearchData;
}

function articleOf(value: unknown): SyntaxHelpArticle | undefined {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)
    || typeof value.data.id !== 'string' || typeof value.data.name !== 'string'
    || typeof value.data.source !== 'string' || typeof value.data.path !== 'string'
    || typeof value.data.markdown !== 'string') {
    return undefined;
  }
  return value.data as unknown as SyntaxHelpArticle;
}

function errorOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === 'string' ? value.error : undefined;
}

function makePick(item: SyntaxHelpItem): SyntaxHelpPick {
  const sourceName = item.source === 'syntax' ? 'Справка платформы' : 'Стандарт разработки';
  return {
    label: item.name,
    description: `${sourceName} · ${item.path}`,
    detail: item.snippet,
    item,
  };
}

export class SyntaxHelpProvider {
  private panel: vscode.WebviewPanel | undefined;

  async showAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'bsl') {
      await this.searchByQuery();
      return;
    }
    const cursor = editor.selection.active;
    const line = editor.document.lineAt(cursor.line).text;
    if (!line.trim()) {
      await this.searchByQuery();
      return;
    }
    const searchContext = getSearchLineContext(line, cursor.character);
    await this.search({
      action: 'searchLine',
      ...searchContext,
      source: 'all',
      limit: 50,
    }, `По текущей строке: ${line}`);
  }

  async searchByQuery(): Promise<void> {
    const query = await this.promptForQuery();
    if (!query) { return; }
    await this.search({ action: 'search', query, source: 'all', limit: 50 }, `Поиск: ${query}`);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async promptForQuery(): Promise<string | undefined> {
    const query = await vscode.window.showInputBox({
      title: 'CDT 41: Найти в справке',
      prompt: 'Введите имя элемента, процедуры или термин',
      placeHolder: 'Например, НачатьТранзакцию',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.trim()) { return 'Введите поисковый запрос.'; }
        if (value.length > MAX_QUERY_LENGTH) { return `Не более ${MAX_QUERY_LENGTH} символов.`; }
        return undefined;
      },
    });
    return query?.trim();
  }

  private async search(
    params: Record<string, unknown>,
    title: string,
    allowRetry = true,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await vscode.commands.executeCommand<unknown>(AGENT_SYNTAX_HELP_COMMAND, params);
    } catch (error) {
      await vscode.window.showErrorMessage(`Не удалось выполнить поиск в справке: ${this.errorMessage(error)}`);
      return;
    }
    const data = searchDataOf(result);
    if (!data) {
      await vscode.window.showErrorMessage(`Не удалось выполнить поиск в справке: ${errorOf(result) ?? 'неожиданный ответ службы справки.'}`);
      return;
    }
    const validItems = data.items.filter((item): item is SyntaxHelpItem => isRecord(item)
      && typeof item.id === 'string' && typeof item.name === 'string'
      && (item.source === 'syntax' || item.source === 'standards')
      && typeof item.path === 'string' && typeof item.snippet === 'string');
    if (validItems.length === 0) {
      if (!allowRetry) {
        await vscode.window.showInformationMessage('По этому запросу статей справки не найдено.');
        return;
      }
      const retry = await vscode.window.showInformationMessage(
        'Статей справки по контексту не найдено.',
        'Ввести запрос',
      );
      if (retry === 'Ввести запрос') {
        const query = await this.promptForQuery();
        if (query) { await this.search({ action: 'search', query, source: 'all', limit: 50 }, `Поиск: ${query}`, false); }
      }
      return;
    }

    const terms = Array.isArray(data.terms) ? data.terms.join(', ') : data.query ?? '';
    const countHint = data.hasMore ? `Показаны первые ${data.limit} из ${data.total}. ` : '';
    const selected = await vscode.window.showQuickPick<SyntaxHelpPick>(validItems.map(makePick), {
      title: 'CDT 41: Справка',
      placeHolder: `${countHint}${terms ? `Найдено по: ${terms}` : title}`,
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!selected) { return; }
    await this.openSelectedArticle(selected.item);
  }

  private async openSelectedArticle(item: SyntaxHelpItem): Promise<void> {
    let result: unknown;
    try {
      result = await vscode.commands.executeCommand<unknown>(AGENT_SYNTAX_HELP_COMMAND, {
        action: 'get',
        id: item.id,
        source: item.source as SyntaxHelpSource,
      });
    } catch (error) {
      await vscode.window.showErrorMessage(`Не удалось открыть статью справки: ${this.errorMessage(error)}`);
      return;
    }
    const article = articleOf(result);
    if (!article) {
      await vscode.window.showErrorMessage(`Не удалось открыть статью справки: ${errorOf(result) ?? 'статья не найдена.'}`);
      return;
    }
    this.showArticle(article);
  }

  private showArticle(article: SyntaxHelpArticle): void {
    if (this.panel) {
      this.panel.title = article.name;
      this.panel.webview.html = renderSyntaxHelpHtml(article, this.panel.webview.cspSource);
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SYNTAX_HELP_PANEL_TYPE,
      article.name,
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: false, localResourceRoots: [] },
    );
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) { this.panel = undefined; }
    });
    panel.webview.html = renderSyntaxHelpHtml(article, panel.webview.cspSource);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'неизвестная ошибка.';
  }
}

export function registerSyntaxHelpCommands(): vscode.Disposable[] {
  const provider = new SyntaxHelpProvider();
  return [
    vscode.commands.registerCommand(SHOW_SYNTAX_HELP_COMMAND, () => provider.showAtCursor()),
    vscode.commands.registerCommand(SEARCH_SYNTAX_HELP_COMMAND, () => provider.searchByQuery()),
    { dispose: () => provider.dispose() },
  ];
}
