'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_PUBLISHER = 'Lekot';

function fail(message) {
  throw new Error(message);
}

function selectReleaseAsset(release, releaseTag, rootManifest) {
  if (!release || release.tag_name !== releaseTag) {
    fail('The release event tag does not match the checked-out tag.');
  }

  const tagVersion = releaseTag.startsWith('v') ? releaseTag.slice(1) : releaseTag;
  if (rootManifest.version !== tagVersion) {
    fail('Release tag ' + releaseTag + ' does not match root package.json version ' + rootManifest.version + '.');
  }
  if (rootManifest.publisher !== EXPECTED_PUBLISHER) {
    fail('Expected package publisher ' + EXPECTED_PUBLISHER + ', got ' + rootManifest.publisher + '.');
  }
  if (!rootManifest.name || !rootManifest.version) {
    fail('Root package.json must declare a package name and version.');
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const vsixAssets = assets.filter(asset => typeof asset.name === 'string' && asset.name.toLowerCase().endsWith('.vsix'));
  if (vsixAssets.length !== 1) {
    const names = vsixAssets.map(asset => asset.name).join(', ') || '(none)';
    fail('Expected exactly one VSIX attached to GitHub release ' + releaseTag + '; found ' + vsixAssets.length + ': ' + names + '. Attach the version-matching VSIX before publishing the GitHub release.');
  }

  const asset = vsixAssets[0];
  const expectedName = rootManifest.name + '-' + rootManifest.version + '.vsix';
  if (asset.name !== expectedName) {
    fail('Expected release asset ' + expectedName + ', found ' + asset.name + '.');
  }
  if (asset.state && asset.state !== 'uploaded') {
    fail('GitHub release asset ' + asset.name + ' is not fully uploaded (state: ' + asset.state + ').');
  }
  if (typeof asset.url !== 'string' || !asset.url.startsWith('https://')) {
    fail('GitHub release asset ' + asset.name + ' has no valid download URL.');
  }

  return asset;
}

function validatePackagedManifest(rootManifest, packagedManifest, releaseTag) {
  const tagVersion = releaseTag.startsWith('v') ? releaseTag.slice(1) : releaseTag;
  if (packagedManifest.name !== rootManifest.name) {
    fail('VSIX extension/package.json name does not match the checked-out package.json.');
  }
  if (packagedManifest.publisher !== EXPECTED_PUBLISHER || packagedManifest.publisher !== rootManifest.publisher) {
    fail('VSIX extension/package.json publisher does not match ' + EXPECTED_PUBLISHER + '.');
  }
  if (packagedManifest.version !== tagVersion || packagedManifest.version !== rootManifest.version) {
    fail('VSIX extension/package.json version does not match release tag ' + releaseTag + ' and root package.json version ' + rootManifest.version + '.');
  }
}

async function resolveRelease(event, releaseTag, repository, token, request = fetch) {
  if (event.release) {
    return event.release;
  }
  if (!repository || !token) {
    fail('GITHUB_REPOSITORY and GITHUB_TOKEN are required to resolve a manually selected release.');
  }

  const repositoryParts = repository.split('/');
  if (repositoryParts.length !== 2 || repositoryParts.some(part => !part)) {
    fail('GITHUB_REPOSITORY must have the owner/repository format.');
  }

  const apiUrl = 'https://api.github.com/repos/' + repository + '/releases/tags/' + encodeURIComponent(releaseTag);
  const response = await request(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1000);
    fail('GitHub release lookup failed with HTTP ' + response.status + (details ? ': ' + details : '.'));
  }

  return response.json();
}

function readPackagedManifest(vsixPath) {
  const result = spawnSync('unzip', ['-p', vsixPath, 'extension/package.json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) {
    fail('Could not inspect VSIX: ' + result.error.message + '. The release workflow requires unzip.');
  }
  if (result.status !== 0) {
    fail('Could not read extension/package.json from the downloaded VSIX: ' + (result.stderr || 'unzip exited with status ' + result.status).trim());
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail('VSIX extension/package.json is not valid JSON: ' + error.message);
  }
}

async function downloadReleaseAsset(asset, token, outputPath) {
  const response = await fetch(asset.url, {
    headers: {
      Accept: 'application/octet-stream',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1000);
    fail('GitHub asset download failed with HTTP ' + response.status + (details ? ': ' + details : '.'));
  }

  const contents = Buffer.from(await response.arrayBuffer());
  if (asset.size && contents.length !== asset.size) {
    fail('Downloaded VSIX size does not match the GitHub release asset metadata.');
  }
  if (contents.length < 4 || contents[0] !== 0x50 || contents[1] !== 0x4b) {
    fail('The downloaded release asset is not a ZIP/VSIX file.');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, contents);
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const releaseTag = process.env.RELEASE_TAG;
  const token = process.env.GITHUB_TOKEN;
  const outputPath = process.env.VSIX_PATH;
  if (!eventPath || !releaseTag || !token || !outputPath) {
    fail('GITHUB_EVENT_PATH, RELEASE_TAG, GITHUB_TOKEN, and VSIX_PATH are required.');
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const rootManifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const release = await resolveRelease(event, releaseTag, process.env.GITHUB_REPOSITORY, token);
  const asset = selectReleaseAsset(release, releaseTag, rootManifest);

  await downloadReleaseAsset(asset, token, outputPath);
  const packagedManifest = readPackagedManifest(outputPath);
  validatePackagedManifest(rootManifest, packagedManifest, releaseTag);

  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    fail('GITHUB_OUTPUT is required to pass the validated VSIX path to the publish step.');
  }
  fs.appendFileSync(outputFile, 'vsix_path=' + outputPath + String.fromCharCode(10));
  console.log('Validated ' + asset.name + ' for release ' + releaseTag + '.');
}

if (require.main === module) {
  main().catch(error => {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  resolveRelease,
  selectReleaseAsset,
  validatePackagedManifest
};
