# Marketplace release publication

The Publish VS Code Marketplace workflow runs only when a GitHub Release is published. It checks out that release tag, downloads the one VSIX attached to the release whose name matches the root package version, and verifies extension/package.json inside the VSIX. It publishes that same file with @vscode/vsce 4.0.0; it does not build a new package.

## One-time setup

In the Visual Studio Marketplace publisher account Lekot, configure a trusted-publishing policy for the GitHub repository lekot/VScodePluginFor1CDev and workflow file .github/workflows/publish-marketplace.yml. The workflow grants id-token: write and contents: read; no Marketplace PAT or additional GitHub secret is needed.

See the official [vsce trusted publishing instructions](https://github.com/microsoft/vscode-vsce#trusted-publishing) for policy setup.

## Publishing a release

Create a GitHub draft release, attach exactly one VSIX named “<package-name>-<package-version>.vsix”, and publish the draft. The tag must equal the checked-out root package.json version, optionally prefixed with v; the VSIX's extension/package.json must carry the same name, publisher, and version. Missing, ambiguous, or mismatched assets fail the workflow before Marketplace publication.

The publish command uses --skip-duplicate, so rerunning a successful release job does not fail because that version is already present.
