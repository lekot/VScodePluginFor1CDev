# Code review findings — 2026-07-17

Scope: repository review focused on VS Code extension activation, webview security, packaging hygiene, and production command surface. No production code was changed as part of this review.

## Findings

### 1. High — Form Editor webview allows inline scripts and styles

The Form Editor webview CSP currently permits inline script and style execution:

- `script-src 'unsafe-inline'`
- `style-src 'unsafe-inline'`

This weakens the webview isolation boundary. If any dynamic HTML path misses escaping, injected markup can execute JavaScript in the webview context and use the VS Code messaging bridge.

Relevant files:

- `src/formEditor/formWebviewHtml.ts`
- `src/formEditor/formEditorProvider.ts`
- `src/xdtoPackageCompare/xdtoPackageCompareWebview.html` as a safer nonce-based comparison point

Recommended remediation:

1. Move Form Editor scripts and styles to nonce-protected blocks or external webview resources.
2. Generate a nonce per webview render.
3. Replace the current `unsafe-inline` CSP with nonce-based `script-src` and `style-src` directives.
4. Set explicit `localResourceRoots` on the Form Editor webview when local resources are needed.

### 2. Medium — Form Editor builds large dynamic DOM fragments through string concatenation and `innerHTML`

The Form Editor renders multiple property panels by concatenating HTML strings and assigning them through `innerHTML`. Current code uses escaping in many places, but the pattern is fragile: future additions can easily introduce unescaped labels, attributes, URLs, or event-like values.

Relevant file:

- `src/formEditor/formWebviewHtml.ts`

Recommended remediation:

1. Prefer `document.createElement`, `textContent`, `setAttribute`, and direct input `value` assignments for dynamic UI.
2. If string rendering remains, centralize escaping helpers for text nodes and attributes separately.
3. Add regression tests with hostile values such as `"><img src=x onerror=...>` and mixed quote payloads.

### 3. Medium — Extension activates eagerly on every VS Code startup

The extension is configured with `onStartupFinished`, and activation immediately wires extension services. If workspace folders exist, activation also starts metadata tree loading. This can add startup overhead even in workspaces that are not 1C projects.

Relevant files:

- `package.json`
- `src/extension.ts`

Recommended remediation:

1. Replace eager activation with lazy activation events such as `onCommand`, `onCustomEditor`, debug-related activation, or `workspaceContains` markers for 1C metadata.
2. Gate automatic metadata tree loading behind a workspace-shape check.
3. Consider deferring expensive initialization until the tree view or a CDT 41 command is actually used.

### 4. Low/Medium — Test commands are contributed in the production manifest

The manifest contributes commands whose titles start with `Test:`. If these are present in the published VSIX, they increase the public command surface and can confuse users or become accidental compatibility constraints.

Relevant file:

- `package.json`

Recommended remediation:

1. Move test-only commands to a test/dev manifest or register them conditionally only in test runs.
2. If they must remain contributed, hide them from normal UX and document why they are production-safe.

### 5. Low — Repository contains both `dist` and legacy `build` compiled artifacts

The package entry point targets `dist`, while the repository also contains a separate `build` directory with compiled JavaScript, declarations, and source maps. Keeping multiple generated output trees can confuse reviewers and packaging scripts and may increase VSIX size if not explicitly ignored.

Relevant files/directories:

- `package.json`
- `dist/`
- `build/`

Recommended remediation:

1. Confirm `.vscodeignore` excludes stale or legacy build outputs that are not needed in the package.
2. Remove or document the legacy `build` tree if it is intentionally retained.
3. Ensure release packaging consumes only the intended compiled output.
