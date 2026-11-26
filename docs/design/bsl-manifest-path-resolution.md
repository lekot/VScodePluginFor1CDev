# BSL manifest path resolution

## Problem

The metadata locator is described as a pure string mapper, but its generic root selection calls `canonicalizeFsPath` for each root and file. That filesystem-aware behavior supports editor paths, aliases, and nested roots. A compare inventory that already enumerated a manifest therefore pays filesystem resolution again for every BSL file.

## Accepted design

Keep filesystem-aware root selection in `locateMetadataFile(filePath, configRoots)`. Extract the existing metadata path grammar into one parser that consumes the selected root and relative path. Add `locateMetadataFileWithinRoot(filePath, configRoot)`, a lexical helper for paths already enumerated beneath one known root. It normalizes both paths, derives a relative path, rejects the root itself and paths outside the root using path-segment boundaries, and passes the result to the shared grammar parser.

The within-root helper performs no filesystem calls. It does not resolve symlinks, short names, or aliases, and does not choose among overlapping roots. Its caller must provide a manifest file path and its producer root using the same lexical spelling. Existing write-permission and symlink checks remain in their current flows.

The BSL identity resolver gains an optional `BslModuleLocationResolver` parameter after its existing input. The default remains `locateMetadataFile`, preserving all current public calls. Manifest indexing can supply a callback that maps each known file path with `locateMetadataFileWithinRoot`; this work changes only the callback contract in the indexer, not the manifest producer or inventory collection.

## Data flow and contracts

The generic locator first performs its existing canonical root selection and retains its selected original root and relative path. Both locator entry points then use the same grammar parser, which returns the existing `MetadataLocation` shape, including aliases, extension prefixes, subsystem hierarchies, and module `subPath` values.

`locateMetadataFileWithinRoot(filePath: string, configRoot: string): MetadataLocation | null` handles exactly one lexical root. It returns `null` for the root itself, sibling paths, outside paths, and unsupported metadata paths. It does not call `realpath`, `stat`, `access`, or read file contents.

`BslModuleLocationResolver` is `(filePath: string, configRoots: readonly string[]) => MetadataLocation | null`. `resolveSupportedBslModuleIdentity(input, locationResolver = locateMetadataFile)` invokes the resolver once. Omitting it preserves existing behavior and identity output.

## Alternatives and trade-offs

- Caching canonical roots still resolves each file path and leaves the per-file filesystem cost.
- Removing canonicalization globally breaks editor alias and nested-root behavior.
- The selected explicit within-root path keeps the existing generic behavior while allowing manifest producers to use their already-known lexical root without filesystem work.

## Implementation plan

1. Add this design and plan document and an explicit `.gitignore` exception for it.
2. In `src/services/metadataFileLocator.ts`, extract the current path grammar after root selection into one shared parser, route the generic locator through it, add the pure one-root helper, and correct the misleading module comment.
3. In `src/compareMerge/bsl/bslModuleIndexer.ts`, export the resolver callback type and add an optional resolver parameter to `resolveSupportedBslModuleIdentity`; preserve all other indexer behavior and existing unrelated edits.
4. Add targeted tests in `test/suite/metadataFileLocator.test.ts` and `test/suite/compareMerge/bslModuleIndexer.cooperative.test.ts` for zero-I/O path mapping, grammar parity, lexical boundaries, custom resolver use, and default resolver compatibility.
5. Build only the owned test entries into a private temporary output, run the two targeted Mocha suites, and review the final diff without changing unrelated working-tree files.
