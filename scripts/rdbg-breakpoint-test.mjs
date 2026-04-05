/**
 * Full RDBG debug cycle:
 * 1. Start dbgs
 * 2. Attach as debug UI + auto-attach settings
 * 3. Wait for 1C client target
 * 4. Set breakpoint on Номенклатура.ФормаЭлемента form module line 1
 * 5. Launch 1C with Vanessa Automation (opens Номенклатура form)
 * 6. Poll for breakpoint hit event
 * 7. On hit: get call stack, local variables
 * 8. Continue execution
 * 9. Detach, stop dbgs
 *
 * All XML fixtures saved to test/fixtures/rdbg/live/
 */

import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const DBGS_PATH = 'C:\\Program Files\\1cv8\\8.3.27.1859\\bin\\dbgs.exe';
const ONEC_PATH = 'C:\\Program Files\\1cv8\\8.3.27.1859\\bin\\1cv8.exe';
const INFOBASE = 'C:\\Users\\Максим\\Documents\\InfoBase11';
const VA_EPF = 'C:\\reps\\1cviewer\\scripts\\va-features\\va.epf';
const VA_PARAMS = 'C:\\reps\\1cviewer\\scripts\\va-features\\VAParams.json';
const PORT = 1550;
const BASE = `http://localhost:${PORT}/e1crdbg/rdbg`;

const NS_BASE = 'http://v8.1c.ru/8.3/debugger/debugBaseData';
const NS_RDBG = 'http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse';
const NS_XSI  = 'http://www.w3.org/2001/XMLSchema-instance';
const REQ_NS  = `xmlns="${NS_BASE}" xmlns:rdbg="${NS_RDBG}" xmlns:xsi="${NS_XSI}"`;

const FIXT_DIR = 'test/fixtures/rdbg/live';
mkdirSync(FIXT_DIR, { recursive: true });

const debugUiId = randomUUID();
let dbgsProc = null;
let running = true;
let step = 0;

// -- Helpers ------------------------------------------------------------------

function wrap(xsiType, fields) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<request ${REQ_NS} xsi:type="${xsiType}">\n${fields}</request>`;
}

async function send(cmd, body) {
  const url = `${BASE}?cmd=${cmd}&dbgui=${debugUiId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'User-Agent': '1CV8' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

function save(name, xml) {
  step++;
  const f = `${FIXT_DIR}/${String(step).padStart(2,'0')}_${name}.xml`;
  writeFileSync(f, xml || '(empty)');
  return f;
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {
  running = false;
  log('Cleaning up...');
  try {
    const body = wrap('rdbg:RDBGDetachDebugUIRequest',
      `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n`);
    await send('detachDebugUI', body);
  } catch {}
  try { execSync('powershell -c "Stop-Process -Name 1cv8 -Force -ErrorAction SilentlyContinue"'); } catch {}
  if (dbgsProc) dbgsProc.kill();
  log('Done.');
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// -- Main ---------------------------------------------------------------------

log('=== 1. Starting dbgs ===');
dbgsProc = spawn(DBGS_PATH, ['--addr=localhost', `--port=${PORT}`], { stdio: 'ignore' });
await sleep(2000);

log(`=== 2. Attaching debug UI (${debugUiId}) ===`);
let r = await send('attachDebugUI', wrap('rdbg:RDBGAttachDebugUIRequest',
  `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n`));
save('attach', r.body);
log(`   attach: HTTP ${r.status}`);
if (r.status !== 200) { log('FAILED'); await cleanup(); }

r = await send('initSettings', wrap('rdbg:RDBGSetInitialDebugSettingsRequest',
  `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n`));
save('initSettings', r.body);

r = await send('setAutoAttachSettings', wrap('rdbg:RDBGSetAutoAttachSettingsRequest',
  `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n`));
save('autoAttach', r.body);
log(`   autoAttach: HTTP ${r.status}`);

log('=== 3. Setting breakpoint on Номенклатура.ФормаЭлемента line 3 ===');
// Form UUID from fixture: need to find it. Using catalog UUID + property suffix for form module.
// Catalog Номенклатура UUID: fc59acc3-f1f7-4e3f-96da-e580f2c5a88f
// Form ФормаЭлемента has its own UUID — let's try with the catalog UUID first
// propertyId "0" = form module suffix
const BP_BODY = wrap('rdbg:RDBGSetBreakpointsRequest',
  `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n` +
  `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n` +
  `  <rdbg:bpWorkspace>\n` +
  `    <rdbg:breakpoint>\n` +
  `      <rdbg:moduleID>\n` +
  `        <rdbg:objectID>fc59acc3-f1f7-4e3f-96da-e580f2c5a88f</rdbg:objectID>\n` +
  `        <rdbg:propertyID>0</rdbg:propertyID>\n` +
  `      </rdbg:moduleID>\n` +
  `      <rdbg:lineNo>3</rdbg:lineNo>\n` +
  `    </rdbg:breakpoint>\n` +
  `  </rdbg:bpWorkspace>\n`);
save('setBreakpoints_request', BP_BODY);
r = await send('setBreakpoints', BP_BODY);
save('setBreakpoints_response', r.body);
log(`   setBreakpoints: HTTP ${r.status} body_len=${r.body.length}`);
if (r.body) log(`   ${r.body.slice(0,200)}`);

log('=== 4. Starting 1C Enterprise with Vanessa ===');
const onecArgs = [
  'ENTERPRISE',
  `/F"${INFOBASE}"`,
  '/Debug', '-http', '-attach',
  '/DebuggerURL', `http://localhost:${PORT}`,
  '/Execute', `"${VA_EPF}"`,
  `/C"StartFeaturePlayer;VAParams=${VA_PARAMS}"`,
];
log(`   ${ONEC_PATH} ${onecArgs.join(' ')}`);

try {
  execSync(`powershell -c "Start-Process '${ONEC_PATH}' -ArgumentList 'ENTERPRISE','/F\\\"${INFOBASE}\\\"','/Debug','-http','-attach','/DebuggerURL','http://localhost:${PORT}','/Execute','\\\"${VA_EPF}\\\"','/C\\\"StartFeaturePlayer;VAParams=${VA_PARAMS}\\\"'"`, { stdio: 'inherit' });
} catch (e) {
  log(`   1C launch error: ${e.message}`);
}

log('=== 5. Polling for events (60s max) ===');
const PING_BODY = wrap('rdbg:RDBGPingDebugUIRequest',
  `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n`);

let eventCount = 0;
for (let i = 0; i < 60 && running; i++) {
  await sleep(1000);
  try {
    r = await send('pingDebugUI', PING_BODY);
    if (r.status === 200 && r.body.trim()) {
      eventCount++;
      const fname = save(`event_${eventCount}`, r.body);

      // Extract event type
      const typeMatch = r.body.match(/xsi:type="([^"]+)"/g);
      const types = typeMatch ? typeMatch.map(m => m.replace(/xsi:type="|"/g, '')) : [];
      log(`   EVENT #${eventCount}: ${types.join(', ')}`);
      log(`   ${r.body.slice(0, 300)}`);

      // Check if it's a breakpoint hit (CallStackFormed)
      if (r.body.includes('CallStackFormed') || r.body.includes('callStackFormed')) {
        log('   >>> BREAKPOINT HIT! Getting call stack...');

        // Get call stack
        // Extract targetID from the event
        const tidMatch = r.body.match(/<id>([^<]+)<\/id>/);
        if (tidMatch) {
          const targetId = tidMatch[1];
          log(`   targetId: ${targetId}`);

          const csBody = wrap('rdbg:RDBGGetCallStackRequest',
            `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n` +
            `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n` +
            `  <rdbg:targetID>\n    <rdbg:id>${targetId}</rdbg:id>\n  </rdbg:targetID>\n`);
          save('getCallStack_request', csBody);
          const cs = await send('getCallStack', csBody);
          save('getCallStack_response', cs.body);
          log(`   callStack: HTTP ${cs.status}`);
          log(`   ${cs.body.slice(0, 400)}`);

          // Try eval local variables
          const evalBody = wrap('rdbg:RDBGEvalLocalVariablesRequest',
            `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n` +
            `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n` +
            `  <rdbg:targetID>\n    <rdbg:id>${targetId}</rdbg:id>\n  </rdbg:targetID>\n` +
            `  <rdbg:callStackLevel>0</rdbg:callStackLevel>\n`);
          save('evalLocalVars_request', evalBody);
          const ev = await send('evalLocalVariables', evalBody);
          save('evalLocalVars_response', ev.body);
          log(`   localVars: HTTP ${ev.status}`);
          log(`   ${ev.body.slice(0, 400)}`);

          // Continue execution
          log('   Continuing execution...');
          const contBody = wrap('rdbg:RDBGStepRequest',
            `  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>\n` +
            `  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>\n` +
            `  <rdbg:targetID>\n    <rdbg:id>${targetId}</rdbg:id>\n  </rdbg:targetID>\n` +
            `  <rdbg:action>Continue</rdbg:action>\n`);
          const cont = await send('step', contBody);
          save('continue_response', cont.body);
          log(`   continue: HTTP ${cont.status}`);
        }
      }
    } else {
      if (i % 10 === 0) process.stdout.write(`[${i}s]`);
      else process.stdout.write('.');
    }
  } catch (err) {
    if (running) log(`   ping error: ${err.message}`);
  }
}

log(`\n=== Done. ${eventCount} events captured. Fixtures in ${FIXT_DIR}/ ===`);
await cleanup();
