import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import type { CompareTreeProjection } from './projection/compareTreeProjection';

export interface ConfigCompareWebviewPayload {
  title: string;
  tree: CompareTreeProjection['root'];
  stats: CompareTreeProjection['stats'];
}

export interface ConfigCompareWebviewRenderInput {
  webview: Pick<vscode.Webview, 'cspSource'>;
  projection: CompareTreeProjection;
  title?: string;
  nonce?: string;
  htmlPath?: string;
}

export function renderConfigCompareWebviewHtml(input: ConfigCompareWebviewRenderInput): string {
  const nonce = input.nonce ?? createNonce();
  const payload: ConfigCompareWebviewPayload = {
    title: input.title ?? 'Configuration compare',
    tree: input.projection.root,
    stats: input.projection.stats,
  };
  let html = input.htmlPath
    ? fs.readFileSync(input.htmlPath, 'utf8')
    : readConfigCompareWebviewTemplate();
  html = html.replace(/\$\{webview\.cspSource\}/g, input.webview.cspSource);
  html = html.replace(/\$\{nonce\}/g, nonce);
  html = html.replace(
    '// __CONFIG_COMPARE_DATA_PLACEHOLDER__',
    `window.__configCompareData = ${escapeJsonForScript(JSON.stringify(payload))};`
  );
  return html;
}

export function showConfigurationCompare(
  context: vscode.ExtensionContext,
  projection: CompareTreeProjection,
  title = 'Configuration compare'
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    '1c-config-compare',
    title,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  panel.webview.html = renderConfigCompareWebviewHtml({
    webview: panel.webview,
    projection,
    title,
  });

  return panel;
}

export function createNonce(): string {
  return randomBytes(24).toString('base64url');
}

function readConfigCompareWebviewTemplate(): string {
  const htmlPath = resolveConfigCompareWebviewHtmlPath();
  return htmlPath ? fs.readFileSync(htmlPath, 'utf8') : DEFAULT_CONFIG_COMPARE_WEBVIEW_HTML;
}

function resolveConfigCompareWebviewHtmlPath(): string | undefined {
  const candidates = [
    path.join(__dirname, 'configCompareWebview.html'),
    path.join(__dirname, '..', '..', 'src', 'compareMerge', 'configCompareWebview.html'),
    path.join(__dirname, '..', '..', '..', 'src', 'compareMerge', 'configCompareWebview.html'),
    path.join(process.cwd(), 'src', 'compareMerge', 'configCompareWebview.html'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const DEFAULT_CONFIG_COMPARE_WEBVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-\${nonce}'; script-src 'nonce-\${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configuration compare</title>
  <style nonce="\${nonce}">
    body { margin: 0; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .node { margin: 4px 0; }
    .status { color: var(--vscode-descriptionForeground); margin-left: 6px; }
  </style>
</head>
<body>
  <h1 id="title">Configuration compare</h1>
  <div id="stats"></div>
  <ul id="tree"></ul>
  <script nonce="\${nonce}">
    // __CONFIG_COMPARE_DATA_PLACEHOLDER__
    const data = window.__configCompareData;
    function node(item) {
      const li = document.createElement('li');
      li.className = 'node';
      li.textContent = item.label + ' ';
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = item.status;
      li.append(status);
      if (item.children.length > 0) {
        const ul = document.createElement('ul');
        ul.append(...item.children.map(node));
        li.append(ul);
      }
      return li;
    }
    if (data) {
      document.getElementById('title').textContent = data.title;
      document.getElementById('stats').textContent = 'Total: ' + data.stats.total + ' / Different: ' + data.stats.different + ' / Mergeable: ' + data.stats.mergeable;
      document.getElementById('tree').append(...data.tree.children.map(node));
    }
  </script>
</body>
</html>`;
