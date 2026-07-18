# Combined Code Review Findings -- 2026-07-18

## Scope and baseline

This register consolidates the review performed in the neighboring 5.5 workstream with an independent validation and architecture pass against main at commit ed0533891a559da9db9fe1e6eeb455fb3f9d62d8. It records the original evidence and the remediation completed on `feat/architecture-review-hardening`. Historical findings already resolved before this baseline remain in docs/code-review-findings-2026-07-17.md.

The review covered metadata mutation integrity, Designer and EDT discovery, Agent API routing and input boundaries, webview trust boundaries, extension/workspace/process lifecycle, watcher and reload cost, compare/deploy scalability, and ibcmd execution.

The pre-existing untracked user file FormatSamples/empty_c.cf was not read, modified, or removed.

Final verification:

- full `npm run verify` (compile, lint, type checking, and core suite): passed, exit code 0; the final core acceptance run reported 3,023 passing and 36 pending;
- VS Code smoke suite: 10 passing, 1 opt-in test pending;
- full local matrix: 336 passed, 0 failed, 0 skipped;
- `scripts/instrument-smoke` through `ibcmd.setup.example.bat`: passed, exit code 0;
- ibcmd import and ibcmd configuration checks: both executed successfully, exit code 0.

Follow-up acceptance closed three defects exposed only by the expanded gates: the full matrix found the R6 delete asymmetry and a fail-open runner, while concurrency stress found a FIFO lock-admission race. All three were fixed before this register was closed.

The findings below preserve the original failure scenarios and evidence for traceability. The `Evidence` and `Test gap` fields describe the pre-remediation baseline; each `Resolution and coverage` field records the implemented boundary and the regression coverage that closes that gap.

## Resolved findings

### AR-01 -- P1 -- Top-level rename and duplicate corrupt Configuration.xml identity

- **Status:** Fixed
- **Resolution and coverage:** Root rename now updates `Configuration.xml/ChildObjects` in the same mutation plan, while duplicate remaps the descriptor UUID and internal identity references before registration. Rollback/fault tests parse the resulting XML, assert fresh identities, and verify that partial operations do not survive.
- **Scenario and impact:** Duplicate a top-level metadata object and then import the configuration. The copied descriptor retains the source UUID and the new object is not added to Configuration.xml/ChildObjects. Rename a top-level object and the descriptor and directory move, but ChildObjects still references the old name. These operations can leave duplicate UUIDs, orphan descriptors, and a configuration that Designer or ibcmd cannot reliably import.
- **Evidence:**
  - src/services/elementOperations.ts:714-833 handles top-level duplication by copying and renaming descriptor text and the object directory, but does not generate a new UUID or call addRootObjectToConfiguration.
  - src/services/elementOperations.ts:986-1075 handles top-level rename by writing the new descriptor, removing the old file, moving the directory, and replacing references, but does not update Configuration.xml.
  - The create path in src/services/elementOperations.ts:316-327 explicitly registers a new root object, demonstrating the missing invariant in duplicate/rename.
  - src/services/configurationXmlUpdater.ts:69-123 and 128-228 provide the dedicated ChildObjects add/remove operations that these branches bypass.
- **Test gap:** test/suite/elementOperations.test.ts:374-416 and related DataProcessor cases assert descriptor/directory existence only. They do not parse Configuration.xml, assert a fresh UUID, or run an ibcmd import/preflight after rename or duplicate.

### AR-02 -- P1 -- Metadata mutations are neither transactional nor concurrency-safe

- **Status:** Fixed
- **Resolution and coverage:** Metadata writes now pass through per-configuration serialization, CAS-aware atomic replacement, and a durable data-only mutation journal for multi-file recovery. Concurrency, stale-hash, backup collision, injected-failure, rollback, restart recovery, and containment tests cover the storage boundary.
- **Scenario and impact:** Run two property/form edits against the same descriptor, or fail midway through a multi-file create/rename. Writers independently read old content and overwrite the target, so the later write can silently erase the earlier change. Fixed .bak names can collide, and a failure between descriptor, directory, ChildObjects, and reference updates leaves a partially applied operation. The backup is not a transaction and may restore another operation's version.
- **Evidence:**
  - src/utils/xml/xmlFileIo.ts:13-56 uses a fixed filePath.bak, writes directly to the target, and has no expected-content check, exclusive temp file, atomic rename, or per-target serialization.
  - src/utils/XMLWriter.ts:126-150 and 354-369 performs read-modify-write through that helper without compare-and-swap semantics.
  - src/formEditor/formXmlWriter.ts:343-378 repeats a fixed-backup/direct-target protocol independently.
  - src/services/configurationXmlUpdater.ts:105-123 and 210-228 writes Configuration.xml directly.
  - src/compareMerge/merge/atomicFileWriter.ts:107-165 already implements expected-hash checking, unique temp/backup files, and rename, but that protection is isolated to compare/merge.
- **Test gap:** XML and form writer tests exercise a single writer and normal rollback. There is no two-writer race, injected short/partial target write, backup-name collision, or multi-file operation failure test that asserts all-or-nothing state.

### AR-03 -- P1 -- Agent setType stores escaped XML instead of a native Type subtree

- **Status:** Fixed
- **Resolution and coverage:** `setType` installs a parsed native `Type` subtree instead of text, including scoped tabular-section columns and date qualifiers. DOM-level regression tests assert real `v8:Type` children and reject escaped wrapper XML.
- **Scenario and impact:** Call Agent setType for a root metadata property such as DefinedType.Type. The command serializes a complete Type fragment and passes it as a string property. The root property updater treats Type as text, producing escaped markup such as &lt;Type&gt;... inside the Type node rather than v8:Type child elements. The Agent self-roundtrip can appear successful while the on-disk descriptor has the wrong 1C XML structure.
- **Evidence:**
  - src/agent/agentOperations.ts:665-718 serializes a complete Type fragment and sends it through XMLWriter.writeProperties.
  - src/serializers/typeSerializer.ts:19-26 shows that serialization returns the wrapper XML, not a property object.
  - src/utils/xml/xmlPropertiesService.ts:289-332 excludes Type from fragment parsing in the root-property path and assigns text content.
  - src/utils/xml/xmlChildObjectsService.ts:736-744 contains the separate nested-element path that correctly installs parsed Type children.
- **Test gap:** test/suite/rules/agentOperations.test.ts:302-324 and 347-363 check the same internal roundtrip and string inclusion. They do not parse the resulting file and assert native v8:Type nodes or validate it with the platform.

### AR-04 -- P1 -- Webviews permit script-context injection from metadata and binding data

- **Status:** Fixed
- **Resolution and coverage:** A shared script-data encoder, nonce CSPs, message schemas, command allowlists, and payload/depth limits now protect all affected webviews. Hostile closing-script variants, malformed messages, disallowed commands, and boundary limits are covered by focused webview security tests.
- **Scenario and impact:** Open the type/object-type editor or binding dialog with attacker-controlled metadata/workspace text containing a closing-script variant such as </script >. The local escaping functions only cover the exact closing token. The value is embedded into executable inline JavaScript; two editors have no CSP and the binding dialog permits unsafe-inline. This crosses the webview trust boundary and can execute code with access to acquireVsCodeApi/postMessage.
- **Evidence:**
  - src/providers/typeEditorProvider.ts:6-9, src/providers/objectTypeEditorProvider.ts:7-9, and src/bindings/bindingDialog.ts:25-27 implement the incomplete exact-token escape.
  - src/providers/typeEditorProvider.ts:174-194 and 361-367 and src/providers/objectTypeEditorProvider.ts:163-176 and 270-273 embed serialized data into inline scripts without a restrictive CSP.
  - src/bindings/bindingDialog.ts:96-112 and 276-279 combines an unsafe-inline CSP with an inline serialized-data sink.
  - src/providers/typeEditorProvider.ts:666-681 and src/providers/objectTypeEditorProvider.ts:332-361 accept messages with weak shape validation.
  - src/utils/escapeJsonForScript.ts:5-12 contains a stronger shared encoder, but these webviews do not use it.
- **Test gap:** test/suite/bindingDialog.test.ts:234-244 covers the exact </script> spelling only. There are no whitespace/case parser variants, browser execution checks, CSP assertions for all editors, or hostile metadata-name fixtures.

### AR-05 -- P1 -- Mutating Agent commands silently target the first configuration

- **Status:** Fixed
- **Resolution and coverage:** Agent mutations resolve an explicit persisted `configurationId`; legacy omission is accepted only for an unambiguous single configuration. Multi-root routing tests cover identical object paths, unknown/stale IDs, ambiguity rejection, and Agent/UI/XDTO/root CRUD selection.
- **Scenario and impact:** Open two configuration roots A and B with the same Agent object path, then request a mutation intended for B. Core create/update/delete/rename contracts have no configuration identity and the command layer resolves configs[0]. A destructive command can therefore succeed against A without an ambiguity error or target confirmation.
- **Evidence:**
  - src/commands/index.ts:43-51 returns the first result from findAllConfigurationRoots; Agent Bridge setup also takes the first workspace at src/commands/index.ts:76-78.
  - src/agent/types.ts:10-97 defines core CRUD parameters without configPath, workspace folder, or root ID.
  - src/agent/agentCommands.ts:96-103 injects one getConfigRoot function, and destructive handlers at 254-287 instantiate operations from it.
  - src/providers/treeDataProvider.ts:512-547 supports multiple loaded configuration contexts, so the command contract is narrower than runtime state.
- **Test gap:** Agent operation tests construct one explicit root. test/suite/agentCommands.debug.test.ts covers debug proxies, not registered core CRUD routing. No test registers two roots with identical object paths and verifies selection or ambiguity rejection.

### AR-06 -- P1 -- EDT support is advertised but cannot be discovered at runtime

- **Status:** Fixed
- **Resolution and coverage:** Discovery and activation now recognize pure EDT workspaces from their native markers and `.mdo` layout, and hybrid-format precedence is explicit. Pure EDT, hybrid, activation, and `.mdo` watcher fixtures cover the runtime path.
- **Scenario and impact:** Open a pure EDT project containing .mdo descriptors but no Designer Configuration.xml. The extension does not activate/discover it. In a hybrid fixture containing Configuration.xml, detection checks Designer first and classifies it as Designer before EDT. Thus the advertised EDT parser has no reachable normal workspace path.
- **Evidence:**
  - package.json:4 advertises EDT and Designer XML, while activationEvents at package.json:18-24 contain only Designer/package markers.
  - src/parsers/formatDetector.ts:23-24 and 148-180 discovers Configuration.xml/ConfigDumpInfo.xml roots only.
  - src/parsers/formatDetector.ts:52-61 probes Designer before EDT.
  - src/parsers/designerParser.ts:1668-1688 accepts a root with Configuration.xml.
  - src/parsers/edtParser.ts:25-29 and 1076-1115 expects .mdo layout, while its root path setup at 48-61 assumes a synthesized Configuration.xml location.
- **Test gap:** test/suite/formatDetector.test.ts:7-146 has no pure EDT .mdo workspace fixture and no end-to-end discovery/activation test. Parser unit coverage does not establish runtime reachability.

### AR-07 -- P1 -- Metadata type registries drift; Sequence is silently omitted

- **Status:** Fixed
- **Resolution and coverage:** A canonical metadata type descriptor registry now drives derived mappings, and `Sequence` is registered across parsing, normalization, rules, references, file lookup, and UI capabilities. Exhaustive registry and Sequence fixture tests prevent silent list drift.
- **Scenario and impact:** Load a configuration containing Sequences. The file locator recognizes the folder, but the central MetadataType enum, parser mapper, normalized tree, rules registry, and reference-kind map do not. Sequence objects are skipped from discovery/tree/editing or degrade to Unknown depending on the entry path. Independent type lists allow this omission to compile and pass tests.
- **Evidence:**
  - src/services/metadataFileLocator.ts:45-69 explicitly lists Sequences as supported.
  - src/models/treeNode.ts:135-214 has no MetadataType.Sequence.
  - src/utils/metadataTypeMapper.ts:7-54 has no Sequences mapping; both Designer and EDT parsers iterate this map.
  - src/utils/treeNormalization.ts:70-111 has no Sequence placeholder.
  - src/rules/metadata/index.ts and src/rules/index.ts:56-100 contain no Sequence rules/registration.
  - src/constants/metadataTypeReferenceKinds.ts:7-69 is exhaustive over the enum and consequently cannot describe Sequence.
- **Test gap:** test/suite/metadataTypeMapper.test.ts verifies the current hand-maintained list rather than a canonical 1C type catalog. There is no Sequence fixture covering discovery, tree normalization, property rules, Agent operations, and compare/deploy.

### AR-08 -- P1 -- Closing a dirty Form Editor can lose data; document models are retained

- **Status:** Fixed
- **Resolution and coverage:** Form documents now follow VS Code dirty/save/save-as/revert/backup/dispose semantics and retain an unsaved model until its last editor/backup owner is released. Lifecycle tests cover close outcomes, reopen without disk overwrite, save/revert/Save As, rollback, and model release.
- **Scenario and impact:** Edit a form, close the custom-editor tab, and choose Return to form. Disposal has already removed command/dirty ownership; the reopened webview immediately requests load and disk content replaces the unsaved model. Dismissing the modal with Escape also loses data because only the explicit return label reopens. Separately, every opened Form.xml model remains in the provider map after close, producing unbounded session retention for large forms.
- **Evidence:**
  - src/formEditor/formEditorProvider.ts:103-133 removes context, command engine, and dirty state after panel close, then conditionally invokes openWith.
  - src/formEditor/formWebviewHtml.ts:3219 posts the initial load message.
  - src/formEditor/formMessageHandler.ts:285-315 reloads from disk and replaces documentModel.
  - src/formEditor/formEditorProvider.ts:25-34 defines an empty custom-document dispose and a provider-level documentModel map; disposal at 107-120 does not delete its entry.
- **Test gap:** Form lifecycle/routing tests do not create a panel, mark it dirty, fire disposal, exercise every modal outcome, and verify the reopened model. No test repeatedly opens/disposes distinct forms and asserts model release. The retention facet is P3 independently, folded into this P1 user-data-loss finding.

### AR-09 -- P1 -- Metadata reload is not single-flight and converts failures into success

- **Status:** Fixed
- **Resolution and coverage:** Reload is single-flight per configuration, propagates typed failures, uses generation/cache-epoch fences, and prevents late activation, warmup, watcher, or Agent Bridge publication after teardown. Concurrent reload, failed parse, activation rollback, dispose race, bridge start/stop, and stale-cache tests cover these paths.
- **Scenario and impact:** Trigger several reloads while one parse is in progress, or make parsing fail during watcher/delete reconciliation. Waiting callers start additional full loads instead of sharing the first promise; three callers can run concurrently and overwrite the shared pointer. A parse failure is caught and resolved, so the coordinator records success and delete reconciliation skips recovery. Deactivation does not fence late loads/warmup/watchers, activation swallows partial-registration failures, and Agent Bridge start/stop can leave a late stale discovery file.
- **Evidence:**
  - src/extension/metadataTreeLifecycle.ts:185-194 awaits an existing load but neither returns it nor re-checks before assigning a new one.
  - src/extension/metadataTreeLifecycle.ts:108-173 mutates roots, cache, warmup, watchers, and context subscriptions inside every load.
  - src/extension/metadataTreeLifecycle.ts:180-182 reports a load error without rejecting.
  - src/extension/extensionWorkspaceSetup.ts:192-197 logs success after awaiting that non-rejecting method; src/services/reloadCoordinatorService.ts:121-147 consequently records success.
  - src/reload/reloadOrchestrator.ts:96-135 uses the false result for delete reconciliation.
  - src/extension.ts:16-42 catches activation failures without rollback/rethrow; src/state/extensionState.ts:110-139 does not fence an in-flight load or dispose provider-owned warmup.
  - src/agent/agentBridgeActivation.ts:34-44 starts the bridge fire-and-forget; src/agent/agentBridge.ts:63-103 and 112-133 allows stop before server assignment or discovery-file write.
- **Test gap:** Lifecycle tests call reload serially and currently expect a failing load to resolve. Coordinator tests use a throwing stub rather than the real lifecycle. There are no gated concurrent-load, partial-activation rollback, in-flight deactivation, or interleaved Agent Bridge start/stop tests. The teardown/activation races are P2 facets folded into this P1 reload-integrity finding.

### AR-10 -- P1 -- Forms processes, sessions, and temporary data have no reliable owner

- **Status:** Fixed
- **Resolution and coverage:** Forms processes and temporary resources now have explicit lifecycle ownership, compensating reverse-order cleanup, idempotent stop, and process-tree termination. Tests cover failure after ibsrv start, repeated start/stop, cleanup-step failure, deactivation, session/temp removal, and child-process ownership.
- **Scenario and impact:** Start ibsrv successfully and then fail Chromium installation or run.mjs. The command returns an error but leaves ibsrv running. Repeated start overwrites singleton handles; stop runs browser cleanup before server cleanup so an exception skips ibsrv; extension deactivation has no Forms cleanup. Detached browser processes, ports, locks, sessions, and 1c-ibsrv-* data directories can survive the command or extension host.
- **Evidence:**
  - src/agent/agentFormsOperations.ts:59-113 stores the ibsrv handle before later fallible operations and catches without compensating cleanup.
  - src/agent/agentFormsOperations.ts:155-174 places browser stop before stopIbsrv inside one try block.
  - src/services/forms/FormsContext.ts:8-68 is a global process-owning singleton whose setters overwrite existing handles and which has no dispose/reset contract.
  - src/state/extensionState.ts:110-139 does not dispose FormsContext.
  - src/services/forms/FormsIbsrvLauncher.ts:53-57 creates a temporary data directory with no matching removal path.
  - src/services/forms/runFormsScript.ts:95-115 launches a detached/unreferenced browser helper.
- **Test gap:** test/suite/agentFormsOperations.test.ts:1-6 explicitly avoids real ibsrv and Chromium. It does not cover failure after server start, repeated start, stop-step failure, process-tree cleanup, deactivation, or temporary-directory deletion.

### AR-11 -- P1 -- One XML change causes global reload and eager whole-tree warmup

- **Status:** Fixed
- **Resolution and coverage:** Watcher-triggered work is routed to the affected configuration, cache publication is generation-scoped, and warmup is bounded and cancellable. Multi-root change isolation, coalescing, warmup cancellation, cache-generation, and watcher lifecycle tests guard against global rebuild cascades.
- **Scenario and impact:** Save one descriptor in one configuration of a large multi-root workspace. Its watcher schedules a coordinated slot keyed by that root, but the runner executes the global lifecycle, rescans every workspace root, replaces all provider state/watchers, and starts eager type-index warmup across all roots. Two roots can schedule overlapping global work. Normal editing therefore produces avoidable I/O/CPU spikes and reload cascades on the extension host.
- **Evidence:**
  - src/services/metadataWatcherService.ts:25-78 batches any matching file change into a tree reload event.
  - src/extension/metadataTreeLifecycle.ts:153-173 maps each root watcher to scheduleCoordinatedReload.
  - src/extension/extensionWorkspaceSetup.ts:192-197 invalidates one cache key but calls lifecycle.loadMetadataTree, which rediscovers and rebuilds all roots.
  - src/providers/treeDataProvider.ts:574-649 schedules warmup and iterates every lazy type folder in every root through MetadataParser.parseTypeIndex.
  - The broken single-flight guard documented in AR-09 permits these global reloads to overlap.
- **Test gap:** Watcher tests verify debounce/callback counts with small fakes. There is no large-workspace cost assertion, per-root reload contract, warmup budget/cancellation test, or simultaneous changes in two configurations.

### AR-12 -- P1 -- Deploy blocks the extension host; compare is non-cancellable and retains full sources

- **Status:** Fixed
- **Resolution and coverage:** Deploy snapshots use asynchronous bounded file work with cancellation checks; compare uses cancellable bounded readers and releases aborted session data. Focused cancellation, bounded-concurrency, large-fixture, cleanup, and responsiveness regressions cover deploy and compare paths.
- **Scenario and impact:** Deploy or compare a large configuration. Full deploy creates a recursive snapshot with synchronous filesystem APIs on the extension-host thread, during which progress cancellation cannot be observed. Compare explicitly disables cancellation, inventories both trees, hashes artifacts, then reads every BSL module into memory on both sides and retains source arrays, indexes, and maps for the session. Large configurations can freeze UI, exhaust memory, and cannot be aborted by the user.
- **Evidence:**
  - src/bindings/deployService.ts:119-132 uses mkdtempSync, cpSync recursive, and rmSync for a complete configuration snapshot.
  - src/bindings/bindingCommands.ts:218-239 exposes a cancellable notification, but synchronous snapshot work cannot poll its token.
  - src/commands/configurationCompareCommands.ts:126-147 sets cancellable: false and its build contract accepts no CancellationToken.
  - src/compareMerge/configurationCompareService.ts:479-514 builds both inventories and complete BSL source/index sets.
  - src/compareMerge/configurationCompareService.ts:777-791 uses unbounded Promise.all to read all BSL source text, which is subsequently retained in source maps/session projections.
  - src/compareMerge/metadata/metadataIndexer.ts:126-152 additionally scans with 64 concurrent collectors.
- **Test gap:** Deploy tests use small temporary trees and do not measure extension-host responsiveness or cancel during snapshot. Compare tests use compact fixtures and do not assert bounded concurrency/memory, cancellation propagation, or cleanup after an aborted build.

### AR-13 -- P2 -- Workspace containment and Agent metadata-name validation are missing

- **Status:** Fixed
- **Resolution and coverage:** Shared 1C name validation and canonical containment checks now protect binding and Agent paths, with revalidation immediately before disk effects. Tests cover absolute and parent traversal, separators, invalid/reserved names, case-insensitive duplicates, symlink/canonical-parent escapes, and nested rename boundaries.
- **Scenario and impact:** Store an absolute or ../../ path in a binding, or call Agent create/rename/add-child with separators and invalid 1C identifier characters. Binding validation checks only non-empty shape and deploy resolves the path without proving it stays in the selected workspace. Agent creation checks only non-empty text and joins it into filesystem paths instead of using the existing identifier validator. This can deploy from an unintended configuration and can write/move/delete outside the intended metadata folder, as well as create platform-invalid names.
- **Evidence:**
  - src/bindings/bindingPathUtils.ts:4-8 normalizes slashes only; src/bindings/bindingManager.ts:12-26 and src/bindings/bindingFileCodec.ts:25-49 do not reject absolute, parent, or symlink escapes.
  - src/bindings/deployService.ts:139-166 calls path.resolve and verifies basename/existence, but not containment under workspaceFolderRoot.
  - src/agent/agentOperations.ts:66-137 validates name as a non-empty string, then joins it into descriptor/directory paths.
  - src/agent/agentPathResolver.ts:17-35 constructs a target path from unvalidated path segments with no post-resolution containment check.
  - src/utils/elementNameValidator.ts:1-78 already defines 1C identifier rules, but Agent mutations do not use it consistently.
- **Test gap:** Binding path/deploy tests have no absolute, parent traversal, cross-root, case, or symlink cases. Agent tests have no slash/backslash traversal, reserved word, leading digit, overlength, case-insensitive duplicate, or containment assertions.

### AR-14 -- P2 -- Watcher and workspace lifecycle omit EDT changes and retain disposed resources

- **Status:** Fixed
- **Resolution and coverage:** Metadata watchers include EDT and structural module changes, workspace-folder additions/removals refresh the registry, and replaced watchers are disposed by their owning scope rather than accumulated in extension subscriptions. `.mdo`, folder lifecycle, stale-root, empty-workspace cleanup, and repeated-reload retention tests cover the lifecycle.
- **Scenario and impact:** Add a 1C folder after the metadata view has auto-loaded once, remove a loaded folder, edit an EDT .mdo file, or repeatedly reload. There is no metadata workspace-folder listener; stale roots can remain actionable and newly added roots remain invisible. Watchers only match XML, so EDT metadata changes do not refresh. Empty-workspace/no-config returns happen before old watcher cleanup. Each successful reload pushes replacement watchers into context.subscriptions, so disposed watcher objects accumulate for the session.
- **Evidence:**
  - src/extension/lazyWorkspaceOrchestrator.ts:23-42 makes automatic metadata loading a one-shot action.
  - src/bindings/bindingTreeDecorations.ts:67-69 is the only production workspace-folder listener and refreshes binding decorations, not metadata lifecycle.
  - src/services/metadataWatcherService.ts:25-42 uses the fixed pattern **/*.xml and excludes .mdo.
  - src/extension/metadataTreeLifecycle.ts:80-94 returns for no workspace/no configuration before watcher cleanup.
  - src/extension/metadataTreeLifecycle.ts:153-173 disposes active watchers but pushes every replacement into extensionContext.subscriptions; disposed entries are never removed.
- **Test gap:** Metadata watcher tests cover XML only. Lifecycle tests hold workspaceFolders fixed and do not preload watchers/subscriptions. There is no add/remove folder integration test, .mdo event test, stale-node command guard, or repeated-reload retention assertion.

### AR-15 -- P2 -- Virtual workspaces are falsely supported and Forms reads the wrong setting

- **Status:** Fixed
- **Resolution and coverage:** The manifest now truthfully limits unsupported virtual workspaces, file-only commands are guarded, and Forms resolves the documented `1cMetadataTree.platform.path` setting. Manifest capability, non-file URI rejection, and platform-setting fallback tests cover both facets.
- **Scenario and impact:** Use GitHub Repositories or another non-file workspace. Because the manifest does not declare virtual-workspace limitations, VS Code can activate the extension, but discovery and mutations convert URIs to fsPath and use Node filesystem APIs against a phantom local path. Separately, formsStart without an explicit platformPath ignores the documented 1cMetadataTree.platform.path setting because it queries 1cMetadataTree.platformPath instead.
- **Evidence:**
  - package.json:18-26 has no capabilities.virtualWorkspaces declaration.
  - src/extension/metadataTreeLifecycle.ts:81-90 converts every workspace URI to fsPath, and src/parsers/formatDetector.ts:1 and 40-49 uses Node fs directly.
  - package.json:1091 defines 1cMetadataTree.platform.path.
  - src/services/metadataTreeSettings.ts:53-62 reads the correct full key.
  - src/agent/agentFormsOperations.ts:49-55 instead uses getConfiguration('1cMetadataTree').get('platformPath') and reports the same wrong key.
- **Test gap:** There are no non-file URI activation/command tests or manifest capability assertion. Forms tests do not seed only the real platform.path setting and verify fallback resolution.

### AR-16 -- P2 -- ibcmd discovery blocks synchronously and cancellation does not terminate the process tree

- **Status:** Fixed
- **Resolution and coverage:** ibcmd resolution is asynchronous with positive and negative caching, while cancellation performs verified process-tree termination with graceful escalation and correct streaming UTF chunk handling. Resolver, cache, cancellation, descendant-cleanup, and stream-boundary tests pass; real ibcmd import and configuration checks also executed successfully with exit code 0.
- **Scenario and impact:** Invoke an ibcmd-backed command when ibcmd is absent or cancel a long-running operation on Windows. Path resolution can synchronously run where/which for up to eight seconds and scan installation directories on the extension-host thread. Only successful paths are cached, so missing-path resolution repeats across command call sites. Streaming cancellation sends signals to the direct child only; it does not terminate descendants/process groups, and the Windows escalation condition relies on child.killed, which becomes true after the first kill request rather than after process exit. A descendant can survive cancellation and keep locks/resources.
- **Evidence:**
  - src/services/ibcmd/IbcmdPathResolver.ts:73-103 calls execFileSync with an 8-second timeout; 105-133 performs synchronous recursive installation-directory scanning.
  - src/services/ibcmd/IbcmdService.ts:20-57 caches only resolved paths and performs synchronous detection in resolveExecutablePath.
  - src/services/ibcmd/IbcmdStreamingRunner.ts:94-112 calls proc.kill on the direct process and has no Windows taskkill/process-group implementation.
  - src/services/ibcmd/IbcmdStreamingRunner.ts:238-270 requests kill on cancellation but resolves from the child close event; it has no verified descendant shutdown contract.
  - There are 25 production resolveExecutablePath call sites, including deploy and infobase commands, so a not-found result can repeatedly block user actions.
- **Test gap:** test/suite/ibcmdPathResolver.test.ts injects synchronous fakes and does not measure extension-host blocking or negative-result caching. test/suite/ibcmdStreamingRunner.test.ts uses a fake direct child and does not spawn a real child/grandchild process on Windows or assert process-tree termination.

## Summary

| Severity | Primary resolved findings |
| --- | ---: |
| P0 | 0 |
| P1 | 12 |
| P2 | 4 |
| P3 | 0 |
| **Total** | **16** |

Open primary findings: **0**. Secondary P2 activation/deactivation/Agent Bridge races are folded into AR-09. The independent P3 Form document-model retention defect is folded into AR-08, and disposed watcher/subscription retention is folded into AR-14; the table counts primary categories only.
