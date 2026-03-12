# Changelog

All notable changes to the "1C Metadata Tree" extension will be documented in this file.

## [0.5.5] - 2026-03-12

### Fixed
- Type editor: primitive qualifiers (String length, Number precision/scale, Date parts) now display correctly
- Type editor: Save button enables when changes are made and persists type configuration
- Type editor: Cancel button closes the editor and discards unsaved changes
- Type editor: "edit type" label replaced with pencil icon
- Corrected `isRootElement` logic for nested elements (sibling persistence)
- Add missing edit button for Attribute Type field in properties panel

### Added
- Type editor preservation and bug-condition tests (qualifiers, Save, Cancel)

## [0.4.x] - 2026-03

### Fixed
- Type display in properties panel (defensive formatting, avoid "[object Object]")
- Type arrays formatting for root elements (catalogs, documents)
- Reference types formatting in XMLWriter
- Type property check made case-insensitive for edit button
- Type property support for attributes (v8:TypeSet, DefinedType)

### Added
- Attribute type editor with visual type selection (TypeEditorProvider, TypeParser, TypeFormatter)

## [0.2.9] - 2026-03-12

### Fixed
- Boolean properties in Attributes displaying as text strings ("false"/"true") instead of checkboxes
- Applied `convertStringBooleans` conversion to `flattenAttributeProperties` in designerParser

### Added
- Russian labels for Attribute properties (40+ mappings)

## [0.1.2] - 2026-03-11

### Fixed
- Extension activation on command invocation
- Missing dependency in VSIX (`fast-xml-parser` and transitive deps)
- Auto-load blocking activation

### Changed
- `.vscodeignore` updated for VSIX packaging
- `activationEvents` for command and view

## [0.1.0] - Initial Release

### Added
- 1C Metadata Tree extension
- Designer and EDT format support
- Tree view, recursive configuration search
- Commands: "1C: Open Metadata Tree" (Ctrl+Shift+M), "Refresh"
