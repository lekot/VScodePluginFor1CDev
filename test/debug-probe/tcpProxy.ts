/**
 * Raw TCP proxy for RDBG traffic capture.
 * Configurator -> proxy (1551) -> dbgs (1561).
 * Dumps all traffic to stdout, highlights eval/callStack.
 *
 * Run: npx tsx test/debug-probe/tcpProxy.ts
 */

import * as net from 'net';
import * as fs from 'fs';

const PROXY_PORT = 1551;
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 1561;
const LOG_FILE = 'test/debug-probe/rdbg-traffic.log';

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
let connId = 0;

function log(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  logStream.write(line + '\n');
  // Console: only interesting lines
  if (msg.includes('eval') || msg.includes('Eval') || msg.includes('callStack') ||
      msg.includes('CallStack') || msg.includes('calculationResult') ||
      msg.includes('CONNECT') || msg.includes('CLOSE')) {
    console.log(line);
  }
}

const server = net.createServer((clientSocket) => {
  const id = ++connId;
  log(`#${id} CONNECT`);

  const targetSocket = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });

  clientSocket.on('data', (data) => {
    const text = data.toString('utf8');
    const cmdMatch = text.match(/cmd=([^&\s]+)/);
    const cmd = cmdMatch ? cmdMatch[1] : '';

    if (cmd && cmd !== 'pingDebugUIParams' && cmd !== 'pingDebugUI') {
      log(`#${id} >> ${cmd} (${data.length}b)`);
    }
    // Log full body for interesting commands
    if (cmd.includes('eval') || cmd.includes('Eval') || cmd === 'getCallStack') {
      log(`#${id} >> BODY:\n${text}`);
    }

    targetSocket.write(data);
  });

  targetSocket.on('data', (data) => {
    const text = data.toString('utf8');

    // Log responses that contain interesting data
    if (text.includes('evalLocalVariables') || text.includes('EvalLocalVariables') ||
        text.includes('evalExpr') || text.includes('EvalExpr') ||
        text.includes('calculationResult') || text.includes('valueOfContextPropInfo') ||
        text.includes('callStack') || text.includes('CallStack')) {
      log(`#${id} << RESPONSE (${data.length}b):\n${text}`);
    }

    clientSocket.write(data);
  });

  clientSocket.on('error', (err) => { log(`#${id} CLIENT ERR: ${err.message}`); targetSocket.destroy(); });
  targetSocket.on('error', (err) => { log(`#${id} TARGET ERR: ${err.message}`); clientSocket.destroy(); });
  clientSocket.on('close', () => { log(`#${id} CLOSE client`); targetSocket.destroy(); });
  targetSocket.on('close', () => { log(`#${id} CLOSE target`); clientSocket.destroy(); });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`TCP Proxy: 0.0.0.0:${PROXY_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Log: ${LOG_FILE}`);
  console.log(`Configurator: debug port = ${PROXY_PORT}`);
  console.log(`Waiting for connections...\n`);
});
