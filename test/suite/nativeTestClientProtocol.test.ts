import * as assert from 'assert';
import * as net from 'net';
import {
  NativeTestClientChannel,
  SCOM_ESCAPE,
  SCOM_TRAILER,
  ScomFrameBuffer,
  encodeBinaryScomFrame,
} from '../../src/services/forms/nativeTestClientProtocol';

suite('Native TestClient SCOM frame codec', () => {
  test('retains partial text frames and subsequent coalesced frames', () => {
    const buffer = new ScomFrameBuffer();
    const first = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{0,intro}'), SCOM_TRAILER]);
    const second = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{0,auth}'), SCOM_TRAILER]);
    const combined = Buffer.concat([first, second]);

    buffer.append(combined.subarray(0, first.length - 2));
    assert.strictEqual(buffer.takeTextFrame(), undefined);
    assert.strictEqual(buffer.pendingBytes, first.length - 2);
    buffer.append(combined.subarray(first.length - 2));

    assert.deepStrictEqual(buffer.takeTextFrame(), first);
    assert.deepStrictEqual(buffer.takeTextFrame(), second);
    assert.strictEqual(buffer.pendingBytes, 0);
  });

  test('escapes reserved markers and restores them across every split point', () => {
    const payload = Buffer.concat([
      Buffer.from('binary payload'),
      SCOM_TRAILER,
      Buffer.from([0x01]),
      SCOM_ESCAPE,
      Buffer.from([0x02]),
      SCOM_TRAILER,
    ]);
    const frame = Buffer.concat([Buffer.from([0x41, 0x95]), payload, SCOM_TRAILER]);
    const wire = encodeBinaryScomFrame(frame);

    for (let split = 1; split < wire.length; split += 1) {
      const buffer = new ScomFrameBuffer();
      buffer.append(wire.subarray(0, split));
      assert.strictEqual(buffer.takeBinaryFrame(), undefined, `split ${split} must remain incomplete`);
      buffer.append(wire.subarray(split));
      assert.deepStrictEqual(buffer.takeBinaryFrame(), frame, `split ${split} should decode the full frame`);
      assert.strictEqual(buffer.pendingBytes, 0);
    }
  });

  test('keeps a coalesced frame in the buffer after consuming the first', () => {
    const first = Buffer.concat([Buffer.from([0x41, 0x95, 0x01]), SCOM_TRAILER]);
    const second = Buffer.concat([Buffer.from([0x41, 0x95, 0x02]), SCOM_TRAILER]);
    const buffer = new ScomFrameBuffer();
    buffer.append(Buffer.concat([encodeBinaryScomFrame(first), encodeBinaryScomFrame(second)]));

    assert.deepStrictEqual(buffer.takeBinaryFrame(), first);
    assert.deepStrictEqual(buffer.takeBinaryFrame(), second);
    assert.strictEqual(buffer.pendingBytes, 0);
  });

  test('rejects a frame without a trailer and oversized buffered input', () => {
    assert.throws(() => encodeBinaryScomFrame(Buffer.from([0x41, 0x95])), /must end with its trailer/);
    const buffer = new ScomFrameBuffer(3);
    assert.throws(() => buffer.append(Buffer.from([1, 2, 3, 4])), /frame limit/);
  });

  test('reads a real TCP frame split across socket data events', async () => {
    const frame = Buffer.concat([Buffer.from([0x41, 0x95, 0x10]), SCOM_TRAILER]);
    const wire = encodeBinaryScomFrame(frame);
    const server = net.createServer((socket) => {
      socket.write(wire.subarray(0, 3));
      setTimeout(() => socket.write(wire.subarray(3)), 5);
    });
    const address = await listen(server);
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    await onceConnected(socket);
    const channel = new NativeTestClientChannel(socket);

    assert.deepStrictEqual(await channel.readFrame(true, 500), frame);
    channel.close();
    await closeServer(server);
  });

  test('consumes a partial raw greeting and preserves the following frame', async () => {
    const greeting = Buffer.from([0x53, 0xf5, 0xc6, 0x1a, 0x7b]);
    const frame = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{0,intro}'), SCOM_TRAILER]);
    const combined = Buffer.concat([greeting, frame]);
    const server = net.createServer((socket) => {
      socket.write(combined.subarray(0, 3));
      setTimeout(() => socket.write(combined.subarray(3)), 5);
    });
    const address = await listen(server);
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    await onceConnected(socket);
    const channel = new NativeTestClientChannel(socket);

    assert.deepStrictEqual(await channel.readBytes(greeting.length, 500), greeting);
    assert.deepStrictEqual(await channel.readFrame(false, 500), frame);
    channel.close();
    await closeServer(server);
  });

  test('timeout and cancellation close the socket instead of reusing a desynchronized stream', async () => {
    const server = net.createServer();
    const address = await listen(server);
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    await onceConnected(socket);
    const channel = new NativeTestClientChannel(socket);

    await assert.rejects(channel.readFrame(true, 10), /Таймаут ответа TestClient/);
    assert.strictEqual(channel.connected, false);

    const secondSocket = net.createConnection({ host: '127.0.0.1', port: address.port });
    await onceConnected(secondSocket);
    const secondChannel = new NativeTestClientChannel(secondSocket);
    const controller = new AbortController();
    const pending = secondChannel.readFrame(true, 500, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.strictEqual(secondChannel.connected, false);
    await closeServer(server);
  });
});

function listen(server: net.Server): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Expected a TCP address.'));
      else resolve(address);
    });
  });
}

function onceConnected(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => resolve());
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
