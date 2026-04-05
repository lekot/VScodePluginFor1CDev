/**
 * Прозрачный HTTP-прокси для перехвата трафика RDBG.
 * Конфигуратор → proxy (порт 1551) → dbgs (порт 1550).
 *
 * Запуск: npx tsx test/debug-probe/rdbgProxy.ts
 * Затем в Конфигураторе: Отладка → Подключение → http://localhost:1551
 */

import * as http from 'http';

const PROXY_PORT = 1551;
const TARGET_HOST = 'localhost';
const TARGET_PORT = 1550;

let reqCounter = 0;

const server = http.createServer(async (req, res) => {
  const id = ++reqCounter;
  const url = req.url ?? '/';

  // Parse cmd from query string
  const cmdMatch = url.match(/[?&]cmd=([^&]+)/);
  const cmd = cmdMatch ? cmdMatch[1] : '?';

  // Read request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const reqBody = Buffer.concat(chunks).toString('utf8');

  // Log request
  const isEval = cmd.includes('eval') || cmd.includes('Eval');
  const isGetCallStack = cmd === 'getCallStack';
  const isInteresting = isEval || isGetCallStack || cmd === 'initSettings' || cmd === 'setAutoAttachSettings' || cmd === 'attachDebugUI' || cmd === 'setBreakpoints';

  if (isInteresting) {
    console.log(`\n${'━'.repeat(70)}`);
    console.log(`#${id} → ${req.method} ${url}`);
    console.log(`BODY:\n${reqBody}`);
    console.log(`${'━'.repeat(70)}`);
  } else {
    // Compact log for non-interesting commands
    const bodyPreview = reqBody.length > 200 ? reqBody.slice(0, 200) + '...' : reqBody;
    console.log(`#${id} → ${cmd} (${reqBody.length}b)${cmd === 'pingDebugUI' ? '' : ' ' + bodyPreview.replace(/\n/g, ' ').slice(0, 120)}`);
  }

  // Forward to dbgs
  try {
    const proxyReq = http.request(
      {
        hostname: TARGET_HOST,
        port: TARGET_PORT,
        path: url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `${TARGET_HOST}:${TARGET_PORT}`,
          'accept-encoding': 'identity', // no gzip — proxy doesn't decompress
        },
      },
      (proxyRes) => {
        const resChunks: Buffer[] = [];
        proxyRes.on('data', (chunk) => resChunks.push(chunk));
        proxyRes.on('end', () => {
          const resBody = Buffer.concat(resChunks).toString('utf8');

          if (isInteresting) {
            console.log(`#${id} ← HTTP ${proxyRes.statusCode}`);
            console.log(`RESPONSE:\n${resBody}`);
            console.log(`${'━'.repeat(70)}\n`);
          } else if (resBody.length > 0 && cmd !== 'pingDebugUI') {
            console.log(`#${id} ← ${proxyRes.statusCode} (${resBody.length}b)`);
          }

          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          res.end(Buffer.concat(resChunks));
        });
      }
    );

    proxyReq.on('error', (err) => {
      console.log(`#${id} ✗ PROXY ERROR: ${err.message}`);
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });

    proxyReq.end(reqBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`#${id} ✗ ERROR: ${msg}`);
    res.writeHead(502);
    res.end('Proxy error');
  }
});

server.listen(PROXY_PORT, () => {
  console.log(`RDBG Proxy: localhost:${PROXY_PORT} → localhost:${TARGET_PORT}`);
  console.log(`В Конфигураторе: Отладка → Начать отладку → http://localhost:${PROXY_PORT}`);
  console.log(`Интересные команды (eval*, getCallStack) логируются полностью.`);
  console.log(`Ctrl+C для остановки.\n`);
});
