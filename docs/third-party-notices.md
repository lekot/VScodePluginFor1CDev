# Third-party notices

## BslEdit form editor adaptations

`src/formEditor/formXmlTextEditor.ts` adapts the source-offset scanner and splice approach from BslEdit v2.0.0, `packages/1c-preview-core/browser/form-edit.js`. `src/formEditor/formWebviewHtml.ts` adapts selected Taxi thin-client palette, control metrics, and CSS treatments from `packages/1c-preview-core/browser/viewer.css` and the semantic preview structure in `form-preview.js` ([repository](https://github.com/alonehobo/BslEdit)). The form preview keeps its own markup and contains no BslEdit platform PNGs or other platform artwork. The MIT notice from BslEdit is reproduced below.

```text
MIT License

Copyright (c) 2026 1c-form-viewer contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Managed 1C form validation rules

`src/agent/agentStaticForms.ts` adapts validation rules from the `form-validate` skill in [`cc-1c-skills`](https://github.com/Nikolay-Shirokov/cc-1c-skills), including duplicate identifiers and names, companion elements, data paths, command references, event handlers, and `MainAttribute` checks. The implementation uses this repository's TypeScript and XML parser; the upstream Python and PowerShell scripts are not bundled.

The upstream project is distributed under the MIT License. Its copyright and permission notice are reproduced below.

```text
MIT License

Copyright (c) 2025-2026 Nick Shirokov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
