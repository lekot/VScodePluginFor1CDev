'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveRelease, selectReleaseAsset, validatePackagedManifest } = require('./prepare-marketplace-release.cjs');

const rootManifest = {
  name: '1c-metadata-tree-vscode',
  publisher: 'Lekot',
  version: '0.54.0'
};

function makeRelease(assets) {
  return {
    tag_name: 'v0.54.0',
    assets
  };
}

function makeAsset(name) {
  return {
    name,
    state: 'uploaded',
    url: 'https://api.github.com/repos/lekot/VScodePluginFor1CDev/releases/assets/123',
    size: 123
  };
}

test('resolves a manually selected published release through the GitHub API', async () => {
  const expectedRelease = makeRelease([makeAsset('1c-metadata-tree-vscode-0.54.0.vsix')]);
  let requestedUrl;
  let requestedHeaders;
  const resolved = await resolveRelease({}, 'v0.54.0', 'lekot/VScodePluginFor1CDev', 'test-token', async (url, options) => {
    requestedUrl = url;
    requestedHeaders = options.headers;
    return {
      ok: true,
      json: async () => expectedRelease
    };
  });

  assert.equal(requestedUrl, 'https://api.github.com/repos/lekot/VScodePluginFor1CDev/releases/tags/v0.54.0');
  assert.equal(requestedHeaders.Authorization, 'Bearer test-token');
  assert.equal(resolved, expectedRelease);
});

test('uses release event payload without making a second GitHub API request', async () => {
  const eventRelease = makeRelease([]);
  let requestCount = 0;

  const resolved = await resolveRelease({ release: eventRelease }, 'v0.54.0', undefined, undefined, async () => {
    requestCount++;
  });

  assert.equal(resolved, eventRelease);
  assert.equal(requestCount, 0);
});

test('selects the sole VSIX whose name matches the checked-out package version', () => {
  const expected = makeAsset('1c-metadata-tree-vscode-0.54.0.vsix');
  const selected = selectReleaseAsset(makeRelease([
    { name: 'checksums.txt' },
    expected
  ]), 'v0.54.0', rootManifest);

  assert.equal(selected, expected);
});

test('rejects a release tag that does not match root package.json', () => {
  assert.throws(
    () => selectReleaseAsset({ ...makeRelease([makeAsset('1c-metadata-tree-vscode-0.54.0.vsix')]), tag_name: 'v0.54.1' }, 'v0.54.1', rootManifest),
    /does not match root package.json version/
  );
});

test('rejects ambiguous or mismatched VSIX release assets', () => {
  assert.throws(
    () => selectReleaseAsset(makeRelease([
      makeAsset('1c-metadata-tree-vscode-0.54.0.vsix'),
      makeAsset('another-package-0.54.0.vsix')
    ]), 'v0.54.0', rootManifest),
    /exactly one VSIX/
  );
  assert.throws(
    () => selectReleaseAsset(makeRelease([makeAsset('1c-metadata-tree-vscode-0.53.9.vsix')]), 'v0.54.0', rootManifest),
    /Expected release asset/
  );
});

test('checks the package manifest inside the exact release VSIX', () => {
  validatePackagedManifest(rootManifest, {
    name: '1c-metadata-tree-vscode',
    publisher: 'Lekot',
    version: '0.54.0'
  }, 'v0.54.0');

  assert.throws(
    () => validatePackagedManifest(rootManifest, {
      name: '1c-metadata-tree-vscode',
      publisher: 'Lekot',
      version: '0.53.9'
    }, 'v0.54.0'),
    /version does not match/
  );
});
