# Code Review Validation and Resolution Log — 2026-07-17

Scope: independent validation of the findings originally recorded in PR #111, expansion of the review into adjacent production paths, and an audit of the fixes merged into `main`. This document records the validated state after PRs #110 and #112; it does not preserve unverified severity claims from the original report.

No exploitable XSS path was identified during validation. The webview security items below are recorded as defense-in-depth findings at their validated severities.

## Audit references

- Original findings: [PR #111](https://github.com/lekot/VScodePluginFor1CDev/pull/111), commit `26fafab1a99924ed93c9186752a6324b9c59fa02`
- Independent validation and expanded review: [validation comment on PR #111](https://github.com/lekot/VScodePluginFor1CDev/pull/111#issuecomment-5003177120)
- Remediation for validated and expanded findings: [PR #112](https://github.com/lekot/VScodePluginFor1CDev/pull/112), merged into `main`
- Non-1C workspace warning: [issue #109](https://github.com/lekot/VScodePluginFor1CDev/issues/109), resolved by [PR #110](https://github.com/lekot/VScodePluginFor1CDev/pull/110) and merged into `main`

## Original findings — validated verdicts

### F-01 — Form Editor inline CSP

- **Original rating:** High
- **Validated verdict:** Partially confirmed
- **Validated severity:** Medium
- **Status:** Resolved in merged PR #112
- **Validation:** `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'` weakened the webview's defense-in-depth boundary. Review of the actual data sources, render sinks, and escaping did not identify an exploitable injection path, so a High severity and a claim of active XSS were not supported.
- **Resolution:** Form Editor now generates a per-render nonce, applies nonce-based CSP without `unsafe-inline`, uses the nonce on its script and style blocks, removes literal inline style attributes, sets `localResourceRoots` to an empty list, and has dedicated webview security regression tests.

### F-02 — Dynamic fragments rendered through `innerHTML`

- **Original rating:** Medium
- **Validated verdict:** Active XSS not confirmed; defense-in-depth concern only
- **Validated severity:** Low
- **Status:** Hardened in merged PR #112
- **Validation:** The reviewed non-clearing `innerHTML` sinks received model values through the existing escaping helper. Hostile quote and markup payloads did not establish an active XSS path. The remaining concern was maintainability: one generic escaping contract made future context mistakes easier.
- **Resolution:** PR #112 separated text-node and attribute escaping, including both quote characters for attribute values, applied the context-specific helpers to the dynamic renderers, and added regression coverage for hostile payloads. Dynamic `innerHTML` remains a constrained implementation detail, not a documented exploitable vulnerability.

### F-03 — Eager extension and Git activation

- **Original rating:** Medium
- **Validated verdict:** Confirmed and expanded
- **Validated severity:** Medium
- **Status:** Resolved in merged PR #112
- **Validation:** `onStartupFinished` activated the extension in unrelated workspaces, metadata loading started eagerly when a workspace was present, and the activation path also caused eager `vscode.git` activation.
- **Resolution:** PR #112 removed `onStartupFinished`, retained activation for 1C workspace markers and `onDebugResolve:bsl`, deferred metadata loading until the metadata view is visible, and deferred Git integration until a relevant Explorer view is used. Contract tests cover the activation events and lazy orchestration.

### F-04 — Test commands in the production manifest

- **Original rating:** Low/Medium
- **Validated verdict:** Partially confirmed
- **Validated severity:** Low
- **Status:** Resolved in merged PR #112
- **Validation:** The test commands were already hidden from the Command Palette, but they were still publicly contributed and registered in production and development extension modes.
- **Resolution:** PR #112 removed the test-only command contributions from `package.json` and limits their runtime registration to `vscode.ExtensionMode.Test`. Manifest contract tests verify that they are absent from production contributions and modes.

### F-05 — Legacy `build/` output alongside `dist/`

- **Original rating:** Low
- **Validated verdict:** Partially confirmed as repository hygiene
- **Validated severity:** Low
- **Status:** Resolved in merged PR #112
- **Validation:** `dist/extension.js` was the correct package entry point and the legacy tree was not duplicated into the VSIX. The actual issue was 24 stale compiled files tracked under `build/`, which made repository and build ownership ambiguous.
- **Resolution:** PR #112 removed the tracked legacy `build/` files, added `build/` to `.gitignore`, retained the VSIX exclusion, and added a manifest/package contract test confirming that `dist/extension.js` is shipped while `build/` is excluded.

## Expanded findings — validated and resolved

### E-01 — P1: UUID identity was lost in full configuration compare

- **Verdict:** Confirmed
- **Status:** Resolved in merged PR #112
- **Impact:** Full compare disabled UUID reads while indexing both sides. Same-UUID renames and same-name/different-UUID objects could therefore lose their identity-conflict classification and appear as unsafe object copy candidates.
- **Resolution:** Full indexing now preserves UUID reads. Regression tests verify both same-UUID/different-name and same-name/different-UUID conflict behavior and prevent mergeable object-copy candidates from replacing identity conflicts.

### E-02 — P2: Compare webview remained busy after an exception

- **Verdict:** Confirmed
- **Status:** Resolved in merged PR #112
- **Impact:** A rejected compare operation posted an error but did not clear and republish controller state, leaving subsequent actions blocked by a stale busy flag.
- **Resolution:** The error path now resets `busy`, posts the error through the shared error channel, republishes state, and permits a retry. A regression test covers failure, recovery, and successful retry.

### E-03 — P2: `CalculationRegister` classification and module resolution

- **Verdict:** Confirmed
- **Status:** Resolved in merged PR #112
- **Impact:** `CalculationRegisters` was classified as a flat metadata folder. Its `ManagerModule.bsl` was consequently missed by compare indexing, metadata location and tree reveal, and BSL debug module resolution.
- **Resolution:** `CalculationRegisters` is now a top-level hierarchical type, `CalculationRegister` is mapped in the debug resolver, and its ManagerModule is supported by BSL indexing. Locator, compare, reveal, and debug regression tests cover the flow.

### E-04 — P2: Common Form `Ext/Form.xml` locator and reveal

- **Verdict:** Confirmed
- **Status:** Resolved in merged PR #112
- **Impact:** `CommonForms/<Name>/Ext/Form.xml` was not recognized by the metadata file locator, so reveal could not resolve the file to the Common Form tree node.
- **Resolution:** The locator now emits the Common Form container location, and tree lookup resolves the container or form XML to the Common Form node while preserving module lookup. Locator and reveal tests cover the canonical path.

### E-05 — P2: CF decomposition staging cleanup

- **Verdict:** Confirmed
- **Status:** Resolved in merged PR #112
- **Impact:** Temporary CF/CFE decomposition directories were removed only after a successful final copy, leaking staging data on service errors, cancellation, exceptions, and cancelled output-directory preparation.
- **Resolution:** Staging is now removed on success, service error, cancellation, thrown exceptions, and preparation cancellation. It is intentionally preserved only when the final copy fails, where the recovery path is shown to the user. Regression tests cover every cleanup branch.

## Related user-facing issue

The warning shown when no 1C configuration or package was found was not a failure condition for ordinary workspaces. PR #110, closing issue #109, removed the global warning while retaining tree clearing and the contextual empty state. Lifecycle regressions cover an empty workspace, no workspace, and a real loading error.

## Verification recorded by the merged fix PR

PR #112 passed compile, lint, and type checking; the core suite reported 2,895 passing, 35 pending, and 0 failing tests; smoke tests reported 10 passing and one opt-in pending test. The VSIX file list was also checked to contain `dist/extension.js` and exclude `src/` and `build/`.
