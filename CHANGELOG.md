# Changelog

All notable changes to the "1C Metadata Tree" extension will be documented in this file.

## [0.2.9] - 2025-03-12

### Fixed
- Fixed boolean properties in Attributes displaying as text strings ("false"/"true") instead of checkboxes
- Applied `convertStringBooleans` conversion to `flattenAttributeProperties` method in designerParser

### Added
- Added Russian labels for Attribute properties (PasswordMode → "Режим пароля", Format → "Формат", etc.)
- Added 40+ property label mappings for common attribute properties

## [0.1.2] - 2025-03-11

### Fixed
- Fixed extension activation issue - extension now activates properly on command invocation
- Fixed missing dependency issue - `fast-xml-parser` is now included in VSIX package
- Fixed auto-load blocking activation - metadata loading is now non-blocking

### Changed
- Updated `.vscodeignore` to include `fast-xml-parser` dependency in VSIX
- Changed `activationEvents` to activate on command and view events
- Improved error handling during extension activation

### Added
- Added activation completion logging for debugging
- Added Windows PowerShell workarounds documentation in steering files

## [0.1.0] - Initial Release

### Added
- Initial release of 1C Metadata Tree extension
- Support for Designer format (1cv8.cf, ConfigDumpInfo.xml)
- Support for EDT format (Configuration.xml)
- Tree view for 1C configuration metadata
- Recursive configuration search up to 5 levels deep
- Command: "1C: Open Metadata Tree" (Ctrl+Shift+M)
- Command: "Refresh" for metadata tree
