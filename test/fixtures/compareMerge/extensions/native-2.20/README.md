# Native Designer fixtures: schema 2.20

These roots are versioned copies of Designer XML exports produced by the native 1C platform, not handcrafted XML fixtures. They use Designer schema version 2.20 and were imported, checked, applied, and exported with platform/`ibcmd` 8.3.27.1859. The accepted platform report records successful import, check, apply, and re-export steps for the relevant configuration and extension roots. Calling the BSL interceptor at runtime was not verified.

## Roots

- `base/` is the base configuration export from the final `cfea-to-cfeb-own-and-adopted-common-module` acceptance case (`nativeValidation.exportRoots[0]`). Its `CommonModule.тестМодуль` contains the exported `T336_BaseHook()` procedure.
- `extension-a/` is the native baseline export of extension `CDT336A`; it contains its original root configuration and `Roles/ОсновнаяРоль.xml` without transferred metadata objects.
- `extension-b/` is the final target extension export from that acceptance case (`nativeValidation.exportRoots[1]`). It contains adopted `CommonModule.тестМодуль` with a valid `&Перед("T336_BaseHook")` interceptor and own `CommonModule.T336_Feature`.

The suite maps these three roots explicitly in `extensionCompareNative.test.ts`; it does not read `.vscode` project bindings. Tests copy each root into a temporary directory before opening a compare workspace, so fixture contents remain read-only.

## Native validation sequence

The acceptance run used a fresh temporary file infobase and the following `ibcmd` flow; all recorded commands exited successfully:

1. Create a scratch infobase.
2. Import the base configuration, run `config check`, and apply it.
3. Import the target extension with `--extension=CDT336B`, check it, and apply it.
4. Export the applied base configuration and target extension to `base/` and `extension-b/` fixture roots.

The acceptance runner report and machine-local paths stay under ignored `suite-reports/`; they are not part of these fixtures.
