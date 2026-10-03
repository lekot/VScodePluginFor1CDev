# Marketplace release publication

The Publish VS Code Marketplace workflow runs when a GitHub Release is published. It checks out that release tag, downloads the one VSIX attached to the release whose name matches the root package version, and verifies extension/package.json inside the VSIX. It publishes that same file with @vscode/vsce 4.0.1-1; it does not build a new package. This pinned build includes the Marketplace OIDC exchange API version and the `FederatedToken` authorization scheme required by the exchange endpoint.

To republish an existing release asset, run the workflow manually from `main` and enter its published release tag in `release_tag`. The workflow looks up the GitHub Release by that tag and applies the same VSIX validation before publishing. The selected tag version must match the root `package.json` version on `main`.

## One-time setup

The workflow attempts OIDC trusted publishing first. The Marketplace currently replies `Trusted Publishing is not supported.` for this publisher; when it returns that specific response, the workflow retries with the optional GitHub Actions secret `VSCE_PAT`. Other OIDC failures do not trigger the PAT path.

If trusted publishing is enabled for the Lekot publisher, configure a policy for the GitHub repository `lekot/VScodePluginFor1CDev` and workflow file `.github/workflows/publish-marketplace.yml`. The workflow grants `id-token: write` and `contents: read`. See the official [vsce trusted publishing instructions](https://github.com/microsoft/vscode-vsce#trusted-publishing).

### Optional PAT fallback

Create a Personal Access Token in the [Azure DevOps portal](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token) using the Microsoft account that can publish as Lekot:

1. Open **User settings → Personal access tokens → New Token**.
2. Set **Organization** to **All accessible organizations**.
3. Under **Scopes**, choose **Custom defined**, show all scopes, and select **Marketplace → Manage**.
4. Create the token and copy it to a secure location.
5. In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**. Name it `VSCE_PAT` and paste the token as its value.

The workflow reads the secret through the `VSCE_PAT` environment variable, removes it from the OIDC attempt, and redacts it from captured command output. Never add the token to source files or workflow logs. If the Marketplace rejects the token, verify it is active, has the `Marketplace (Manage)` scope, uses **All accessible organizations**, and belongs to an account authorized for the Lekot publisher.

Microsoft has announced that Azure DevOps global PATs will be retired on December 1, 2026 and recommends Entra ID based publishing. Treat this PAT route as a temporary fallback and prefer enabling OIDC or another supported Entra ID flow. See the [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Publishing a release

Create a GitHub draft release, attach exactly one VSIX named “<package-name>-<package-version>.vsix”, and publish the draft. The tag must equal the checked-out root package.json version, optionally prefixed with v; the VSIX's extension/package.json must carry the same name, publisher, and version. Missing, ambiguous, or mismatched assets fail the workflow before Marketplace publication.

The publish command uses --skip-duplicate, so rerunning a successful release job does not fail because that version is already present.
