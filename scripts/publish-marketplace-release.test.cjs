'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { publishRelease } = require('./publish-marketplace-release.cjs');

const VSIX_PATH = 'release.vsix';
const PAT = 'marketplace-pat-secret-value';
const UNSUPPORTED = {
  status: 1,
  output: 'Marketplace OIDC token exchange failed with 400 Bad Request: Trusted Publishing is not supported.'
};

function makeRunner(results) {
  const calls = [];
  return {
    calls,
    run(args, environment) {
      calls.push({ args, environment });
      return results.shift();
    }
  };
}

test('uses OIDC without exposing the configured PAT to the OIDC process', () => {
  const runner = makeRunner([{ status: 0, output: 'Published.' }]);
  const logs = [];

  const method = publishRelease(VSIX_PATH, {
    environment: { VSCE_PAT: PAT, PATH: 'path' },
    pat: PAT,
    run: runner.run,
    write: message => logs.push(message)
  });

  assert.equal(method, 'oidc');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].environment.VSCE_PAT, undefined);
  assert.ok(runner.calls[0].args.includes('--oidc'));
  assert.equal(logs.join('').includes(PAT), false);
});

test('retries with VSCE_PAT only when Marketplace says trusted publishing is unsupported', () => {
  const runner = makeRunner([UNSUPPORTED, { status: 0, output: 'Published with PAT.' }]);
  const logs = [];

  const method = publishRelease(VSIX_PATH, {
    environment: { VSCE_PAT: PAT, PATH: 'path' },
    pat: PAT,
    run: runner.run,
    write: message => logs.push(message)
  });

  assert.equal(method, 'pat');
  assert.equal(runner.calls.length, 2);
  assert.ok(runner.calls[0].args.includes('--oidc'));
  assert.equal(runner.calls[0].environment.VSCE_PAT, undefined);
  assert.equal(runner.calls[1].args.includes('--oidc'), false);
  assert.equal(runner.calls[1].environment.VSCE_PAT, PAT);
  assert.equal(logs.join('').includes(PAT), false);
});

test('reports how to configure a PAT when trusted publishing is unsupported and no PAT exists', () => {
  const runner = makeRunner([UNSUPPORTED]);

  assert.throws(
    () => publishRelease(VSIX_PATH, { pat: '', run: runner.run, write: () => {} }),
    /No VSCE_PAT secret is configured.*Marketplace PAT.*Actions secret VSCE_PAT/
  );
  assert.equal(runner.calls.length, 1);
});

test('does not use PAT fallback for other OIDC failures', () => {
  const runner = makeRunner([{ status: 1, output: 'OIDC trust policy mismatch.' }]);

  assert.throws(
    () => publishRelease(VSIX_PATH, { pat: PAT, run: runner.run, write: () => {} }),
    /PAT fallback is used only when Marketplace reports that trusted publishing is not supported/
  );
  assert.equal(runner.calls.length, 1);
});

test('reports PAT publish failures without including the credential', () => {
  const runner = makeRunner([UNSUPPORTED, { status: 1, output: '401 unauthorized ' + PAT }]);
  const logs = [];

  assert.throws(
    () => publishRelease(VSIX_PATH, {
      pat: PAT,
      run: runner.run,
      write: message => logs.push(message)
    }),
    /VSCE_PAT publication failed.*Marketplace \(Manage\) scope/
  );
  assert.equal(logs.join('').includes(PAT), false);
});
