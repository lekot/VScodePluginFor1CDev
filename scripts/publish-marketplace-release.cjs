'use strict';

const { spawnSync } = require('node:child_process');

const VSCE_VERSION = '4.0.1-1';
const TRUSTED_PUBLISHING_UNSUPPORTED = /Trusted Publishing is not supported\.?/i;

function runVscePublish(args, environment) {
  const result = spawnSync('npm', [
    'exec',
    '--yes',
    '--package=@vscode/vsce@' + VSCE_VERSION,
    '--',
    'vsce',
    'publish',
    ...args
  ], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    status: result.status === null ? 1 : result.status,
    output: [result.stdout, result.stderr, result.error && result.error.message].filter(Boolean).join('')
  };
}

function writeSanitizedOutput(output, secret, write) {
  let safeOutput = String(output || '');
  if (secret) {
    safeOutput = safeOutput.split(secret).join('[redacted]');
  }
  if (safeOutput) {
    write(safeOutput.endsWith('\n') ? safeOutput : safeOutput + '\n');
  }
}

function publishRelease(vsixPath, options = {}) {
  if (!vsixPath) {
    throw new Error('VSIX_PATH is required to publish the validated release artifact.');
  }

  const baseEnvironment = options.environment || process.env;
  const pat = options.pat === undefined ? process.env.VSCE_PAT : options.pat;
  const run = options.run || runVscePublish;
  const write = options.write || (message => process.stdout.write(message));

  const oidcEnvironment = { ...baseEnvironment };
  delete oidcEnvironment.VSCE_PAT;
  const oidcResult = run([
    '--oidc',
    '--packagePath',
    vsixPath,
    '--skip-duplicate'
  ], oidcEnvironment);
  writeSanitizedOutput(oidcResult.output, pat, write);

  if (oidcResult.status === 0) {
    return 'oidc';
  }

  if (!TRUSTED_PUBLISHING_UNSUPPORTED.test(oidcResult.output)) {
    throw new Error('Marketplace OIDC publication failed (exit code ' + oidcResult.status + '). The PAT fallback is used only when Marketplace reports that trusted publishing is not supported. Review the preceding error and trusted-publishing setup in .github/marketplace-publishing.md.');
  }

  if (!pat) {
    throw new Error('Marketplace replied "Trusted Publishing is not supported." No VSCE_PAT secret is configured. Create a Marketplace PAT and add it as the repository Actions secret VSCE_PAT, or resolve trusted-publishing support; see .github/marketplace-publishing.md.');
  }

  write('::notice::Marketplace reports that trusted publishing is not supported; retrying with the configured VSCE_PAT secret.\n');
  const patEnvironment = { ...baseEnvironment, VSCE_PAT: pat };
  const patResult = run([
    '--packagePath',
    vsixPath,
    '--skip-duplicate'
  ], patEnvironment);
  writeSanitizedOutput(patResult.output, pat, write);

  if (patResult.status !== 0) {
    throw new Error('VSCE_PAT publication failed (exit code ' + patResult.status + '). Check that the token is active, has Marketplace (Manage) scope, and is authorized for the Lekot publisher. See .github/marketplace-publishing.md.');
  }

  return 'pat';
}

if (require.main === module) {
  try {
    const method = publishRelease(process.env.VSIX_PATH);
    console.log('Marketplace publication succeeded using ' + method + ' authentication.');
  } catch (error) {
    console.error('::error::' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  publishRelease,
  runVscePublish
};
