/**
 * Live RDBG debug cycle test.
 *
 * 1. Starts dbgs on port 1550
 * 2. Attaches as debug UI
 * 3. Polls for targets (waits for 1C client to connect)
 * 4. Attaches to first target
 * 5. Polls for events (breakpoint hits, etc.)
 * 6. On Ctrl+C — detaches and stops dbgs
 *
 * Usage:
 *   node scripts/rdbg-live-test.mjs
 *
 * Then start 1C client with debug:
 *   "C:\Program Files\1cv8\8.3.27.1859\bin\1cv8.exe" ENTERPRISE /F"C:\Users\Максим\Documents\InfoBase11" /Debug -http -attach /DebuggerURL http://localhost:1550
 */

import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

const DBGS_PATH = 'C:\\Program Files\\1cv8\\8.3.27.1859\\bin\\dbgs.exe';
const PORT = 1550;
const BASE = `http://localhost:${PORT}/e1crdbg/rdbg`;
const NS_BASE = 'http://v8.1c.ru/8.3/debugger/debugBaseData';
const NS_RDBG = 'http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse';
const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const REQ_NS = `xmlns="${NS_BASE}" xmlns:rdbg="${NS_RDBG}" xmlns:xsi="${NS_XSI}"`;

const debugUiId = randomUUID();
let dbgsProc = null;
let running = true;

function wrap(xsiType, fields) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<request ${REQ_NS} xsi:type="${xsiType}">\n${fields}</request>`;
}

async function send(cmd, body) {
  const url = `${BASE}?cmd=${cmd}&dbgui=${debugUiId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'User-Agent': '1CV8' },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// Start dbgs
log('Starting dbgs...');
dbgsProc = spawn(DBGS_PATH, ['--addr=localhost', `--port=${PORT}`], { stdio: 'ignore' });
dbgsProc.on('exit', (code) => { if (running) log(`dbgs exited (code ${code})`); });

await new Promise(r => setTimeout(r, 2000));

// Attach
log(`Attaching as ${debugUiId}...`);
const attachBody = wrap('rdbg:RDBGAttachDebugUIRequest',
  `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n`);
const attach = await send('attachDebugUI', attachBody);
log(`attach: HTTP ${attach.status} — ${attach.body.slice(0, 100)}`);

if (attach.status !== 200) {
  log('FAILED to attach. Exiting.');
  dbgsProc.kill();
  process.exit(1);
}

// Init settings
const initBody = wrap('rdbg:RDBGSetInitialDebugSettingsRequest',
  `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n`);
await send('initSettings', initBody);
log('initSettings done');

log('');
log('=== Waiting for 1C client to connect ===');
log(`Start 1C with: "${DBGS_PATH.replace('dbgs.exe', '1cv8.exe')}" ENTERPRISE /F"C:\\Users\\Максим\\Documents\\InfoBase11" /Debug -http -attach /DebuggerURL http://localhost:${PORT}`);
log('');

// Poll for targets
let targets = [];
while (running && targets.length === 0) {
  const tgtBody = wrap('rdbg:RDBGGetDbgTargetsRequest',
    `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n`);
  const tgt = await send('getDbgTargets', tgtBody);

  // Simple parse — look for <id> elements in response
  const idMatches = tgt.body.matchAll(/<id[^>]*>([^<]+)<\/id>/g);
  for (const m of idMatches) {
    targets.push(m[1]);
  }

  if (targets.length === 0) {
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (targets.length > 0) {
  log(`\nFound ${targets.length} target(s): ${targets.join(', ')}`);

  // Attach to targets
  let targetFields = `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n`;
  targetFields += `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n`;
  targetFields += `  <rdbg:attach>true</rdbg:attach>\n`;
  for (const id of targets) {
    targetFields += `  <rdbg:id>\n    <rdbg:id>${id}</rdbg:id>\n  </rdbg:id>\n`;
  }
  const attachTgt = await send('attachDebugUI', wrap('rdbg:RDBGAttachDetachDebugTargetsRequest', targetFields));
  log(`attachTargets: HTTP ${attachTgt.status}`);
}

// Event polling loop
log('\n=== Polling for events (Ctrl+C to stop) ===\n');
const pingBody = wrap('rdbg:RDBGPingDebugUIRequest',
  `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n`);

while (running) {
  try {
    const ping = await send('pingDebugUI', pingBody);
    if (ping.status === 200 && ping.body.trim()) {
      log(`EVENT: ${ping.body.slice(0, 300)}`);

      // Save to fixture
      const fs = await import('fs');
      const ts = Date.now();
      fs.writeFileSync(`test/fixtures/rdbg/event_${ts}.xml`, ping.body);
    }
  } catch (err) {
    if (running) log(`ping error: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 1000));
}

// Cleanup
async function cleanup() {
  running = false;
  log('\nDetaching...');
  try {
    const detachBody = wrap('rdbg:RDBGDetachDebugUIRequest',
      `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n`);
    await send('detachDebugUI', detachBody);
    log('Detached');
  } catch { /* ignore */ }
  if (dbgsProc) {
    dbgsProc.kill();
    log('dbgs killed');
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
