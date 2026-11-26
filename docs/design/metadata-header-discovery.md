# Metadata header discovery for configuration comparison

## Context

Hierarchical Designer files such as `Catalogs/<folder>/<file>.xml` provide a known metadata type from their path but may not provide a qualified name. The current folder indexer parses the complete XML document to find the object's `Properties/Name` and UUID. Large metadata bodies make this identity discovery the dominant part of initial comparison inventory construction.

The folder indexer must keep XML identity authoritative: the object name can differ from the path, and similarly named properties or UUIDs can appear in nested `InternalInfo` content. The existing identity source, confidence, UUID precedence, and public `indexMetadataFile` behavior must remain unchanged.

## Decision

Add a bounded XML header reader for only the folder-indexing case where path context supplies `metadataType` but no `qualifiedName`. Read at most 64 KiB from the file in 4 KiB chunks, decoding UTF-8 incrementally. Stop immediately after the first direct `Properties/Name` element of the requested root metadata object is complete. Close open ancestors to produce a small valid XML document, then pass that document to the existing `XmlParser.parseString` so entity decoding, namespace handling, and identity extraction stay aligned with the established parser.

Support both `MetaDataObject` wrappers and direct metadata roots. Match the object root by the supplied root tags and aliases, select the root object's UUID rather than UUID-like nested content, and ignore `Properties/Name` under unrelated nested elements. If the prefix is ambiguous, unsupported, malformed, exceeds the bound before the name closes, or does not yield a confirmed name, return no header result and use the existing full-file reader. Propagate filesystem failures and comparison cancellation, and close the file handle on every outcome.

This optimization discovers presence and path identity only. It does not change the full body comparison or validate the remaining XML document. Direct calls to `indexMetadataFile`, known-type-and-qualified-name UUID prefix reads, standalone-file discovery, and all body/identity/CAS/path guards keep their current behavior.

## Alternatives considered

| Option | Trade-off | Decision |
| --- | --- | --- |
| Infer the object name from its folder or filename | Fast, but changes the provenance and can silently disagree with `Properties/Name`. | Rejected |
| Replace full XML parsing with a new streaming parser | Handles large documents uniformly, but expands parser scope and risks changing established XML semantics. | Rejected |
| Bounded header scan followed by the existing parser on a closed prefix | Avoids reading large bodies while preserving identity parsing semantics and falls back safely for uncommon shapes. | Selected |

## Data flow

1. Folder traversal derives the existing metadata path context for each XML file.
2. When both metadata type and qualified name are known, the existing UUID-prefix path is used unchanged.
3. When the metadata type is known and qualified name is absent, the header reader scans a bounded prefix for the first direct root object's `Properties/Name`.
4. A confirmed prefix is parsed by `XmlParser.parseString`; the existing identity projection supplies XML name provenance, root-object UUID, confidence, and path fields.
5. An absent or unconfirmed header falls back to the current `indexMetadataFile` full parse.

## Contracts

- `readMetadataHeaderPrefix(input: { filePath: string; rootTags: readonly string[]; cancellation?: CompareCancellationToken }): Promise<string | undefined>` returns a parseable closed XML prefix ending at the first direct `Properties/Name`, or `undefined` when it cannot safely locate one within the bound. The indexer confirms a nonempty parsed name before accepting the prefix.
- Filesystem errors and cancellation reject the promise. The opened handle is closed before resolution or rejection.
- Header success preserves the actual XML name and root-object UUID. It does not synthesize identity from the path.
- Folder indexing falls back to the existing full parser if the prefix is absent or the parsed header does not contain a confirmed object name.
- `indexMetadataFile` direct-call semantics remain unchanged.

## File and commit plan

### Commit — `feat(compare): discover hierarchical metadata identity from bounded headers`

- `src/compareMerge/metadata/metadataHeaderReader.ts` — add the bounded incremental XML prefix scanner and its public contract.
- `src/compareMerge/metadata/metadataIndexer.ts` — invoke header discovery only when path context has a metadata type and no qualified name; reuse the current parsed-identity projection and retain the full-parse fallback.
- `test/suite/compareMerge/metadataIndexer.test.ts` — add the red/green hierarchical large-body regression and focused scanner tests while preserving all existing registry, UUID-retention, folder-indexing, and read-draining tests.
- `docs/design/metadata-header-discovery.md` — record the decision, data flow, contracts, alternatives, and file plan.

## Acceptance

The targeted metadata indexer suite proves that confirmed hierarchical headers avoid full-file parsing, preserve XML-derived identity and root UUID, and safely fall back for unsupported or incomplete headers. Scanner tests cover UTF-8 chunk boundaries, namespace aliases, comments and processing instructions, quoted delimiters, nested misleading properties, the byte bound, cancellation, read errors, and handle closure. Validation stays scoped to the targeted suite, relevant TypeScript compilation, and lint for changed source files; the repository-wide core and smoke suites are not run locally.
