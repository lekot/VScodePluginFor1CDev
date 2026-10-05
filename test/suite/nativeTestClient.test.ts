import * as assert from 'assert';
import * as net from 'net';
import type { AddressInfo } from 'net';
import {
  buildAttachFrame,
  buildIntroTicket,
  buildRpcFrame,
  buildScomHandshakeFrame,
  connectNativeTestClientWithDependencies,
  NativeTestClientError,
} from '../../src/services/forms/nativeTestClient';
import type { SspiAuthenticator } from '../../src/services/forms/nativeSspi';
import { SCOM_TRAILER } from '../../src/services/forms/nativeTestClientProtocol';

const SESSION_BLOCK = '3ace6d91-51bb-4344-9388-c8105ad4ad11';
const AUTH_BLOCK = '671507fd-50a9-4b63-b70e-58b3d364f48f';
const SESSION_ID = '12345678-1234-4234-8234-123456789abc';
const WINDOW_ID = '87654321-4321-4321-8321-cba987654321';
const WINDOW_HANDLE = 'aabbccdd-1122-4334-8556-77889900aabb';
const GET_ACTIVE_WINDOW = '0d854d55-8a06-49ee-9e29-2f8d0e7a9f0e';
const NETWORK_GREETING = Buffer.from([0x53, 0xf5, 0xc6, 0x1a, 0x7b]);

interface FakeServer {
  port: number;
  requests: Buffer[];
  close(): Promise<void>;
}

type FakeResponseResolver = (request: Buffer, requestIndex: number) => Buffer | undefined;

async function startFakeServer(responses: Array<Buffer | undefined> | FakeResponseResolver): Promise<FakeServer> {
  const requests: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      let marker = pending.indexOf(SCOM_TRAILER);
      while (marker >= 0) {
        const end = marker + SCOM_TRAILER.length;
        const requestIndex = requests.length;
        const request = pending.subarray(0, end);
        requests.push(request);
        pending = pending.subarray(end);
        const response = typeof responses === 'function' ? responses(request, requestIndex) : responses[requestIndex];
        if (response) socket.write(response);
        marker = pending.indexOf(SCOM_TRAILER);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function textFrame(text: string): Buffer {
  return Buffer.concat([Buffer.from(`\uFEFF${text}`, 'utf8'), SCOM_TRAILER]);
}

function binaryReply(frame: Buffer): Buffer {
  return Buffer.concat([frame, SCOM_TRAILER]);
}

function guidLe(guid: string): Buffer {
  const bytes = Buffer.from(guid.replace(/-/g, ''), 'hex');
  return Buffer.from([bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6], ...bytes.subarray(8)]);
}

function protocolString(value: string, family: number): Buffer {
  const latin = Buffer.from(value, 'latin1');
  if (latin.toString('latin1') === value) return Buffer.concat([Buffer.from([family | 0x0a, latin.length]), latin]);
  const utf16 = Buffer.from(value, 'utf16le');
  return Buffer.concat([Buffer.from([family | 0x07, utf16.length / 2]), utf16]);
}

function activeWindowReply(): Buffer {
  const title = 'Temp client';
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe(GET_ACTIVE_WINDOW),
    Buffer.from([0xd5]),
    guidLe(WINDOW_HANDLE),
    Buffer.from([0x81, 0x81, 0x81, 0x81]),
    guidLe(WINDOW_HANDLE),
    protocolString(`MainFrame[${WINDOW_ID}]`, 0x90),
    Buffer.from([0x81]),
    protocolString(title, 0xf0),
    Buffer.from([0x20, 0xa1, 0xa3]),
  ]));
}

function childObjectsReply(children: Array<{
  key: string;
  handle: string;
  text: string;
  name?: string;
  url?: string;
  typeCode?: number;
  rawTitle?: Buffer;
}> = [], method = 'c92b100a-460b-402c-b5ae-b6e2329a7234'): Buffer {
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe(method),
    Buffer.from([0xd5]),
    guidLe(WINDOW_HANDLE),
    Buffer.from([0x81, 0x81, 0x81, 0x81]),
    ...children.map((child) => Buffer.concat([
      guidLe(child.handle),
      protocolString(child.key, 0x90),
      Buffer.from([0x82]),
      child.rawTitle ?? protocolString(child.text, 0xf0),
      ...(child.url === undefined ? [] : [
        Buffer.from([0xe1, 0x81]),
        protocolString(child.url, 0x90),
      ]),
      ...(child.typeCode === undefined ? [] : [
        protocolString(child.name ?? 'TestInput', 0xf0),
        // The live descriptor follows the object's name in its record. Other
        // reply values can follow it before the overall method trailer.
        Buffer.from([0x81, child.typeCode, 0x20, 0xeb, 0x23, 0x95, 0x81, 0x81, 0x81, 0x81, 0x81]),
      ]),
    ])),
    Buffer.from([0x20, 0xa1, 0xa3]),
  ]));
}

function editTextReply(handle: string, key: string, text?: string, emptyMarker = 0xe1): Buffer {
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe('e9ce0326-64c1-47de-ab5b-a07142ceaf79'),
    Buffer.from([0xd5]),
    guidLe(handle),
    protocolString(key, 0x90),
    Buffer.from([0x81, 0x81, 0x81]),
    text === undefined ? Buffer.from([emptyMarker]) : protocolString(text, 0xf0),
    Buffer.from([0x20, 0xa1, 0xa3]),
  ]));
}

function rpcStatusReply(method: string, handle: string, key: string, status: number): Buffer {
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe(method),
    Buffer.from([0xd5]),
    guidLe(handle),
    protocolString(key, 0x90),
    Buffer.from([0x8b, status, 0x20, 0xa1, 0xa3]),
  ]));
}

function selectedRowsReply(
  tableHandle: string,
  tableKey: string,
  rows: Array<Record<string, string>>,
): Buffer {
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe('7374a2ee-4fc4-43ea-b30f-b0246da4a771'),
    Buffer.from([0xd5]),
    guidLe(tableHandle),
    protocolString(tableKey, 0x90),
    Buffer.from([0x81, 0x81, 0x81, 0xe0, 0x4b, 0x55]),
    ...rows.flatMap((row) => [
      Buffer.from([0xc0, 0x4b]),
      ...Object.entries(row).flatMap(([column, value], index) => [
        Buffer.from(index === 0 ? [] : [0x20, 0xe0, 0x4b, 0x53]),
        protocolString(column, 0x90),
        Buffer.from([0xeb, 0x53]),
        protocolString(value, 0x90),
      ]),
    ]),
    Buffer.from([0x20, 0xa1, 0xa3]),
  ]));
}

function malformedSelectedRowsReply(tableHandle: string, tableKey: string): Buffer {
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe('7374a2ee-4fc4-43ea-b30f-b0246da4a771'),
    Buffer.from([0xd5]),
    guidLe(tableHandle),
    protocolString(tableKey, 0x90),
    Buffer.from([0x81, 0x81, 0x81, 0x55, 0x20, 0xa1, 0xa3]),
  ]));
}

function uiLogFinishReply(xml: string): Buffer {
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe('77e9254b-03ec-4499-ae39-60dcb9e2f440'),
    Buffer.from([0xd5]),
    guidLe(WINDOW_HANDLE),
    Buffer.from([0x81, 0x81, 0x81, 0x81, 0xe5]),
    protocolString(xml, 0xf0),
    Buffer.from([0x20, 0xa1, 0xa3]),
  ]));
}

function successfulActionReply(method: string, handle: string): Buffer {
  return binaryReply(Buffer.concat([
    Buffer.from([0x42, 0x81, 0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]),
    guidLe(method),
    Buffer.from([0xd5]),
    guidLe(handle),
    Buffer.from([0x81, 0x81, 0x81, 0x81, 0x20, 0xa1, 0xa3]),
  ]));
}

function streamFormatErrorReply(): Buffer {
  const message = 'Ошибка формата потока';
  const utf16 = Buffer.from(message, 'utf16le');
  return binaryReply(Buffer.concat([
    Buffer.from([0x43, 0x95]),
    guidLe(SESSION_ID),
    Buffer.from([0xd5]),
    guidLe(SESSION_ID),
    Buffer.from([0x97, utf16.length / 2]),
    utf16,
  ]));
}

suite('Native TestClient connection lifecycle', () => {
  test('validates port before opening a socket or starting SSPI', async () => {
    let authenticatorCreated = false;
    await assert.rejects(
      connectNativeTestClientWithDependencies(
        { host: '127.0.0.1', port: 0, timeoutMs: 20 },
        undefined,
        { createAuthenticator: () => { authenticatorCreated = true; throw new Error('must not start'); } },
      ),
      (error: unknown) => error instanceof NativeTestClientError && error.code === 'NATIVE_INVALID_PORT',
    );
    assert.strictEqual(authenticatorCreated, false);
  });

  test('encodes the intro ticket, handshake fields, and attach as typed protocol values', () => {
    const ticket = buildIntroTicket('max', 'PC-1');
    assert.strictEqual(ticket.subarray(0, 16).toString('ascii'), 'V8IntroTicketReq');
    assert.strictEqual(ticket.readUInt16LE(16), Buffer.byteLength('max@PC-1'));
    assert.strictEqual(ticket.subarray(18, -1).toString('utf8'), 'max@PC-1');

    const intro = buildScomHandshakeFrame(22548, 'PC-1', ticket);
    const introText = intro.toString('utf8');
    assert.match(introText, /\{0,e23134a2-14ff-4160-ba5f-ccef04e3786f,22548,4,7f58f27d-5ad8-43a1-aa1e-c982f41bed5c/);
    assert.match(introText, /d450256e-76cf-4404-b8ae-056edd642053/);
    assert.match(introText, /00000000-0000-0000-0000-000000000000/);
    assert.ok(intro.subarray(-SCOM_TRAILER.length).equals(SCOM_TRAILER));

    const attach = buildAttachFrame(SESSION_ID);
    assert.strictEqual(attach.length, 113);
    assert.ok(attach.subarray(2, 18).equals(guidLe(SESSION_ID)));
    assert.ok(attach.includes(guidLe('bee47c3e-36bd-4926-8daf-71e22243feb0')));
    assert.ok(attach.includes(guidLe('a587a2f5-072c-44ec-b10e-36c7bd2452b5')));
  });

  test('builds standard SSPI and direct-session first binary headers independently', () => {
    const common = {
      sessionId: SESSION_ID,
      counter: 101,
      methodGuid: GET_ACTIVE_WINDOW,
      result: 'collection' as const,
    };
    const standard = buildRpcFrame({ ...common, firstBinary: false });
    const directBootstrap = buildRpcFrame({ ...common, firstBinary: true });
    assert.strictEqual(standard.length - directBootstrap.length, 1);
    assert.strictEqual(standard[20], 0x81);
    assert.strictEqual(directBootstrap[20], 0x85);
    assert.strictEqual(standard[standard.length - 8], 0x20, 'collection uses four trailing pad bytes');

    const action = buildRpcFrame({
      sessionId: SESSION_ID,
      counter: 102,
      methodGuid: '9392ed8f-88a7-473d-8e66-d11d01ea95c1',
      key: `EditField[${WINDOW_ID}]`,
      handle: WINDOW_HANDLE,
      kind: 'action',
      middle: Buffer.from([0xe0, 0x41, 0x81, 0x81, 0xb7, 0x01, 0x54, 0x00]),
      result: 'none',
    });
    assert.ok(action.subarray(-7, -4).equals(Buffer.from([0x20, 0x20, 0x20])), 'argument actions retain the three standard trailing pads');

    const commit = buildRpcFrame({
      ...common,
      counter: 103,
      kind: 'commit',
      key: `EditField[${WINDOW_ID}]`,
      handle: WINDOW_HANDLE,
      middle: Buffer.from([0xe0, 0x41, 0x81, 0x81, 0xb7, 0x01, 0x54, 0x00]),
      result: 'none',
    });
    assert.ok(commit.includes(Buffer.from([0xa1, 0xcb, 0x23, 0x95])), 'commit uses the commit transaction marker');
    assert.ok(commit.includes(Buffer.from([0x81, 0x81, 0x81, 0xe0, 0x41, 0x81, 0x81])));
  });

  test('runs attach and active-window overview against a fake server', async () => {
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const result = await session.execute({ action: 'overview', maxDepth: 0, maxNodes: 5 }, { timeoutMs: 500 });
        assert.strictEqual('activeWindow' in result, true);
        if (!('activeWindow' in result)) throw new Error('Expected overview result');
        assert.strictEqual(result.activeWindow.className, 'MainFrame');
        assert.strictEqual(result.activeWindow.text, 'Temp client');
        assert.match(result.activeWindow.ref.id, /^[0-9a-f-]{36}$/i);
        const objectByRef = (session as unknown as { objectByRef: Map<string, { key: string; handle: string }> }).objectByRef;
        assert.strictEqual(objectByRef.get(result.activeWindow.ref.id)?.handle, WINDOW_HANDLE);
        assert.strictEqual(server.requests.length, 4);
        assert.strictEqual(server.requests[2][0], 0x41, 'attach uses the typed binary request marker');
        assert.strictEqual(server.requests[3][0], 0x41, 'overview uses a binary RPC request');
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('reads command-interface nodes and extracts a CIButton navigation URL', async () => {
    const buttonKey = `MainFrame[${WINDOW_ID}].CI.CIButton[CatalogGoods]`;
    const buttonHandle = '11223344-5566-4778-899a-aabbccddeeff';
    const getCommandInterface = 'fb8a317d-932c-4342-abeb-2494a167cb7a';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{
        key: buttonKey,
        handle: buttonHandle,
        text: 'Товары',
        url: 'e1cib/list/Справочник.Товары',
      }], getCommandInterface),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const result = await session.execute({ action: 'commandInterface', maxDepth: 0 }, { timeoutMs: 500 });
        assert.ok('items' in result);
        if (!('items' in result)) {throw new Error('Expected command-interface result');}
        assert.strictEqual(result.items.length, 1);
        assert.strictEqual(result.items[0].className, 'CIButton');
        assert.strictEqual(result.items[0].text, 'Товары');
        assert.strictEqual(result.items[0].url, 'e1cib/list/Справочник.Товары');
        assert.ok(server.requests[4].includes(guidLe(getCommandInterface)));
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('executes a navigation URL with action and commit, then verifies active window', async () => {
    const command = 'e1cib/list/Справочник.Товары';
    const executeCommand = '530549e3-c8e2-4bd0-881b-e98d27b886d1';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      successfulActionReply(executeCommand, WINDOW_HANDLE),
      successfulActionReply(executeCommand, WINDOW_HANDLE),
      activeWindowReply(),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const result = await session.execute({ action: 'executeCommand', url: command }, { timeoutMs: 500 });
        assert.ok('command' in result);
        if (!('command' in result)) {throw new Error('Expected execute-command result');}
        assert.strictEqual(result.command, command);
        assert.strictEqual(result.windowChanged, false);
        assert.strictEqual(result.activeWindow.className, 'MainFrame');
        assert.ok(server.requests[4].includes(guidLe(executeCommand)));
        assert.ok(server.requests[5].includes(guidLe(executeCommand)));
        assert.ok(server.requests[4].includes(protocolString(command, 0xf0)), 'execute command uses the f0 string family');
        assert.strictEqual(server.requests.length, 7);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('returns inDoubt when command action succeeded but its commit was rejected', async () => {
    const command = 'e1cib/list/Catalog.Goods';
    const commandKey = `MainFrame[${WINDOW_ID}]`;
    const executeCommand = '530549e3-c8e2-4bd0-881b-e98d27b886d1';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      successfulActionReply(executeCommand, WINDOW_HANDLE),
      rpcStatusReply(executeCommand, WINDOW_HANDLE, commandKey, 17),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        await assert.rejects(
          session.execute({ action: 'executeCommand', url: command }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError
            && error.code === 'FORMS_OPERATION_IN_DOUBT' && error.effectPossible,
        );
        assert.strictEqual(session.connected, false);
        assert.strictEqual(server.requests.length, 6, 'do not query the active window after an unconfirmed commit');
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('returns inDoubt when a committed command cannot verify the resulting active window', async () => {
    const command = 'e1cib/list/Catalog.Goods';
    const commandKey = `MainFrame[${WINDOW_ID}]`;
    const executeCommand = '530549e3-c8e2-4bd0-881b-e98d27b886d1';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      successfulActionReply(executeCommand, WINDOW_HANDLE),
      successfulActionReply(executeCommand, WINDOW_HANDLE),
      rpcStatusReply(GET_ACTIVE_WINDOW, WINDOW_HANDLE, commandKey, 17),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        await assert.rejects(
          session.execute({ action: 'executeCommand', url: command }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError
            && error.code === 'FORMS_OPERATION_IN_DOUBT' && error.effectPossible,
        );
        assert.strictEqual(session.connected, false);
        assert.strictEqual(server.requests.length, 7, 'command and commit were sent before active-window verification failed');
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('rejects command URLs containing ASCII control characters before sending an RPC', async () => {
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        await assert.rejects(
          session.execute({ action: 'executeCommand', url: 'e1cib/list/\nСправочник.Товары' }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError
            && error.code === 'NATIVE_INVALID_COMMAND_URL',
        );
        assert.strictEqual(server.requests.length, 3, 'invalid command is rejected without an RPC');
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('reads selected table rows, reports confirmed completeness, and restores an empty selection', async () => {
    const tableKey = `MainFrame[${WINDOW_ID}].Table[Items]`;
    const tableHandle = '22113344-5566-4778-899a-aabbccddeeff';
    const getSelectedRows = '7374a2ee-4fc4-43ea-b30f-b0246da4a771';
    const selectAllRows = '59c81cd4-31c3-4665-a11d-f742a39431d5';
    const gotoRow = '112bd033-41f2-4078-9bdf-1343ce656a93';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: tableKey, handle: tableHandle, text: 'Строки' }]),
      selectedRowsReply(tableHandle, tableKey, []),
      successfulActionReply(selectAllRows, tableHandle),
      successfulActionReply(selectAllRows, tableHandle),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'А' }, { Товар: 'Б' }]),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'А' }]),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, []),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const table = overview.activeWindow.children?.[0];
        assert.ok(table);
        if (!table) {throw new Error('Expected table object');}
        const result = await session.execute({ action: 'readTable', ref: table.ref, maxRows: 10 }, { timeoutMs: 500 });
        assert.ok('rows' in result);
        if (!('rows' in result)) {throw new Error('Expected table rows result');}
        assert.deepStrictEqual(result.rows, [{ Товар: 'А' }, { Товар: 'Б' }]);
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.truncated, false);
        assert.strictEqual(result.rowCount, 2);
        assert.strictEqual(result.selectionRestored, true);
        assert.ok(server.requests[6].includes(guidLe(selectAllRows)));
        assert.ok(server.requests[7].includes(guidLe(selectAllRows)));
        assert.strictEqual(server.requests.length, 13);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('restores or reports inDoubt when SelectAllRows action fails after its effect is uncertain', async () => {
    const tableKey = `MainFrame[${WINDOW_ID}].Table[Items]`;
    const tableHandle = '22113344-5566-4778-899a-aabbccddeeff';
    const selectAllRows = '59c81cd4-31c3-4665-a11d-f742a39431d5';
    const gotoRow = '112bd033-41f2-4078-9bdf-1343ce656a93';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: tableKey, handle: tableHandle, text: 'Строки' }]),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'Исходная строка' }]),
      rpcStatusReply(selectAllRows, tableHandle, tableKey, 17),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'Изменённое выделение' }]),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const table = overview.activeWindow.children?.[0];
        assert.ok(table);
        if (!table) {throw new Error('Expected table object');}
        await assert.rejects(
          session.execute({ action: 'readTable', ref: table.ref }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError
            && error.code === 'FORMS_OPERATION_IN_DOUBT' && error.effectPossible,
        );
        assert.ok(server.requests.some((request) => request.includes(guidLe(gotoRow))), 'selection restoration must run after action rejection');
        assert.strictEqual(session.connected, false);
        assert.strictEqual(server.requests.length, 9);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('restores or reports inDoubt when SelectAllRows commit fails after the action was accepted', async () => {
    const tableKey = `MainFrame[${WINDOW_ID}].Table[Items]`;
    const tableHandle = '22113344-5566-4778-899a-aabbccddeeff';
    const selectAllRows = '59c81cd4-31c3-4665-a11d-f742a39431d5';
    const gotoRow = '112bd033-41f2-4078-9bdf-1343ce656a93';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: tableKey, handle: tableHandle, text: 'Строки' }]),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'Исходная строка' }]),
      successfulActionReply(selectAllRows, tableHandle),
      rpcStatusReply(selectAllRows, tableHandle, tableKey, 17),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'Изменённое выделение' }]),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const table = overview.activeWindow.children?.[0];
        assert.ok(table);
        if (!table) {throw new Error('Expected table object');}
        await assert.rejects(
          session.execute({ action: 'readTable', ref: table.ref }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError
            && error.code === 'FORMS_OPERATION_IN_DOUBT' && error.effectPossible,
        );
        assert.ok(server.requests.some((request) => request.includes(guidLe(gotoRow))), 'selection restoration must run after commit rejection');
        assert.strictEqual(session.connected, false);
        assert.strictEqual(server.requests.length, 10);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('attempts to restore selection when reading selected-all rows returns a malformed response', async () => {
    const tableKey = `MainFrame[${WINDOW_ID}].Table[Items]`;
    const tableHandle = '22113344-5566-4778-899a-aabbccddeeff';
    const selectAllRows = '59c81cd4-31c3-4665-a11d-f742a39431d5';
    const gotoRow = '112bd033-41f2-4078-9bdf-1343ce656a93';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: tableKey, handle: tableHandle, text: 'Строки' }]),
      selectedRowsReply(tableHandle, tableKey, []),
      successfulActionReply(selectAllRows, tableHandle),
      successfulActionReply(selectAllRows, tableHandle),
      malformedSelectedRowsReply(tableHandle, tableKey),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'А' }]),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, []),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const table = overview.activeWindow.children?.[0];
        assert.ok(table);
        if (!table) {throw new Error('Expected table object');}

        await assert.rejects(
          session.execute({ action: 'readTable', ref: table.ref }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError && error.code === 'NATIVE_INVALID_RPC_REPLY',
        );
        assert.ok(server.requests[9].includes(guidLe(gotoRow)), 'restore must be attempted after select-all read fails');
        assert.ok(server.requests[11].includes(guidLe(gotoRow)), 'empty prior selection must be cleared and verified');
        assert.strictEqual(server.requests.length, 13);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('returns inDoubt when selected-all read fails and the prior selection cannot be verified', async () => {
    const tableKey = `MainFrame[${WINDOW_ID}].Table[Items]`;
    const tableHandle = '22113344-5566-4778-899a-aabbccddeeff';
    const selectAllRows = '59c81cd4-31c3-4665-a11d-f742a39431d5';
    const gotoRow = '112bd033-41f2-4078-9bdf-1343ce656a93';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: tableKey, handle: tableHandle, text: 'Строки' }]),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'Исходная строка' }]),
      successfulActionReply(selectAllRows, tableHandle),
      successfulActionReply(selectAllRows, tableHandle),
      malformedSelectedRowsReply(tableHandle, tableKey),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, [{ Товар: 'Текущая строка' }]),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const table = overview.activeWindow.children?.[0];
        assert.ok(table);
        if (!table) {throw new Error('Expected table object');}

        await assert.rejects(
          session.execute({ action: 'readTable', ref: table.ref }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError
            && error.code === 'FORMS_OPERATION_IN_DOUBT'
            && error.effectPossible,
        );
        assert.strictEqual(session.connected, false);
        assert.strictEqual(server.requests.length, 11);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('does not report a false empty table when SelectAllRows yields zero or one selected row', async () => {
    const tableKey = `MainFrame[${WINDOW_ID}].Table[Items]`;
    const tableHandle = '22113344-5566-4778-899a-aabbccddeeff';
    const selectAllRows = '59c81cd4-31c3-4665-a11d-f742a39431d5';
    const gotoRow = '112bd033-41f2-4078-9bdf-1343ce656a93';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: tableKey, handle: tableHandle, text: 'Строки' }]),
      selectedRowsReply(tableHandle, tableKey, []),
      successfulActionReply(selectAllRows, tableHandle),
      successfulActionReply(selectAllRows, tableHandle),
      selectedRowsReply(tableHandle, tableKey, []),
      successfulActionReply(gotoRow, tableHandle),
      selectedRowsReply(tableHandle, tableKey, []),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const table = overview.activeWindow.children?.[0];
        assert.ok(table);
        if (!table) {throw new Error('Expected table object');}
        const result = await session.execute({ action: 'readTable', ref: table.ref, maxRows: 10 }, { timeoutMs: 500 });
        assert.ok('rows' in result);
        if (!('rows' in result)) {throw new Error('Expected table rows result');}
        assert.deepStrictEqual(result.rows, []);
        assert.strictEqual(result.complete, false);
        assert.strictEqual(result.rowCount, undefined);
        assert.strictEqual(result.selectionRestored, true);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('reads table column values through table rows instead of GetEditText on nested fields', async () => {
    const formKey = `MainFrame[${WINDOW_ID}].ManagedForm[${SESSION_ID}]`;
    const searchKey = `${formKey}.EditField[Search]`;
    const tableKey = `${formKey}.Table[SampleRows]`;
    const codeKey = `${tableKey}.EditField[SampleCode]`;
    const amountKey = `${tableKey}.EditField[SampleAmount]`;
    const formHandle = '33445566-7788-499a-aabb-ddeeff001133';
    const searchHandle = '44556677-8899-4aab-bbcc-ddeeff001144';
    const tableHandle = '55667788-99aa-4bbc-8dde-eff001122355';
    const codeHandle = '66778899-aabb-4ccd-8eef-f00112233466';
    const amountHandle = '778899aa-bbcc-4dde-8ff0-011223344577';
    const getEditText = 'e9ce0326-64c1-47de-ab5b-a07142ceaf79';
    const getSelectedRows = '7374a2ee-4fc4-43ea-b30f-b0246da4a771';
    const selectAllRows = '59c81cd4-31c3-4665-a11d-f742a39431d5';
    const gotoRow = '112bd033-41f2-4078-9bdf-1343ce656a93';
    const prefix: Array<Buffer | undefined> = [
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: formKey, handle: formHandle, text: 'Таблица' }]),
      childObjectsReply([
        { key: searchKey, handle: searchHandle, text: 'Поиск', name: 'Search', typeCode: 0xe3 },
        { key: tableKey, handle: tableHandle, text: 'Строки', name: 'SampleRows' },
      ]),
      childObjectsReply(),
      childObjectsReply([
        { key: codeKey, handle: codeHandle, text: 'Код', name: 'SampleCode', typeCode: 0xe3 },
        { key: amountKey, handle: amountHandle, text: 'Количество', name: 'SampleAmount', typeCode: 0xe3 },
      ]),
      childObjectsReply(),
      childObjectsReply(),
    ];
    let selectedRowsRead = 0;
    const server = await startFakeServer((request, requestIndex) => {
      if (requestIndex < prefix.length) {return prefix[requestIndex];}
      if (request.includes(guidLe(getEditText))) {
        if (request.includes(Buffer.from('SampleCode', 'ascii'))) {
          return rpcStatusReply(getEditText, codeHandle, codeKey, 17);
        }
        if (request.includes(Buffer.from('SampleAmount', 'ascii'))) {
          return rpcStatusReply(getEditText, amountHandle, amountKey, 17);
        }
        if (request.includes(Buffer.from('Search', 'ascii'))) {
          return editTextReply(searchHandle, searchKey, 'ready');
        }
      }
      if (request.includes(guidLe(getSelectedRows))) {
        const replies = [
          selectedRowsReply(tableHandle, tableKey, []),
          selectedRowsReply(tableHandle, tableKey, [{ Code: 'row-alpha', Amount: '11' }, { Code: 'row-beta', Amount: '29' }]),
          selectedRowsReply(tableHandle, tableKey, [{ Code: 'row-alpha', Amount: '11' }]),
          selectedRowsReply(tableHandle, tableKey, []),
        ];
        return replies[selectedRowsRead++];
      }
      if (request.includes(guidLe(selectAllRows))) {return successfulActionReply(selectAllRows, tableHandle);}
      if (request.includes(guidLe(gotoRow))) {return successfulActionReply(gotoRow, tableHandle);}
      return undefined;
    });
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const result = await session.execute({ action: 'formContext', includeTables: true }, { timeoutMs: 500 });
        assert.ok('elements' in result && 'tables' in result);
        if (!('elements' in result) || !('tables' in result)) {throw new Error('Expected form context with tables');}
        assert.ok(result.tables);
        if (!result.tables) {throw new Error('Expected table results');}
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.elements.find((element) => element.name === 'Search')?.value, 'ready');
        assert.ok(result.elements.some((element) => element.name === 'SampleCode'));
        assert.deepStrictEqual(result.tables[0].rows, [
          { Code: 'row-alpha', Amount: '11' },
          { Code: 'row-beta', Amount: '29' },
        ]);
        assert.strictEqual(result.tables[0].selectionRestored, true);
        const editTextRequests = server.requests.filter((request) => request.includes(guidLe(getEditText)));
        assert.strictEqual(editTextRequests.length, 1, 'only the standalone form field is read with GetEditText');
        assert.ok(editTextRequests[0].includes(Buffer.from('Search', 'ascii')));
        assert.strictEqual(server.requests.length, 19);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('captures form field context and keeps snapshot baselines local to the native session', async () => {
    const formKey = `MainFrame[${WINDOW_ID}].ManagedForm[${SESSION_ID}]`;
    const fieldKey = `${formKey}.EditField[Search]`;
    const formHandle = '33445566-7788-499a-aabb-ccddeeff0011';
    const fieldHandle = '44556677-8899-4aab-bbcc-ddeeff001122';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: formKey, handle: formHandle, text: 'Документ' }]),
      childObjectsReply([{ key: fieldKey, handle: fieldHandle, text: 'Поиск', name: 'Search', typeCode: 0xe3 }]),
      childObjectsReply(),
      editTextReply(fieldHandle, fieldKey, 'Найти'),
      activeWindowReply(),
      childObjectsReply([{ key: formKey, handle: formHandle, text: 'Документ' }]),
      childObjectsReply([{ key: fieldKey, handle: fieldHandle, text: 'Поиск', name: 'Search', typeCode: 0xe3 }]),
      childObjectsReply(),
      editTextReply(fieldHandle, fieldKey, 'Найти'),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const snapshot = await session.execute({ action: 'createSnapshot' }, { timeoutMs: 500 });
        assert.ok('capturedAt' in snapshot);
        if (!('capturedAt' in snapshot)) {throw new Error('Expected snapshot result');}
        assert.strictEqual(snapshot.complete, true);
        const listed = await session.execute({ action: 'listSnapshots' }, { timeoutMs: 500 });
        assert.ok('snapshots' in listed);
        if (!('snapshots' in listed)) {throw new Error('Expected snapshot list');}
        assert.strictEqual(listed.snapshots.length, 1);
        assert.strictEqual(listed.snapshots[0].snapshotId, snapshot.snapshotId);
        const compared = await session.execute({ action: 'compareSnapshot', snapshotId: snapshot.snapshotId }, { timeoutMs: 500 });
        assert.ok('changes' in compared);
        if (!('changes' in compared)) {throw new Error('Expected snapshot comparison');}
        assert.deepStrictEqual(compared.changes, []);
        assert.strictEqual(compared.complete, true);
        const deleted = await session.execute({ action: 'deleteSnapshot', snapshotId: snapshot.snapshotId }, { timeoutMs: 500 });
        assert.deepStrictEqual(deleted, { snapshotId: snapshot.snapshotId, deleted: true });
        assert.strictEqual(server.requests.length, 13);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('reuses snapshot capture depth and node limits when comparing the baseline', async () => {
    const formKey = `MainFrame[${WINDOW_ID}].ManagedForm[${SESSION_ID}]`;
    const groupOneKey = `${formKey}.Group[LevelOne]`;
    const groupTwoKey = `${groupOneKey}.Group[LevelTwo]`;
    const groupThreeKey = `${groupTwoKey}.Group[LevelThree]`;
    const fieldKey = `${groupThreeKey}.EditField[DeepField]`;
    const formHandle = '33445566-7788-499a-aabb-ccddeeff0011';
    const groupOneHandle = '44556677-8899-4aab-bbcc-ddeeff001122';
    const groupTwoHandle = '55667788-99aa-4bbc-8dde-eff001122233';
    const groupThreeHandle = '66778899-aabb-4ccd-8eef-f00112233445';
    const fieldHandle = '778899aa-bbcc-4dde-8ff0-011223344556';
    const getActiveWindow = '0d854d55-8a06-49ee-9e29-2f8d0e7a9f0e';
    const getChildObjects = 'c92b100a-460b-402c-b5ae-b6e2329a7234';
    const getEditText = 'e9ce0326-64c1-47de-ab5b-a07142ceaf79';
    const handshake: Array<Buffer | undefined> = [
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
    ];
    const server = await startFakeServer((request, requestIndex) => {
      if (requestIndex < handshake.length) {return handshake[requestIndex];}
      if (request.includes(guidLe(getActiveWindow))) {return activeWindowReply();}
      if (request.includes(guidLe(getChildObjects))) {
        if (request.includes(Buffer.from(groupThreeKey, 'ascii'))) {
          return childObjectsReply([{ key: fieldKey, handle: fieldHandle, text: 'Глубокое поле', name: 'DeepField', typeCode: 0xe3 }]);
        }
        if (request.includes(Buffer.from(groupTwoKey, 'ascii'))) {
          return childObjectsReply([{ key: groupThreeKey, handle: groupThreeHandle, text: 'Группа 3' }]);
        }
        if (request.includes(Buffer.from(groupOneKey, 'ascii'))) {
          return childObjectsReply([{ key: groupTwoKey, handle: groupTwoHandle, text: 'Группа 2' }]);
        }
        if (request.includes(Buffer.from(formKey, 'ascii'))) {
          return childObjectsReply([{ key: groupOneKey, handle: groupOneHandle, text: 'Группа 1' }]);
        }
        return childObjectsReply([{ key: formKey, handle: formHandle, text: 'Документ' }]);
      }
      if (request.includes(guidLe(getEditText))) {return editTextReply(fieldHandle, fieldKey, 'значение');}
      return undefined;
    });
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const capture = {
          action: 'createSnapshot' as const,
          includeTables: false,
          maxDepth: 10,
          maxNodes: 1000,
        };
        const snapshot = await session.execute(capture, { timeoutMs: 500 });
        assert.ok('snapshotId' in snapshot && 'complete' in snapshot);
        if (!('snapshotId' in snapshot && 'complete' in snapshot)) {throw new Error('Expected snapshot result');}
        assert.strictEqual(snapshot.complete, true);

        const compared = await session.execute({ action: 'compareSnapshot', snapshotId: snapshot.snapshotId }, { timeoutMs: 500 });
        assert.ok('changes' in compared);
        if (!('changes' in compared)) {throw new Error('Expected snapshot comparison');}
        assert.strictEqual(compared.complete, true);
        assert.deepStrictEqual(compared.changes, []);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('keeps existing object refs valid when an internal snapshot refreshes form context', async () => {
    const formKey = `MainFrame[${WINDOW_ID}].ManagedForm[${SESSION_ID}]`;
    const fieldKey = `${formKey}.EditField[Search]`;
    const formHandle = '33445566-7788-499a-aabb-ccddeeff0011';
    const fieldHandle = '44556677-8899-4aab-bbcc-ddeeff001122';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: formKey, handle: formHandle, text: 'Документ' }]),
      childObjectsReply([{ key: fieldKey, handle: fieldHandle, text: 'Поиск', name: 'Search', typeCode: 0xe3 }]),
      childObjectsReply(),
      activeWindowReply(),
      childObjectsReply([{ key: formKey, handle: formHandle, text: 'Документ' }]),
      childObjectsReply([{ key: fieldKey, handle: fieldHandle, text: 'Поиск', name: 'Search', typeCode: 0xe3 }]),
      childObjectsReply(),
      editTextReply(fieldHandle, fieldKey, 'до'),
      editTextReply(fieldHandle, fieldKey, 'после'),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 4, maxNodes: 20 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const field = overview.activeWindow.children?.[0]?.children?.[0];
        assert.ok(field);
        if (!field) {throw new Error('Expected field object');}

        await session.execute({ action: 'createSnapshot' }, { timeoutMs: 500 });
        const result = await session.execute({ action: 'readField', ref: field.ref }, { timeoutMs: 500 });

        assert.ok('text' in result);
        if (!('text' in result)) {throw new Error('Expected field result');}
        assert.strictEqual(result.text, 'после');
        assert.strictEqual(server.requests.length, 13);
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('controls TestClient UI log recording through the confirmed UILOG method', async () => {
    const uilog = '77e9254b-03ec-4499-ae39-60dcb9e2f440';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      successfulActionReply(uilog, WINDOW_HANDLE),
      successfulActionReply(uilog, WINDOW_HANDLE),
      successfulActionReply(uilog, WINDOW_HANDLE),
      uiLogFinishReply('<?xml version="1.0" encoding="UTF-8"?><uilog><step/></uilog>'),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        assert.deepStrictEqual(
          await session.execute({ action: 'uiLog', operation: 'start' }, { timeoutMs: 500 }),
          { operation: 'start', recording: true },
        );
        assert.deepStrictEqual(
          await session.execute({ action: 'uiLog', operation: 'pause' }, { timeoutMs: 500 }),
          { operation: 'pause', recording: false },
        );
        assert.deepStrictEqual(
          await session.execute({ action: 'uiLog', operation: 'resume' }, { timeoutMs: 500 }),
          { operation: 'resume', recording: true },
        );
        const finished = await session.execute({ action: 'uiLog', operation: 'finish' }, { timeoutMs: 500 });
        assert.deepStrictEqual(finished, {
          operation: 'finish',
          recording: false,
          uilog: '<?xml version="1.0" encoding="UTF-8"?><uilog><step/></uilog>',
        });
        assert.strictEqual(server.requests.length, 7);
        for (const request of server.requests.slice(3)) {
          assert.ok(request.includes(guidLe(uilog)));
          assert.ok(request.includes(Buffer.from([0x81, 0x81, 0x81])), 'UILOG uses the read818 envelope');
        }
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('uses the child-object scalar request descriptor and standard padding', async () => {
    const childMethod = 'c92b100a-460b-402c-b5ae-b6e2329a7234';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply(),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const result = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in result);
        if (!('activeWindow' in result)) {throw new Error('Expected overview result');}
        assert.deepStrictEqual(result.activeWindow.children, []);
        assert.strictEqual(server.requests.length, 5);
        assert.ok(server.requests[4].subarray(-15, -7).equals(Buffer.from([0xe1, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81])));
        assert.ok(server.requests[4].subarray(-7, -4).equals(Buffer.from([0x20, 0x20, 0x20])));
        assert.ok(server.requests[4].includes(guidLe(childMethod)));
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('reads a confirmed empty InputField and preserves non-empty and malformed scalar distinctions', async () => {
    const fieldKey = `MainFrame[${WINDOW_ID}].EditField[TestInput]`;
    const fieldHandle = 'bbccddaa-2211-4334-8556-77889900aabb';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: fieldKey, handle: fieldHandle, text: 'Текст', name: 'TestInput', typeCode: 0xe3 }]),
      editTextReply(fieldHandle, fieldKey),
      editTextReply(fieldHandle, fieldKey, 'Привет'),
      editTextReply(fieldHandle, fieldKey, undefined, 0xe2),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const field = overview.activeWindow.children?.find((child) => child.name === 'TestInput');
        assert.ok(field);
        if (!field) {throw new Error('Expected test input field');}
        assert.deepStrictEqual(
          await session.execute({ action: 'readField', ref: field.ref }, { timeoutMs: 500 }),
          { ref: field.ref, text: '' },
        );
        assert.deepStrictEqual(
          await session.execute({ action: 'readField', ref: field.ref }, { timeoutMs: 500 }),
          { ref: field.ref, text: 'Привет' },
        );
        await assert.rejects(
          session.execute({ action: 'readField', ref: field.ref }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError && error.code === 'NATIVE_INVALID_RPC_REPLY',
        );
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('writes, clears, and activates an input field with action and commit RPCs', async () => {
    const fieldKey = `MainFrame[${WINDOW_ID}].EditField[TestInput]`;
    const fieldHandle = 'bbccddaa-2211-4334-8556-77889900aabb';
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([{ key: fieldKey, handle: fieldHandle, text: 'Текст', name: 'TestInput', typeCode: 0xe3 }]),
      successfulActionReply('9392ed8f-88a7-473d-8e66-d11d01ea95c1', fieldHandle),
      successfulActionReply('9392ed8f-88a7-473d-8e66-d11d01ea95c1', fieldHandle),
      editTextReply(fieldHandle, fieldKey, 'Изменено'),
      successfulActionReply('5de14e75-b66f-4ff6-9a9c-819ed06cd42b', fieldHandle),
      successfulActionReply('5de14e75-b66f-4ff6-9a9c-819ed06cd42b', fieldHandle),
      successfulActionReply('f461da47-c3cc-46a3-a147-10a1397fecd2', fieldHandle),
      successfulActionReply('f461da47-c3cc-46a3-a147-10a1397fecd2', fieldHandle),
      editTextReply(fieldHandle, fieldKey),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const overview = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in overview);
        if (!('activeWindow' in overview)) {throw new Error('Expected overview result');}
        const field = overview.activeWindow.children?.find((child) => child.name === 'TestInput');
        assert.ok(field);
        if (!field) {throw new Error('Expected test input field');}
        assert.deepStrictEqual(
          await session.execute({ action: 'writeField', ref: field.ref, value: 'Изменено' }, { timeoutMs: 500 }),
          { ref: field.ref, accepted: true, text: 'Изменено' },
        );
        assert.deepStrictEqual(
          await session.execute({ action: 'act', ref: field.ref, method: 'activate' }, { timeoutMs: 500 }),
          { ref: field.ref, performed: true },
        );
        assert.deepStrictEqual(
          await session.execute({ action: 'writeField', ref: field.ref, value: '' }, { timeoutMs: 500 }),
          { ref: field.ref, accepted: true, text: '' },
        );
        assert.strictEqual(server.requests.length, 13);
        assert.ok(server.requests[5].includes(guidLe('9392ed8f-88a7-473d-8e66-d11d01ea95c1')));
        assert.ok(server.requests[6].includes(guidLe('9392ed8f-88a7-473d-8e66-d11d01ea95c1')));
        assert.ok(server.requests[8].includes(guidLe('5de14e75-b66f-4ff6-9a9c-819ed06cd42b')));
        assert.ok(server.requests[9].includes(guidLe('5de14e75-b66f-4ff6-9a9c-819ed06cd42b')));
        assert.ok(server.requests[10].includes(guidLe('f461da47-c3cc-46a3-a147-10a1397fecd2')));
        assert.ok(server.requests[11].includes(guidLe('f461da47-c3cc-46a3-a147-10a1397fecd2')));
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('keeps distinct keys addressable when TestClient reuses a child handle', async () => {
    const activateMethod = '5de14e75-b66f-4ff6-9a9c-819ed06cd42b';
    const sharedHandle = 'aabbccdd-1122-4334-8556-77889900aabb';
    const keyA = `MainFrame[${WINDOW_ID}].Button[КнопкаА]`;
    const keyB = `MainFrame[${WINDOW_ID}].Button[КнопкаБ]`;
    const falseKey = `MainFrame[${WINDOW_ID}].Button[ЛожнаяКнопка]`;
    const embeddedKey = protocolString(falseKey, 0x90);
    const rawCaptionBytes = Buffer.concat([
      Buffer.from('До', 'utf16le'),
      embeddedKey,
      Buffer.from('После', 'utf16le'),
    ]);
    const rawCaption = Buffer.concat([
      Buffer.from([0xf7, rawCaptionBytes.length / 2]),
      rawCaptionBytes,
    ]);
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      activeWindowReply(),
      childObjectsReply([
        { key: keyA, handle: sharedHandle, text: 'A', rawTitle: rawCaption },
        { key: keyB, handle: sharedHandle, text: 'B' },
      ]),
      successfulActionReply(activateMethod, sharedHandle),
      successfulActionReply(activateMethod, sharedHandle),
      successfulActionReply(activateMethod, sharedHandle),
      successfulActionReply(activateMethod, sharedHandle),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      });
      try {
        const result = await session.execute({ action: 'overview', maxDepth: 1, maxNodes: 5 }, { timeoutMs: 500 });
        assert.ok('activeWindow' in result);
        if (!('activeWindow' in result)) {throw new Error('Expected overview result');}
        const children = result.activeWindow.children ?? [];
        assert.strictEqual(children.length, 2);
        assert.deepStrictEqual(children.map((child) => child.name), ['КнопкаА', 'КнопкаБ']);
        assert.notStrictEqual(children[0].ref.id, children[1].ref.id);
        assert.deepStrictEqual(
          await session.execute({ action: 'act', ref: children[0].ref, method: 'activate' }, { timeoutMs: 500 }),
          { ref: children[0].ref, performed: true },
        );
        assert.deepStrictEqual(
          await session.execute({ action: 'act', ref: children[1].ref, method: 'activate' }, { timeoutMs: 500 }),
          { ref: children[1].ref, performed: true },
        );
        assert.strictEqual(server.requests.length, 9);
        for (const requestIndex of [5, 6]) {
          assert.ok(server.requests[requestIndex].includes(protocolString(keyA, 0x90)));
          assert.ok(server.requests[requestIndex].includes(guidLe(sharedHandle)));
        }
        for (const requestIndex of [7, 8]) {
          assert.ok(server.requests[requestIndex].includes(protocolString(keyB, 0x90)));
          assert.ok(server.requests[requestIndex].includes(guidLe(sharedHandle)));
        }
        assert.ok(server.requests[5].subarray(-7, -4).equals(Buffer.from([0x20, 0x20, 0x20])));
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('reconnects when the initial endpoint explicitly returns NETWORK_GREETING', async () => {
    let connections = 0;
    let secondRequest = Buffer.alloc(0);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      connections += 1;
      if (connections === 1) {
        socket.once('data', () => socket.write(Buffer.concat([NETWORK_GREETING, SCOM_TRAILER])));
        return;
      }
      socket.write(NETWORK_GREETING);
      socket.on('data', (chunk) => {
        secondRequest = Buffer.concat([secondRequest, chunk]);
        if (secondRequest.length >= 2) {
          const preambleLength = secondRequest.readUInt16LE(0);
          if (secondRequest.length >= 2 + preambleLength) socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    try {
      await assert.rejects(
        connectNativeTestClientWithDependencies({ host: '127.0.0.1', port: address.port, timeoutMs: 500 }),
      );
      assert.strictEqual(connections, 2);
      assert.ok(secondRequest.length >= 2, 'second connection sends a length-delimited RSA preamble');
      const preambleLength = secondRequest.readUInt16LE(0);
      assert.ok(preambleLength > 0 && secondRequest.length >= 2 + preambleLength);
      const preamble = secondRequest.subarray(2, 2 + preambleLength).toString('utf8');
      const match = /^\uFEFF"n",\r\n\{#base64:([A-Za-z0-9+/=]+)\},\r\n\{#base64:([A-Za-z0-9+/=]+)\}$/.exec(preamble);
      assert.ok(match, 'network mode sends the RSA public key in the expected preamble');
      const modulus = Buffer.from(match[1], 'base64');
      assert.strictEqual(modulus.length, 256, 'network mode must use a 2048-bit RSA modulus');
      assert.notStrictEqual(modulus[0] & 0x80, 0, 'modulus must have the 2048th bit set');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('retains SSPI context until socket close after a challenged handshake', async () => {
    const server = await startFakeServer([
      textFrame('{0}'),
      textFrame(`{0,${AUTH_BLOCK},{Y2hhbGxlbmdl}}`),
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
    ]);
    const challenges: Array<Buffer | undefined> = [];
    let disposed = false;
    const authenticator: SspiAuthenticator = {
      async nextToken(challenge) {
        challenges.push(challenge);
        return { token: Buffer.from('opaque-token'), complete: Boolean(challenge) };
      },
      async dispose() { disposed = true; },
    };
    try {
      const session = await connectNativeTestClientWithDependencies({
        host: '127.0.0.1', port: server.port, timeoutMs: 500,
      }, undefined, { createAuthenticator: () => authenticator });
      assert.deepStrictEqual(challenges.map((challenge) => challenge?.toString('utf8')), [undefined, 'challenge']);
      assert.strictEqual(disposed, false);
      await session.close();
      assert.strictEqual(disposed, true);
    } finally {
      await server.close();
    }
  });

  test('maps 0x43 stream-format errors instead of returning them as overview data', async () => {
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      streamFormatErrorReply(),
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({ host: '127.0.0.1', port: server.port, timeoutMs: 500 });
      try {
        await assert.rejects(
          session.execute({ action: 'overview', maxDepth: 0 }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError
            && error.code === 'NATIVE_TESTCLIENT_PROTOCOL_ERROR'
            && error.message.includes('Ошибка формата потока'),
        );
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });

  test('does not accept a trailer-only four-byte server reply as a successful UI RPC', async () => {
    const server = await startFakeServer([
      textFrame(`{0,${SESSION_BLOCK},{${SESSION_ID}}}`),
      textFrame('{1,1,1}'),
      binaryReply(Buffer.from([0x42, 0x81])),
      SCOM_TRAILER,
    ]);
    try {
      const session = await connectNativeTestClientWithDependencies({ host: '127.0.0.1', port: server.port, timeoutMs: 500 });
      try {
        await assert.rejects(
          session.execute({ action: 'overview', maxDepth: 0 }, { timeoutMs: 500 }),
          (error: unknown) => error instanceof NativeTestClientError && error.code === 'NATIVE_TESTCLIENT_REJECTED',
        );
      } finally {
        await session.close();
      }
    } finally {
      await server.close();
    }
  });
});
