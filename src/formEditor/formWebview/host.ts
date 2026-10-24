import * as vscode from 'vscode';
import { renderSecureWebviewHtml } from '../../utils/webviewSecurity';
import { getFormWebviewLayout } from './layout';
import { FORM_WEBVIEW_CSS, FORM_WEBVIEW_SCRIPT } from './generatedAssets';
import { escapeWebviewAttribute, escapeWebviewText } from './escaping';

export { escapeWebviewAttribute, escapeWebviewText };

function hostThemeFromColorKind(kind: vscode.ColorThemeKind): 'light' | 'dark' {
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

export function getWebviewHtml(
  webview: vscode.Webview,
  hostColorThemeKind: vscode.ColorThemeKind = vscode.ColorThemeKind.Dark,
): string {
  const hostTheme = hostThemeFromColorKind(hostColorThemeKind);
  const template = `<!DOCTYPE html>
<html lang="ru" data-vscode-theme="${hostTheme}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="\${csp}">
  <title>Редактор формы 1С</title>
  <style nonce="\${nonce}">
${FORM_WEBVIEW_CSS}
  </style>
</head>
<body>
${getFormWebviewLayout()}
  <script nonce="\${nonce}">${FORM_WEBVIEW_SCRIPT}
  </script>
</body>
</html>`;
  return renderSecureWebviewHtml(template, { webview });
}
