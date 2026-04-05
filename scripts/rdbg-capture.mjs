/**
 * RDBG Capture Script
 * Делает серию HTTP-запросов к серверу отладки 1C (RDBG) и сохраняет
 * все request/response пары как XML-файлы в test/fixtures/rdbg/
 *
 * Запуск: node scripts/rdbg-capture.mjs
 */

import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURES_DIR = join(ROOT, 'test', 'fixtures', 'rdbg');

const RDBG_BASE = 'http://localhost:1550';
const RDBG_ENDPOINT = `${RDBG_BASE}/e1crdbg/rdbg`;
const NS = 'http://v8.1c.ru/8.3/debugger/debugBaseData';
const TIMEOUT_MS = 5000;

const debugUiId = randomUUID();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(debugUiId, extraBody = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<request xmlns="${NS}"
         xmlns:xs="http://www.w3.org/2001/XMLSchema"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <idOfDebuggerUI>${debugUiId}</idOfDebuggerUI>${extraBody ? '\n  ' + extraBody : ''}
</request>`;
}

function buildSimpleRequest(debugUiId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<request xmlns="${NS}">
  <idOfDebuggerUI>${debugUiId}</idOfDebuggerUI>
</request>`;
}

async function rdbgPost(cmd, body, dbgui) {
  const url = new URL(RDBG_ENDPOINT);
  url.searchParams.set('cmd', cmd);
  if (dbgui !== undefined) {
    url.searchParams.set('dbgui', dbgui);
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  return { status: response.status, statusText: response.statusText, body: text, url: url.toString() };
}

async function rdbgGet(path) {
  const url = `${RDBG_BASE}${path}`;
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, statusText: response.statusText, body: text, url };
}

async function saveFixture(step, name, requestXml, result) {
  const prefix = String(step).padStart(2, '0');
  const base = `${prefix}_${name}`;

  const requestFile = join(FIXTURES_DIR, `${base}_request.xml`);
  const responseFile = join(FIXTURES_DIR, `${base}_response.xml`);
  const metaFile = join(FIXTURES_DIR, `${base}_meta.json`);

  await writeFile(requestFile, requestXml ?? '', 'utf-8');
  await writeFile(responseFile, result.body ?? '', 'utf-8');
  await writeFile(metaFile, JSON.stringify({
    url: result.url,
    status: result.status,
    statusText: result.statusText,
    capturedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

function printResult(name, result) {
  const preview = (result.body ?? '').slice(0, 200).replace(/\n/g, ' ');
  console.log(`  [${result.status} ${result.statusText}] ${name}`);
  console.log(`  URL: ${result.url}`);
  console.log(`  Body: ${preview || '(empty)'}`);
  console.log();
}

async function capture(step, name, requestXml, fetchFn) {
  console.log(`→ Step ${step}: ${name}`);
  try {
    const result = await fetchFn();
    await saveFixture(step, name, requestXml, result);
    printResult(name, result);
    return result;
  } catch (err) {
    const errResult = {
      url: '(error)',
      status: 0,
      statusText: err.message,
      body: `ERROR: ${err.message}\n${err.stack ?? ''}`,
    };
    await saveFixture(step, name, requestXml ?? '', errResult);
    console.log(`  [ERROR] ${name}: ${err.message}`);
    console.log();
    return errResult;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('RDBG Capture Script');
console.log('===================');
console.log(`debugUiId: ${debugUiId}`);
console.log(`Fixtures dir: ${FIXTURES_DIR}`);
console.log();

await mkdir(FIXTURES_DIR, { recursive: true });

let step = 1;

// --- Step 1: GET /e1crdbg/ ---
await capture(step++, 'GET_root', null, () => rdbgGet('/e1crdbg/'));

// --- Step 2: POST без тела ---
{
  const emptyBody = '';
  await capture(step++, 'POST_empty_body', emptyBody, () =>
    rdbgPost('attachDebugUI', emptyBody, debugUiId)
  );
}

// ---------------------------------------------------------------------------
// Основная серия
// ---------------------------------------------------------------------------

// --- Step 3: attachDebugUI ---
{
  const xml = buildRequest(debugUiId);
  await capture(step++, 'attachDebugUI', xml, () =>
    rdbgPost('attachDebugUI', xml, debugUiId)
  );
}

// --- Step 4: getDbgTargets ---
{
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, 'getDbgTargets', xml, () =>
    rdbgPost('getDbgTargets', xml, debugUiId)
  );
}

// --- Step 5: pingDebugUIRequest ---
{
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, 'pingDebugUIRequest', xml, () =>
    rdbgPost('pingDebugUIRequest', xml, debugUiId)
  );
}

// --- Step 6: getAPIVersion ---
{
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, 'getAPIVersion', xml, () =>
    rdbgPost('getAPIVersion', xml, debugUiId)
  );
}

// --- Step 7: miscRDbgGetAPIVer ---
{
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, 'miscRDbgGetAPIVer', xml, () =>
    rdbgPost('miscRDbgGetAPIVer', xml, debugUiId)
  );
}

// --- Step 8: initSettings ---
{
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, 'initSettings', xml, () =>
    rdbgPost('initSettings', xml, debugUiId)
  );
}

// ---------------------------------------------------------------------------
// Варианты имён команд
// ---------------------------------------------------------------------------

console.log('--- Варианты имён команд ---');
console.log();

const attachVariants = ['attachDebugUI', 'attachDebugUIRequest', 'RDBGAttachDebugUI'];
for (const cmd of attachVariants) {
  const xml = buildRequest(debugUiId);
  await capture(step++, `variant_${cmd}`, xml, () =>
    rdbgPost(cmd, xml, debugUiId)
  );
}

const targetVariants = ['getDbgTargets', 'getDbgTargetsRequest', 'RDBGSGetDbgTargets', 'RDBGGetDbgTargets'];
for (const cmd of targetVariants) {
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, `variant_${cmd}`, xml, () =>
    rdbgPost(cmd, xml, debugUiId)
  );
}

const pingVariants = ['pingDebugUI', 'pingDebugUIRequest', 'RDBGPingDebugUI'];
for (const cmd of pingVariants) {
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, `variant_${cmd}`, xml, () =>
    rdbgPost(cmd, xml, debugUiId)
  );
}

const versionVariants = ['getAPIVersion', 'miscRDbgGetAPIVer', 'MiscRDbgGetAPIVer'];
for (const cmd of versionVariants) {
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, `variant_${cmd}`, xml, () =>
    rdbgPost(cmd, xml, debugUiId)
  );
}

// ---------------------------------------------------------------------------
// detachDebugUI — всегда последним
// ---------------------------------------------------------------------------

console.log('--- Завершение сессии ---');
console.log();

{
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, 'detachDebugUI', xml, () =>
    rdbgPost('detachDebugUI', xml, debugUiId)
  );
}

// Альтернативное имя detach
{
  const xml = buildSimpleRequest(debugUiId);
  await capture(step++, 'variant_detachDebugUIRequest', xml, () =>
    rdbgPost('detachDebugUIRequest', xml, debugUiId)
  );
}

console.log('===================');
console.log(`Готово. Фикстуры сохранены в: ${FIXTURES_DIR}`);
console.log(`Всего шагов: ${step - 1}`);
