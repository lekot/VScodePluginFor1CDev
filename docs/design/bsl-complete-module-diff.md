# BSL complete module diff

## Problem and accepted design

Routine-level comparison currently reports a module as fully matched when its parsed routines are equal, even if source outside those routines changed. This can hide module globals, initialization code, comments, or module directives. The same gap affects modules with no routines. Routine matching also performs a right-array scan for each left routine when obtaining the right index.

Keep the existing routine parser, routine diff, merge identities, and safe-anchor insertion contracts. Index normalized fingerprints for the source gaps outside routine ranges, plus each routine's active conditional-preprocessor context. Exclude attached directives that the lexer already assigns to a routine. At diff time, re-anchor gap fingerprints to the common routine names so routine insertion, deletion, and reorder do not shift module text between anchors. Compare common routines' preprocessor contexts as well. Do not place the resulting content conflict in the blocking diagnostics list: healthy routine-level changes must remain independently selectable.

Each outside gap fingerprint removes routine ranges and their attached directive lines, normalizes CRLF/LF, and ignores whitespace-only separator lines. It retains every character of all other nonblank source lines, including indentation and trailing spaces in multiline string literals, as well as globals, module initialization, comments, and module directives. Empty gaps use `''` and are not hashed. The index retains the normalized nonblank gap source alongside its fingerprint so gaps split by an added/deleted routine can be concatenated before hashing; this avoids treating a routine-only insertion inside an outside-text gap as a content change. Gaps are keyed as the module prefix, suffix, or by their neighboring common routine names. A single forward sweep folds new/deleted routine anchors into adjacent gaps; empty gaps do not make a routine reorder look like module-content change. This detects movement of meaningful outside text between routine anchors, including moving `#If`/`#Else`/`#EndIf` regions around unchanged routines.

The index also stores the active conditional stack at each routine declaration, recognizing English `#If`/`#ElsIf`/`#ElseIf`/`#Else`/`#EndIf` and Russian `#Если`/`#ИначеЕсли`/`#Иначе`/`#КонецЕсли` spellings. A newly added routine with a nonempty, unknown, or invalid conditional context receives a per-routine manual merge reason because current routine insertion appends it outside that region. The candidate factory must honor this reason before registering an added-routine operation. Malformed/unbalanced directive stacks fail closed for routine insertions. This blocks only that routine; other safe routines remain independently selectable.

## Data flow and contracts

`indexBslModuleSource({ identity, source })` parses routines once and stores optional `nonRoutineSegmentFingerprints` (one entry per gap), their normalized nonblank source in `nonRoutineSegments` (one entry per gap), and `routineConditionalContextFingerprints` (aligned with the parsed routines) on `BslModuleIndexEntry`. The fields are optional so existing callers that construct entries directly remain compatible. Indexing always populates them, including for empty modules. Diffing folds segment source in one linear pass and hashes the joined text for each common-routine anchor. When both entries have normalized segments, the diff uses them for this fold; older hand-built entries continue using their supplied fingerprints.

`diffBslModules({ left, right })` compares re-anchored gap fingerprints and common-routine contexts when both entries have them. A mismatch adds `nonRoutineChange` to `BslRoutineDiffResult`; it does not add a blocking `BslModuleDiagnostic`, change `canAutoMatch`, or alter routine statuses, order, indices, or summary. An added routine with a nonempty, unknown, or invalid right-side conditional context receives `mergeBlockReason` on its `BslRoutineDiffItem`. Entries without the new fingerprints preserve the previous behavior. Duplicate-routine and parser diagnostics remain unchanged.

`BslRoutineDiffResult.nonRoutineChange` has the shape `{ message: string }`. Its message is a Russian manual-review reason explaining that source outside routines changed and requires whole-module comparison. `CompareTreeProjection` projects it as a distinct nonmergeable, blocking logical-conflict child with canonical ID `bsl:module-content:${moduleId}`. The projection keeps this conflict separate from routine merge gating. A routine item's `mergeBlockReason` projects as a blocking conflict on that routine only, including for `added` items.

The routine diff builds a name-to-routine-and-index lookup in one pass. Existing output order, statuses, and indices remain unchanged, with no per-left-routine `rightRoutines.indexOf` scan.

## FormEvent handler conditional safety

`fingerprintBslRoutineConditionalContexts(source, routines)` is the shared conditional-context calculation used by both module indexing and extension FormEvent handler projection. Its output aligns with the input routine order. A FormEvent handler may receive an executable insertion candidate only when its context is exactly the empty string. A nonempty, missing, or invalid context produces a visible right-only `bslRoutine` node with a blocking `bslLogicalConflict` and a Russian manual reason; that handler has no routine factory and no `incomingRoutineNodeId`. The node carries `presentation.qualifiedName` equal to the canonical Form module ID so module ownership stays explicit. A guarded handler therefore leaves its event pointer nonmergeable, while an unrelated unguarded handler remains independently selectable. Existing target handlers and attached routine directive semantics remain unchanged.

## Canonical standard-module coverage

### Problem and accepted design

The current BSL module identity admission hard-codes a narrow owner allowlist, so valid metadata standard modules such as register RecordSet modules and DataProcessor/Report object modules never reach deep paired-routine comparison. Expand admission through the repository's canonical metadata standard-module registry; do not add a second owner/type allowlist or accept arbitrary paths. Keep Configuration-root modules such as ManagedApplication outside this tranche because they belong to a separate manifest-root scope.

Preserve all existing Object, Manager, Common, Form, and Command identities and their behavior. Add the supported BSL kinds RecordSet and ValueManager with stable module identity suffixes `.RecordSet` and `.ValueManager`. Resolve an owner and module kind through the canonical descriptor and module-file helpers; return unsupported for paths or kinds the registry does not define. This makes the same ordinary paired-routine factory eligible for newly recognized standard modules without changing parsing or merge behavior. Unpaired whole-file transfer remains shallow and outside this paired-module admission change.

The display tree labels these new kinds in Russian as “Модуль набора записей” and “Модуль менеджера значений”. Registry coverage tests derive owner folders from `METADATA_TYPE_DESCRIPTORS` and cover every non-Configuration standard module descriptor, including Information, Accumulation, Accounting, and Calculation registers, Sequence, processor object modules, Report manager modules, and the remaining registered standard kinds. Keep a genuinely unsupported non-BSL path as a negative case.

### Configuration-root modules remain out of scope

This registry tranche covers non-Configuration metadata objects only; it does not establish all-BSL coverage. The configuration specification's `Ext/` section lists four root modules: `Ext/ManagedApplicationModule.bsl`, `Ext/OrdinaryApplicationModule.bsl`, `Ext/SessionModule.bsl`, and `Ext/ExternalConnectionModule.bsl` (`C:\reps\cc-1c-skills\docs\1c-configuration-spec.md`, lines 387–398). The standard-module registry contains a descriptor only for ManagedApplication. These root files still lack configuration-root metadata identities, manifest ownership, locator admission, and paired BSL module IDs in the compare pipeline.

Supporting those files requires a separate configuration-root identity/ownership slice that admits all four module paths and routes paired modules through deep comparison. Generic merge support for root properties in `Configuration.xml` is also a separate follow-up. Neither scope is implemented or claimed by the current non-Configuration module coverage.

### Implementation plan

1. Change the existing RecordSet and ValueManager unsupported assertions into runtime regressions that require canonical identities and parsed routines; add registry-table and genuinely unsupported-path cases before source changes.
2. Replace the narrow identity allowlists with canonical registry lookups while preserving existing identity strings, and add RecordSet/ValueManager kinds and suffixes. Keep new helper functions at or below complexity 15.
3. Add the two Russian display labels and a focused projection-label regression.
4. After the service test owner releases `configurationCompareService.test.ts`, add a public-service paired-module integration test for RecordSet, ValueManager, DataProcessor Object, and Report Manager modules. Each case must expose a manual conflict and a healthy added routine, then prove the healthy routine executes while the manual target routine and source bytes remain unchanged. Reuse existing unpaired-transfer coverage to confirm zero-routine whole-file behavior.
5. Run targeted private TypeScript compilation and the affected module-index, projection-label, and service suites; run default ESLint, complexity checks for new helpers, and `git diff --check`. Do not run full core, smoke, or real-configuration profiling for this tranche.

## Verification

### Earlier module completeness and FormEvent safety tranche

The targeted private TypeScript build completed with exit code 0. Five BSL suites passed 74 tests: `bslRoutineDiff.test.ts`, `bslModuleIndexer.cooperative.test.ts`, `bslInventoryCollection.test.ts`, `compareTreeProjection.test.ts`, and `bslRoutineLogicalMerge.test.ts`. The focused `extensionCompare.test.ts` FormEvent conditional-safety test passed 1 test, including preview, approval, execution, preservation of the existing handler, and unchanged source bytes. Default ESLint passed on the four changed source files; the new extension handler projection also passed the explicit complexity limit of 15.

### Canonical standard-module coverage tranche

Private strict TypeScript compilation completed with exit code 0. Four targeted suites passed 105 tests: `bslRoutineDiff.test.ts`, `bslModuleIndexer.cooperative.test.ts`, `compareDisplayTree.test.ts`, and `configurationCompareService.test.ts`. Coverage includes all non-Configuration standard-module descriptors, preserved unsupported Rights paths, paired parsing on both sides for RecordSet, ValueManager, DataProcessor Object, and Report Manager modules, and public preview/approval/execution that keeps conflicting target routines and incoming source bytes unchanged. Default ESLint passed on the changed source and test files; the new indexer identity helpers passed the explicit complexity limit of 15. `git diff --check` passed for the changed tracked files.

## Boundaries and alternatives

The change does not build a BSL AST or treat routine additions/deletions as module-content conflicts. Whole-file/unpaired module behavior remains outside this paired-routine diff. A raw module hash was rejected because any routine change would block unrelated routine selection. A full semantic BSL parser rewrite is outside this slice.

## Implementation plan

1. Add index-entry fingerprinting from existing parsed routine spans and attached directive values; preserve empty-module fingerprints and all characters in nonblank outside lines.
2. Add an optional separate outside-source change result while retaining routine diagnostics, matching, and summary contracts; replace repeated right-array index lookup with a name/index map.
3. Project the outside-source result as its own canonical blocking conflict child without adding it to routine diagnostics or changing routine mergeability.
4. Add targeted regression coverage for outside globals, initialization, comments and module directives; empty modules; significant whitespace in multiline literals; insertion/reorder/line shifts with unchanged prefix globals and suffix initialization; moved `#If` and `#Else` regions/comments; guarded routine additions blocked individually; attached directives and routine-body comments; mixed outside conflict plus actual safe routine insertion against the original target; ordered/index regression; and canonical projection.
5. Run only the affected BSL routine-diff and compare-tree-projection Mocha suites, plus type/compile checks if available after the workspace baseline copy is complete. Review complexity and sonar findings; leave unrelated working-tree changes untouched.
