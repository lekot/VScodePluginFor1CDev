/**
 * Standalone probe для диагностики XML-формата evalLocalVariables.
 * Запуск: npx tsx test/debug-probe/evalLocalVarsProbe.ts "C:\path\to\infobase"
 *
 * Тестирует 5 вариантов XML-тела evalLocalVariables, перезапуская dbgs
 * между каждым вариантом (некоторые варианты убивают процесс dbgs).
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Параметры (hardcoded для тестовой конфигурации)
// ---------------------------------------------------------------------------

const HOST = 'localhost';
const PORT = 1550;
const BASE_URL = `http://${HOST}:${PORT}`;
const OBJECT_ID = 'c39f6b2f-c005-4039-9d58-fe4565807e54';
const PROPERTY_ID = 'a637f77f-3840-441d-a1c3-699c8c5cb7e0';
const BREAKPOINT_LINE = 2;

// Путь к файловой инфобазе — первый аргумент CLI или env PROBE_IB_PATH
const IB_PATH = process.argv[2] || process.env.PROBE_IB_PATH || '';

// ---------------------------------------------------------------------------
// Авто-обнаружение платформы 1С
// ---------------------------------------------------------------------------

function findPlatform(): { dbgs: string; client: string } | null {
    const base = 'C:\\Program Files\\1cv8';
    if (!fs.existsSync(base)) return null;
    const versions = fs.readdirSync(base)
        .filter(d => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .reverse();
    for (const ver of versions) {
        const bin = path.join(base, ver, 'bin');
        const dbgs = path.join(bin, 'dbgs.exe');
        const client = path.join(bin, '1cv8c.exe');
        if (fs.existsSync(dbgs) && fs.existsSync(client)) {
            return { dbgs, client };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Запуск и ожидание dbgs
// ---------------------------------------------------------------------------

async function waitForDbgs(port: number, timeoutMs: number): Promise<boolean> {
    const url = `http://localhost:${port}/e1crdbg/rdbg`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fetch(url, { signal: AbortSignal.timeout(500) });
            return true;
        } catch {
            // not ready
        }
        await sleep(500);
    }
    return false;
}

function startDbgs(dbgsPath: string, port: number): ChildProcess {
    console.log(`[launch] Запуск dbgs: ${dbgsPath} --port=${port}`);
    const proc = spawn(dbgsPath, [`--port=${port}`], {
        detached: false,
        stdio: 'pipe',
        windowsHide: true,
    });
    proc.on('error', (err) => console.log(`[dbgs] error: ${err.message}`));
    proc.on('exit', (code) => console.log(`[dbgs] exit code=${code}`));
    return proc;
}

function startClient(clientPath: string, ibPath: string, port: number): ChildProcess {
    const args = [
        'ENTERPRISE',
        '/F', ibPath,
        '/Debug', '-http', '-attach',
        '/DebuggerURL', `http://localhost:${port}`,
    ];
    console.log(`[launch] Запуск 1С: ${clientPath} ${args.join(' ')}`);
    const proc = spawn(clientPath, args, {
        detached: false,
        stdio: 'ignore',
        windowsHide: false,
    });
    proc.on('error', (err) => console.log(`[1cv8c] error: ${err.message}`));
    proc.on('exit', (code) => console.log(`[1cv8c] exit code=${code}`));
    return proc;
}

// ---------------------------------------------------------------------------
// Namespace-строка (для всех запросов)
// ---------------------------------------------------------------------------

const NS =
    'xmlns="http://v8.1c.ru/8.3/debugger/debugBaseData" ' +
    'xmlns:rdbg="http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse" ' +
    'xmlns:bp="http://v8.1c.ru/8.3/debugger/debugBreakpoints" ' +
    'xmlns:calc="http://v8.1c.ru/8.3/debugger/debugCalculations" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

// ---------------------------------------------------------------------------
// UUID-генератор (без внешних зависимостей)
// ---------------------------------------------------------------------------

function generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

// ---------------------------------------------------------------------------
// Debug UI ID (генерируется один раз при запуске)
// ---------------------------------------------------------------------------

const debugUiId = generateUuid();

// ---------------------------------------------------------------------------
// Ядро: sendRdbg
// ---------------------------------------------------------------------------

async function sendRdbg(cmd: string, body: string, quiet = false): Promise<string> {
    const url = `${BASE_URL}/e1crdbg/rdbg?cmd=${cmd}&dbgui=${debugUiId}`;

    if (!quiet) {
        console.log(`\n──────────────────────────────────────────────`);
        console.log(`→ [${cmd}] REQUEST:`);
        console.log(body);
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'User-Agent': '1CV8',
        },
        body,
    });

    const text = await response.text();

    if (!quiet) {
        console.log(`← [${cmd}] RESPONSE (HTTP ${response.status}):`);
        console.log(text || '(пустой ответ)');
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    return text;
}

// ---------------------------------------------------------------------------
// attachDebugUI
// ---------------------------------------------------------------------------

async function attachDebugUI(): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGAttachDebugUIRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
</request>`;

    await sendRdbg('attachDebugUI', body);
}

// ---------------------------------------------------------------------------
// detachDebugUI
// ---------------------------------------------------------------------------

async function detachDebugUI(): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGDetachDebugUIRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
</request>`;

    await sendRdbg('detachDebugUI', body);
}

// ---------------------------------------------------------------------------
// setBreakpoints
// ---------------------------------------------------------------------------

async function setBreakpoints(line: number): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGSetBreakpointsRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:bpWorkspace xsi:type="bp:BPWorkspaceInternal">
    <bp:moduleBPInfo>
      <bp:id xsi:type="BSLModuleIdInternal">
        <objectID>${OBJECT_ID}</objectID>
        <propertyID>${PROPERTY_ID}</propertyID>
      </bp:id>
      <bp:bpInfo>
        <bp:line>${line}</bp:line>
      </bp:bpInfo>
    </bp:moduleBPInfo>
  </rdbg:bpWorkspace>
</request>`;

    await sendRdbg('setBreakpoints', body);
}

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

async function ping(): Promise<string> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGPingDebugUIRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
</request>`;

    return sendRdbg('pingDebugUI', body, true);
}

// ---------------------------------------------------------------------------
// attachTargets
// ---------------------------------------------------------------------------

async function attachTargets(targetId: string): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGAttachDetachDebugTargetsRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:attach>true</rdbg:attach>
  <rdbg:id>
    <id>${targetId}</id>
  </rdbg:id>
</request>`;

    await sendRdbg('attachDetachDbgTargets', body);
}

// ---------------------------------------------------------------------------
// Парсинг ping-ответов (regex)
// ---------------------------------------------------------------------------

function extractTargetStartedId(xml: string): string | null {
    // Ищем id внутри DBGUIExtCmdInfoStarted
    const startedMatch = xml.match(/DBGUIExtCmdInfoStarted[\s\S]*?<id>([^<]+)<\/id>/);
    if (startedMatch) {
        return startedMatch[1].trim();
    }
    return null;
}

function extractCallStackFormedId(xml: string): string | null {
    // Ищем CallStackFormed в xsi:type (остановка на брейкпоинте)
    if (!xml.includes('CallStackFormed')) {
        return null;
    }
    // Ищем targetID/id в том же блоке
    const idMatch = xml.match(/<id>([^<]+)<\/id>/);
    if (idMatch) {
        return idMatch[1].trim();
    }
    return null;
}

// ---------------------------------------------------------------------------
// Описание ошибки с цепочкой cause
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
    const parts: string[] = [];
    let cur: unknown = err;
    let depth = 0;
    while (cur !== undefined && depth < 5) {
        if (cur instanceof Error) {
            parts.push(cur.message);
            const ne = cur as Error & { code?: string; errno?: number; cause?: unknown };
            if (ne.code) parts.push(`code=${ne.code}`);
            if (ne.errno !== undefined) parts.push(`errno=${ne.errno}`);
            cur = ne.cause;
        } else {
            parts.push(String(cur));
            break;
        }
        depth++;
    }
    return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Задержка
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// tryVariant — запускает полный цикл для одного варианта XML
// ---------------------------------------------------------------------------

async function tryVariant(
    name: string,
    buildBody: (targetId: string) => string,
    platform: { dbgs: string; client: string }
): Promise<void> {
    let dbgsProc: ChildProcess | null = null;
    let clientProc: ChildProcess | null = null;

    try {
        // 1. Запуск dbgs
        dbgsProc = startDbgs(platform.dbgs, PORT);
        if (!await waitForDbgs(PORT, 5000)) {
            console.log(`[${name}] dbgs не запустился за 5 секунд`);
            return;
        }
        console.log(`[${name}] dbgs готов`);

        // 2. attachDebugUI
        await attachDebugUI();
        console.log(`[${name}] attachDebugUI — OK`);

        // 3. setBreakpoints
        await setBreakpoints(BREAKPOINT_LINE);
        console.log(`[${name}] setBreakpoints — OK`);

        // 4. Запуск 1С клиента
        clientProc = startClient(platform.client, IB_PATH, PORT);
        console.log(`[${name}] 1С клиент запущен, ожидание остановки...`);

        // 5. Ping-цикл до остановки (30 сек max)
        let targetId: string | null = null;
        for (let i = 0; i < 30; i++) {
            await sleep(1000);

            let xml = '';
            try {
                xml = await ping();
            } catch {
                continue;
            }

            if (!xml || !xml.trim()) {
                process.stdout.write('.');
                continue;
            }

            const started = extractTargetStartedId(xml);
            if (started) {
                console.log(`\n[${name}] targetStarted: ${started}`);
                try { await attachTargets(started); } catch {}
                try { await setBreakpoints(BREAKPOINT_LINE); } catch {}
                continue;
            }

            const stopped = extractCallStackFormedId(xml);
            if (stopped) {
                console.log(`\n[${name}] CallStackFormed — остановка: ${stopped}`);
                targetId = stopped;
                break;
            }

            console.log(`\n[${name}] Неизвестный ping-ответ: ${xml.slice(0, 200)}`);
        }

        if (!targetId) {
            console.log(`\n[${name}] Таймаут — цель не остановилась за 30 секунд`);
            return;
        }

        // 6. Отправка evalLocalVariables
        const body = buildBody(targetId);
        console.log(`\n→ REQUEST:\n${body}`);

        try {
            const resp = await sendRdbg('evalLocalVariables', body);
            console.log(`\n✓ SUCCESS (${resp.length} байт):\n${resp}`);
        } catch (err) {
            console.log(`\n✗ ERROR: ${describeError(err)}`);
        }

    } catch (err) {
        console.log(`[${name}] Ошибка: ${describeError(err)}`);
    } finally {
        // 7. Cleanup
        try { await detachDebugUI(); } catch {}
        if (clientProc && !clientProc.killed) {
            console.log(`[${name}] Останавливаю 1С клиент...`);
            clientProc.kill();
        }
        if (dbgsProc && !dbgsProc.killed) {
            console.log(`[${name}] Останавливаю dbgs...`);
            dbgsProc.kill();
        }
        // Ждём завершения процессов
        await sleep(1000);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    console.log('evalLocalVarsProbe — тестирование вариантов XML');
    console.log(`Host: ${HOST}:${PORT}`);
    console.log(`Debug UI ID: ${debugUiId}`);
    console.log(`Object: ${OBJECT_ID}`);
    console.log(`Property: ${PROPERTY_ID}`);
    console.log(`Breakpoint line: ${BREAKPOINT_LINE}`);

    const platform = findPlatform();
    if (!platform) {
        console.log('Платформа 1С не найдена в C:\\Program Files\\1cv8');
        process.exit(1);
    }
    console.log(`Платформа: ${platform.dbgs}`);

    if (!IB_PATH) {
        console.log('Укажите путь к файловой инфобазе:');
        console.log('  npx tsx test/debug-probe/evalLocalVarsProbe.ts "C:\\path\\to\\infobase"');
        console.log('  или: set PROBE_IB_PATH=C:\\path\\to\\infobase');
        process.exit(1);
    }
    console.log(`Инфобаза: ${IB_PATH}`);

    const variants: Array<{ name: string; buildBody: (targetId: string) => string }> = [
        {
            name: 'V1: <calc:stackLevel>0</calc:stackLevel>',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
  <rdbg:expr>
    <calc:stackLevel>0</calc:stackLevel>
  </rdbg:expr>
</request>`,
        },
        {
            name: 'V2: <stackLevel>0</stackLevel> (default ns = debugBaseData)',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
  <rdbg:expr>
    <stackLevel>0</stackLevel>
  </rdbg:expr>
</request>`,
        },
        {
            name: 'V3: без <rdbg:expr> (только base fields)',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
</request>`,
        },
        {
            name: 'V4: expr с xsi:type="calc:CalculationSourceDataStorage"',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
  <rdbg:expr xsi:type="calc:CalculationSourceDataStorage">
    <calc:stackLevel>0</calc:stackLevel>
  </rdbg:expr>
</request>`,
        },
        {
            name: 'V5: <rdbg:expr/> (пустой)',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
  <rdbg:expr/>
</request>`,
        },
        {
            name: 'V6: <rdbg:stackLevel> (in rdbg ns)',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
  <rdbg:expr>
    <rdbg:stackLevel>0</rdbg:stackLevel>
  </rdbg:expr>
</request>`,
        },
        {
            name: 'V7: <stackLevel xmlns=""> (truly unqualified)',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
  <rdbg:expr>
    <stackLevel xmlns="">0</stackLevel>
  </rdbg:expr>
</request>`,
        },
        {
            name: 'V8: expr override default ns to calc',
            buildBody: (targetId) => `<?xml version="1.0" encoding="UTF-8"?>
<request ${NS} xsi:type="rdbg:RDBGEvalLocalVariablesRequest">
  <rdbg:infoBaseAlias>DefAlias</rdbg:infoBaseAlias>
  <rdbg:idOfDebuggerUI>${debugUiId}</rdbg:idOfDebuggerUI>
  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>
  <rdbg:targetID>
    <id>${targetId}</id>
  </rdbg:targetID>
  <rdbg:expr xmlns="http://v8.1c.ru/8.3/debugger/debugCalculations">
    <stackLevel>0</stackLevel>
  </rdbg:expr>
</request>`,
        },
    ];

    // Skip already-tested variants (V1-V5); run only V6+
    const startFrom = parseInt(process.env.PROBE_START_V ?? '1', 10);
    const filtered = variants.filter((_, i) => i + 1 >= startFrom);
    for (const variant of filtered) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`ТЕСТ: ${variant.name}`);
        console.log(`${'='.repeat(60)}`);

        await tryVariant(variant.name, variant.buildBody, platform);

        await sleep(2000); // пауза между вариантами
    }

    console.log('\n\nВСЕ ТЕСТЫ ЗАВЕРШЕНЫ.');
}

main().catch((err) => {
    console.error('[FATAL]', describeError(err));
    process.exit(1);
});
