# Production Configuration Merge Plan

## Commit: feat: make configuration merge executable

### Files

- `src/compareMerge/configCompareMessages.ts`
- `src/compareMerge/configurationCompareWorkspace.ts`
- `src/compareMerge/configurationCompareService.ts`
- `src/compareMerge/configCompareProvider.ts`
- `src/compareMerge/configCompareWebview.html`
- `src/compareMerge/projection/compareTreeProjection.ts`
- `src/compareMerge/merge/mergePreview.ts`
- `src/compareMerge/merge/mergePlanner.ts`
- `src/compareMerge/merge/mergeExecutor.ts`
- `src/compareMerge/merge/atomicFileWriter.ts`
- `src/commands/configurationCompareCommands.ts`
- `docs/design/production-configuration-merge.md`
- `docs/features/configuration-compare-merge.md`
- `test/suite/compareMerge/configurationCompareWorkspace.test.ts`
- `test/suite/compareMerge/configCompareProvider.test.ts`
- `test/suite/compareMerge/mergeExecutor.test.ts`
- `test/suite/compareMerge/mergePlanner.test.ts`
- `test/suite/compareMerge/compareTreeProjection.test.ts`
- `test/suite/coreSuites.ts`

### What Changes

- Add a per-panel `ConfigurationCompareWorkspace` that owns one compare session, one projection, executable candidate registry, approved preview state, and refresh lifecycle.
- Extend `buildConfigurationCompare()` so the service returns a workspace-ready result with left/right roots, BSL indexes, routine diff material, and server-side candidate factories.
- Generate executable candidates only for changed BSL routines with unambiguous left/right module matches, valid target file, no blocking diagnostics, and an automatic logical routine merge plan.
- Keep metadata, XDTO, object add/delete/rename, uuid conflict, routine add/delete/replace/reorder, and manual BSL changes visible but non-executable.
- Add a typed webview message protocol. The webview may send only readiness, selection node ids, preview id approval/execution, and refresh requests.
- Replace the static compare webview with a CSP-safe interactive view: single executable selection, preview, approve, execute, refresh, busy/error states, and locked stale-state behavior.
- Add a redacted preview DTO for UI display. Target paths, backup paths before execution, hashes, logical payloads, rollback plans, and operation payloads stay host-side only.
- Build host-side backup and rollback plans under extension storage with random unique backup names.
- Add an atomic single-file writer for BSL merge execution: canonical target validation, exclusive backup/temp creation, stale hash guards before replace, same-directory temp file, atomic replace, post-write hash verification, cleanup, and best-effort restore from backup on post-backup failure.
- Tighten preflight/executor guards to reject more than one executable operation, more than one target file, unsupported operation kinds, target files outside the left root, path prefix tricks, Windows case variance escapes, and symlink/junction/reparse escapes.
- Refresh compare state after successful execution. If refresh fails, report the write result and backup paths, then lock stale UI actions.
- Remove user-visible "MVP" wording from configuration compare projection and feature docs; use release-neutral unsupported wording.
- Keep ignored design/plan docs as explicit development artifacts; add them deliberately only if they are part of the final commit.

### Contracts

- `ConfigCompareWebviewToHostMessage`
  - `ready`
  - `selectionChanged { nodeIds: string[] }`
  - `createPreview { nodeIds: string[] }`
  - `approvePreview { previewId: string }`
  - `executeMerge { previewId: string }`
  - `refresh`

- `ConfigCompareHostToWebviewMessage`
  - `state { payload, selectedNodeIds, busy, locked, preview? }`
  - `previewReady { previewId, summary, operationCount, items, diagnostics }`
  - `mergeSuccess { applied, backupPaths, payload, locked? }`
  - `mergeError { message, diagnostics, locked? }`

- `ConfigurationCompareWorkspace`
  - `readonly payload: ConfigCompareWebviewPayload`
  - `selectNodeIds(nodeIds: readonly string[]): WorkspaceSelectionState`
  - `createPreviewForNodeIds(nodeIds: readonly string[]): Promise<WorkspacePreviewResult>`
  - `approvePreview(previewId: string): WorkspacePreviewResult`
  - `executeApprovedPreview(previewId: string): Promise<WorkspaceExecutionResult>`
  - `refresh(): Promise<WorkspaceRefreshResult>`
  - `dispose(): void`

- `ExecutableCandidateRegistry`
  - `get(nodeId: string): ExecutableCandidateFactory | undefined`
  - `listMergeableNodeIds(): string[]`
  - `clear(): void`

- `ExecutableCandidateFactory`
  - accepts the current workspace/session snapshot context;
  - returns either one trusted `MergeCandidate` or diagnostics;
  - never accepts target, backup, hash, or operation payload from webview messages.

- `AtomicFileWriter`
  - `writeAtomicWithBackup(input): Promise<AtomicWriteResult>`
  - validates target under canonical left root;
  - creates backup and temp files with random names and exclusive semantics;
  - reports backup path only after backup creation;
  - returns restore status when a post-backup failure occurs.

- `executeBslMergePreview()`
  - executes only an approved, current-workspace, non-stale preview;
  - rejects anything other than one `bslLogicalRoutineMerge` operation;
  - returns applied/skipped/failed entries and backup paths;
  - marks preview executed only after successful post-write hash verification.

### Tests

- Workspace tests cover registry resolution, forged webview data absence, single-selection enforcement, preview approval state, execute-before-approve rejection, stale preview invalidation after refresh/dispose, and post-success refresh locking on failure.
- Provider tests cover message validation, webview CSP nonce, single executable selection UI payload, preview/approve/execute message roundtrip, and no user-visible "MVP" copy.
- Planner tests cover one-operation limit, unsupported metadata/BSL statuses, stale hash diagnostics, backup/rollback mismatch, and trusted preflight storage.
- Executor tests cover atomic write success, stale target before write, target outside root, prefix trick, Windows case-insensitive normalization behavior where possible, backup pre-exists, temp pre-exists, write failure restore, restore failure diagnostic, and post-write hash verification.
- Integration-style service test covers temp left/right configurations: compare, select changed routine, preview, approve, execute, target changed, backup exists, projection refreshes.
- Quality gate runs `npx tsc --noEmit --pretty false`, `npx tsc -p tsconfig.test.json --pretty false`, targeted compare/merge mocha suites, `cmd /c test-suite.bat`, `git diff --check`, and `git status --short` before staging so the existing user-edited `FormatSamples/empty_conf/Catalogs/Справочник55/Ext/ObjectModule.bsl` is not committed.
