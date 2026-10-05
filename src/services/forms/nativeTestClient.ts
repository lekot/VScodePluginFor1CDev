import * as crypto from 'crypto';
import * as net from 'net';
import * as os from 'os';
import type {
  NativeFormsAction,
  NativeFormsActionResult,
  NativeFormsObject,
  NativeFormsOverviewResult,
} from '../../agent/agentFormsTypes';
import type {
  NativeFormsConnectionOptions,
  NativeFormsConnector,
  NativeFormsExecuteOptions,
  NativeFormsSession,
} from './nativeFormsSession';
import { WindowsSspiAuthenticator } from './nativeSspi';
import type { SspiAuthenticator } from './nativeSspi';
import { NativeTestClientChannel, SCOM_TRAILER } from './nativeTestClientProtocol';

const SCOM_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NETWORK_GREETING = Buffer.from([0x53, 0xf5, 0xc6, 0x1a, 0x7b]);
const HANDSHAKE_TIMEOUT_MS = 10_000;
const FIRST_SEQUENCE = 22548;
const MAX_SSPI_LEGS = 3;

const CLIENT_CONNECTION_ID = 'e23134a2-14ff-4160-ba5f-ccef04e3786f';
const TESTCLIENT_SUB_ID = '7f58f27d-5ad8-43a1-aa1e-c982f41bed5c';
const PROTOCOL_OPCODE_ID = '102301e1-f311-4cbb-acb2-9dbfa0aeb4bd';
const STRUCTURE_ID = 'ae135932-4f94-44df-92c1-c91f15a92848';
const STRUCTURE_VALUE_ID = 'd450256e-76cf-4404-b8ae-056edd642053';
const AUTH_TOKEN_BLOCK_ID = '671507fd-50a9-4b63-b70e-58b3d364f48f';
const SESSION_BLOCK_ID = '3ace6d91-51bb-4344-9388-c8105ad4ad11';
const DEFAULT_PLATFORM_VERSION = '8.3.27.1859';

const FIXED_BINARY_HEADER = Buffer.from([0x81, 0x84, 0x83, 0x81, 0xcb, 0x53, 0x81]);
const RPC_OPCODE = '102301e1-f311-4cbb-acb2-9dbfa0aeb4bd';
const ATTACH_METHOD = 'bee47c3e-36bd-4926-8daf-71e22243feb0';
const ATTACH_CONTEXT = 'a587a2f5-072c-44ec-b10e-36c7bd2452b5';
const ATTACH_HANDLE = 'c677ef8c-2656-4342-b752-a03d53bcbde6';
const GET_ACTIVE_WINDOW = '0d854d55-8a06-49ee-9e29-2f8d0e7a9f0e';
const GET_CHILD_OBJECTS = 'c92b100a-460b-402c-b5ae-b6e2329a7234';
const CHILD_OBJECTS_REQUEST = Buffer.from([0xe1, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81]);
const GET_EDIT_TEXT = 'e9ce0326-64c1-47de-ab5b-a07142ceaf79';
const INPUT_TEXT = '9392ed8f-88a7-473d-8e66-d11d01ea95c1';
const CLEAR = 'f461da47-c3cc-46a3-a147-10a1397fecd2';
const CLICK = '0e65b6e0-e285-486a-9329-ef9e66822fe4';
const CLICK_FIELD = 'edf3e1b5-cb4c-4dd6-9b64-495fd4879456';
const ACTIVATE = '5de14e75-b66f-4ff6-9a9c-819ed06cd42b';

const RESULT_SCALAR = Buffer.from([0xe1]);
const RESULT_COLLECTION = Buffer.from([0xe0, 0x4b, 0x55]);
const OBJECT_KEY = /^[A-Za-z][A-Za-z0-9]*\[[0-9a-fA-F-]{36}\](?:\.[A-Za-z][A-Za-z0-9]*(?:\[([^\x5d]*)\])?)*$/;

export type NativeAttachFrameBuilder = (sessionId: string, sequence: number) => Buffer;

export interface NativeTestClientDependencies {
  attachFrameBuilder?: NativeAttachFrameBuilder;
  createAuthenticator?: () => SspiAuthenticator;
  connectSocket?: (options: NativeFormsConnectionOptions, signal?: AbortSignal) => Promise<net.Socket>;
}

export class NativeTestClientError extends Error {
  constructor(readonly code: string, message: string, readonly effectPossible = false) {
    super(message);
    this.name = 'NativeTestClientError';
  }
}

/** Connects to an already-running Windows TestClient. It never starts/stops 1C. */
export const connectNativeTestClient: NativeFormsConnector = async (options, signal) =>
  connectNativeTestClientWithDependencies(options, signal);

export async function connectNativeTestClientWithDependencies(
  options: NativeFormsConnectionOptions,
  signal?: AbortSignal,
  dependencies: NativeTestClientDependencies = {},
): Promise<NativeFormsSession> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new NativeTestClientError('NATIVE_INVALID_PORT', 'Порт TestClient должен быть целым числом от 1 до 65535.');
  }
  const host = options.host.trim();
  if (!host || /[\r\n\0]/.test(host)) {
    throw new NativeTestClientError('NATIVE_INVALID_HOST', 'Укажите допустимый host TestClient.');
  }
  if (signal?.aborted) {throw abortedError();}

  const socket = await (dependencies.connectSocket ?? connectSocket)(options, signal);
  let channel = new NativeTestClientChannel(socket);
  const machine = machineName();
  const user = os.userInfo().username;
  const version = options.platformVersion?.trim() || DEFAULT_PLATFORM_VERSION;
  let sequence = FIRST_SEQUENCE;
  let authenticator: SspiAuthenticator | undefined;

  try {
    const ticket = buildIntroTicket(user, machine);
    await channel.sendFrame(buildScomHandshakeFrame(sequence++, machine, ticket, version), false, signal);
    let response = await channel.readFrame(false, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
    if (isNetworkGreeting(response)) {
      channel.close();
      sequence = FIRST_SEQUENCE;
      const networkIntro = await openNetworkHandshake(
        options,
        buildScomHandshakeFrame(sequence++, machine, ticket, version),
        signal,
        dependencies,
      );
      channel = networkIntro.channel;
      response = networkIntro.response;
    }
    throwIfRejected(response, 'intro');
    let sessionId = readGuidBlock(response, SESSION_BLOCK_ID);
    if (!sessionId) {
      authenticator = dependencies.createAuthenticator?.() ?? new WindowsSspiAuthenticator();
      let challenge: Buffer | undefined;
      for (let leg = 0; leg < MAX_SSPI_LEGS; leg += 1) {
        const step = await authenticator.nextToken(challenge, signal);
        await channel.sendFrame(buildScomHandshakeFrame(sequence++, machine, step.token, version), false, signal);
        response = await channel.readFrame(false, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
        throwIfRejected(response, 'authentication');
        sessionId = readGuidBlock(response, SESSION_BLOCK_ID);
        if (sessionId) {break;}
        if (step.complete) {
          throw new NativeTestClientError('NATIVE_AUTHENTICATION_FAILED', 'SSPI завершил проверку, но TestClient не выдал session GUID.');
        }
        challenge = readAuthToken(response);
        if (!challenge || challenge.length === 0) {
          throw new NativeTestClientError('NATIVE_AUTHENTICATION_FAILED', 'Ответ TestClient не содержит NTLM challenge.');
        }
      }
    }
    if (!sessionId) {
      throw new NativeTestClientError('NATIVE_AUTHENTICATION_FAILED', 'TestClient не выдал session GUID после SSPI handshake.');
    }

    await channel.sendFrame(buildSessionInitFrame(sessionId, sequence++), false, signal);
    response = await channel.readFrame(false, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
    throwIfRejected(response, 'session-init');

    const attachFrame = dependencies.attachFrameBuilder
      ? dependencies.attachFrameBuilder(sessionId, sequence++)
      : buildAttachFrame(sessionId);
    await channel.sendFrame(attachFrame, true, signal);
    response = await channel.readFrame(true, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
    assertBinaryReply(response, 'attach');

    const session = new NativeTestClientSession(channel, host, options.port, sessionId, authenticator);
    authenticator = undefined;
    return session;
  } catch (error) {
    channel.close();
    throw error;
  } finally {
    await authenticator?.dispose();
  }
}

async function openNetworkHandshake(
  options: NativeFormsConnectionOptions,
  introFrame: Buffer,
  signal: AbortSignal | undefined,
  dependencies: NativeTestClientDependencies,
): Promise<{ channel: NativeTestClientChannel; response: Buffer }> {
  const socket = await (dependencies.connectSocket ?? connectSocket)(options, signal);
  const channel = new NativeTestClientChannel(socket);
  try {
    const greeting = await channel.readBytes(NETWORK_GREETING.length, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
    if (!greeting.equals(NETWORK_GREETING)) {
      throw new NativeTestClientError('NATIVE_NETWORK_HANDSHAKE_FAILED', 'TestClient не подтвердил повторное подключение в network mode.');
    }

    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 0x10001 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    if (!jwk.n || !jwk.e) {
      throw new NativeTestClientError('NATIVE_NETWORK_HANDSHAKE_FAILED', 'Не удалось подготовить RSA ключ для network mode.');
    }
    const modulus = Buffer.from(jwk.n, 'base64url');
    const exponent = Buffer.from(jwk.e, 'base64url');
    const preambleBody = Buffer.concat([
      SCOM_BOM,
      Buffer.from('"n",\r\n{#base64:', 'ascii'),
      Buffer.from(modulus.toString('base64'), 'ascii'),
      Buffer.from('},\r\n{#base64:', 'ascii'),
      Buffer.from(exponent.toString('base64'), 'ascii'),
      Buffer.from('}', 'ascii'),
    ]);
    if (preambleBody.length > 0xffff) {
      throw new NativeTestClientError('NATIVE_NETWORK_HANDSHAKE_FAILED', 'RSA preamble слишком длинный.');
    }
    const preambleLength = Buffer.alloc(2);
    preambleLength.writeUInt16LE(preambleBody.length);
    await channel.sendFrame(Buffer.concat([preambleLength, preambleBody, introFrame]), false, signal);

    const encryptedLength = await channel.readBytes(2, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
    const length = encryptedLength.readUInt16LE(0);
    if (length < 16 || length > 4096) {
      throw new NativeTestClientError('NATIVE_NETWORK_HANDSHAKE_FAILED', 'TestClient вернул некорректную длину RSA preamble.');
    }
    const encryptedPreamble = await channel.readBytes(length, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
    const encryptedIntro = await channel.readFrame(false, options.timeoutMs || HANDSHAKE_TIMEOUT_MS, signal);
    const response = decryptNetworkIntro(pair.privateKey, encryptedPreamble, encryptedIntro);
    return { channel, response };
  } catch (error) {
    channel.close();
    throw error;
  }
}

function decryptNetworkIntro(privateKey: crypto.KeyObject, preamble: Buffer, frame: Buffer): Buffer {
  try {
    const encodedPreamble = /^\uFEFF\{#base64:([A-Za-z0-9+/=\r\n]+)\}$/.exec(preamble.toString('utf8'));
    if (!encodedPreamble) {throw new Error('invalid key envelope');}
    const encryptedSecret = Buffer.from(encodedPreamble[1].replace(/\s/g, ''), 'base64');
    const secret = crypto.privateDecrypt({
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, encryptedSecret);
    if (secret.length < 2 || secret.readUInt16LE(0) !== secret.length - 2) {throw new Error('invalid key data');}
    const body = secret.subarray(2).toString('utf8');
    const block = '\\{#base64:([A-Za-z0-9+/=\\r\\n]+)\\}';
    const match = new RegExp(`^\\uFEFF"n",\\s*${block},\\s*${block},\\s*${block}$`).exec(body);
    if (!match) {throw new Error('invalid key parameters');}
    const [key, receiveIv] = match.slice(1).map((value) => Buffer.from(value.replace(/\s/g, ''), 'base64'));
    if (!key || !receiveIv || key.length !== 24 || receiveIv.length !== 8) {throw new Error('invalid key lengths');}
    if (!frame.subarray(-SCOM_TRAILER.length).equals(SCOM_TRAILER)) {throw new Error('incomplete response');}
    const cipherBytes = frame.subarray(0, -SCOM_TRAILER.length);
    if (cipherBytes.length === 0 || cipherBytes.length % 8 !== 0) {throw new Error('invalid cipher block');}
    const decipher = crypto.createDecipheriv('des-ede3-cbc', key, receiveIv);
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
    const padding = padded[padded.length - 1];
    if (!padding || padding > 8 || padding > padded.length) {throw new Error('invalid frame padding');}
    const plain = padded.subarray(0, padded.length - padding);
    if (!plain.subarray(0, 5).equals(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x31]))) {throw new Error('invalid decrypted response');}
    return Buffer.concat([plain, SCOM_TRAILER]);
  } catch {
    throw new NativeTestClientError('NATIVE_NETWORK_HANDSHAKE_FAILED', 'Не удалось проверить network-mode handshake TestClient.');
  }
}

export function buildIntroTicket(user: string, machine: string): Buffer {
  const identity = Buffer.from(`${user}@${machine}`, 'utf8');
  if (identity.length > 0xffff) {
    throw new NativeTestClientError('NATIVE_INVALID_IDENTITY', 'Идентификатор TestClient слишком длинный.');
  }
  const length = Buffer.alloc(2);
  length.writeUInt16LE(identity.length);
  return Buffer.concat([Buffer.from('V8IntroTicketReq', 'ascii'), length, identity, Buffer.from([0])]);
}

/** Builds a SCOM text envelope from the independently encoded handshake fields. */
export function buildScomHandshakeFrame(
  sequence: number,
  machine: string,
  token: Buffer,
  platformVersion = DEFAULT_PLATFORM_VERSION,
): Buffer {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) {
    throw new NativeTestClientError('NATIVE_INVALID_SEQUENCE', 'Некорректный номер SCOM sequence.');
  }
  if (/[\r\n\0"{}]/.test(machine) || /[\r\n\0"{}]/.test(platformVersion)) {
    throw new NativeTestClientError('NATIVE_INVALID_HANDSHAKE_FIELD', 'Некорректное значение поля handshake.');
  }
  const token64 = token.toString('base64');
  const fields = [
    `{0,${CLIENT_CONNECTION_ID},${sequence},4,${TESTCLIENT_SUB_ID},0,1,11,0,`,
    '{"S","TestClient:TestClient"},0,',
    `{"#",${STRUCTURE_ID},\r\n{1,${STRUCTURE_VALUE_ID}}\r\n},0,`,
    '{"S","TestController"},0,',
    `{"S","${machine}"},2,`,
    `{"#",${AUTH_TOKEN_BLOCK_ID},\r\n{${token64}}\r\n},1,0,`,
    `{"S","${platformVersion}"},0,`,
    '{"S","1ru"},0,',
    '{"S","1ru_RU"},0,',
    `{"#",${STRUCTURE_ID},\r\n{1,00000000-0000-0000-0000-000000000000}\r\n},1}`,
  ];
  return Buffer.concat([SCOM_BOM, Buffer.from(fields.join('\r\n'), 'utf8'), SCOM_TRAILER]);
}

export function buildSessionInitFrame(sessionId: string, sequence: number): Buffer {
  if (!isGuid(sessionId)) {
    throw new NativeTestClientError('NATIVE_INVALID_SESSION', 'TestClient вернул некорректный session GUID.');
  }
  const body = `{0,${sessionId},${sequence},1,${PROTOCOL_OPCODE_ID}}`;
  return Buffer.concat([SCOM_BOM, Buffer.from(body, 'utf8'), SCOM_TRAILER]);
}

/** Reconstructs the attach RPC field by field; no copied opaque frame template. */
export function buildAttachFrame(sessionId: string): Buffer {
  if (!isGuid(sessionId)) {
    throw new NativeTestClientError('NATIVE_INVALID_SESSION', 'TestClient вернул некорректный session GUID.');
  }
  return Buffer.concat([
    Buffer.from([0x41, 0x95]),
    guidToLittleEndian(sessionId),
    encodeInteger(22552),
    Buffer.from([0x85, 0x95]),
    guidToLittleEndian(RPC_OPCODE),
    FIXED_BINARY_HEADER,
    Buffer.from([0xa3, 0xcb, 0x23, 0x95]),
    guidToLittleEndian(ATTACH_METHOD),
    Buffer.from([0xd5]),
    guidToLittleEndian(ATTACH_HANDLE),
    Buffer.from([0x81, 0x81, 0x81, 0x81, 0xf5]),
    guidToLittleEndian(ATTACH_CONTEXT),
    Buffer.from([0x81, 0x81, 0x20, 0x20, 0x20]),
    SCOM_TRAILER,
  ]);
}

/** Builds a typed binary request without relying on captured full-frame bytes. */
export function buildRpcFrame(options: {
  sessionId: string;
  counter: number;
  methodGuid: string;
  key?: string;
  handle?: string;
  kind?: 'read' | 'action' | 'commit';
  middle?: Buffer;
  result?: 'scalar' | 'collection' | 'none';
  firstBinary?: boolean;
}): Buffer {
  const { sessionId, counter, methodGuid } = options;
  if (!isGuid(sessionId) || !isGuid(methodGuid) || (options.handle !== undefined && !isGuid(options.handle))) {
    throw new NativeTestClientError('NATIVE_INVALID_RPC_ADDRESS', 'Некорректный GUID в адресе TestClient RPC.');
  }
  const kind = options.kind ?? 'read';
  const commit = kind === 'commit';
  const result = options.result ?? 'scalar';
  const middle = options.middle ?? (result === 'collection' ? RESULT_COLLECTION : result === 'scalar' ? RESULT_SCALAR : Buffer.alloc(0));
  const perCall = options.handle ? guidToLittleEndian(options.handle) : guidToLittleEndian(crypto.randomUUID());
  const frame = Buffer.concat([
    Buffer.from([0x41, 0x95]),
    guidToLittleEndian(sessionId),
    encodeInteger(counter & 0xffff),
    Buffer.from([0x81, 0x85, 0x95]),
    guidToLittleEndian(RPC_OPCODE),
    FIXED_BINARY_HEADER,
    Buffer.from([commit ? 0xa1 : 0xa3, 0xcb, 0x23, 0x95]),
    guidToLittleEndian(methodGuid),
    Buffer.from([0xd5]),
    perCall,
    options.key === undefined ? Buffer.from([0x81]) : encodeProtocolString(options.key, 0x90),
    Buffer.from(kind === 'action' ? [0x88, 0x82, 0x81] : commit ? [0x81, 0x81, 0x81] : [0x88, 0x81, 0x81]),
    middle,
    Buffer.alloc(result === 'collection' ? 4 : 3, 0x20),
    SCOM_TRAILER,
  ]);
  if (!options.firstBinary) {return frame;}
  const counterBytes = counter < 256 ? 1 : 2;
  const markerOffset = 2 + 16 + 1 + counterBytes;
  return Buffer.concat([frame.subarray(0, markerOffset), frame.subarray(markerOffset + 1)]);
}

function readGuidBlock(frame: Buffer, guid: string): string | undefined {
  const text = frameText(frame);
  const match = new RegExp(`(?:\\{|,)${escapeRegex(guid)},\\s*\\{([0-9a-fA-F-]{36})\\}`).exec(text);
  return match && isGuid(match[1]) ? match[1].toLowerCase() : undefined;
}

function readAuthToken(frame: Buffer): Buffer | undefined {
  const text = frameText(frame);
  const match = new RegExp(`(?:\\{|,)${escapeRegex(AUTH_TOKEN_BLOCK_ID)},\\s*\\{([A-Za-z0-9+/=\\r\\n]*)\\}`).exec(text);
  if (!match) {return undefined;}
  try {
    return Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  } catch {
    return undefined;
  }
}

function throwIfRejected(frame: Buffer, stage: string): void {
  const text = frameText(frame);
  if (!/^\{2,[0-9a-f-]{36},/i.test(text)) {return;}
  const messages = [...text.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replace(/""/g, '"'));
  const detail = messages.find(Boolean);
  throw new NativeTestClientError('NATIVE_TESTCLIENT_REJECTED', `TestClient отклонил ${stage}${detail ? `: ${detail}` : '.'}`);
}

function assertBinaryReply(frame: Buffer, stage: string): void {
  if (frame[0] === 0x43 && frame.subarray(-SCOM_TRAILER.length).equals(SCOM_TRAILER)) {
    const detail = decodeProtocolError(frame);
    throw new NativeTestClientError(
      'NATIVE_TESTCLIENT_PROTOCOL_ERROR',
      `TestClient отклонил ${stage}: ${detail ?? 'ошибка бинарного потока.'}`,
    );
  }
  if (frame[0] !== 0x42 || !frame.subarray(-SCOM_TRAILER.length).equals(SCOM_TRAILER)) {
    const prefix = frame.subarray(0, Math.min(4, frame.length)).toString('hex');
    const trailer = frame.subarray(-Math.min(4, frame.length)).toString('hex');
    throw new NativeTestClientError(
      'NATIVE_TESTCLIENT_REJECTED',
      `TestClient вернул некорректный бинарный ответ на ${stage} (length=${frame.length}, prefix=${prefix}, tail=${trailer}).`,
    );
  }
  const status = decodeRpcStatus(frame);
  if (status !== undefined && status !== 0) {
    throw new NativeTestClientError('NATIVE_TESTCLIENT_REJECTED', `TestClient отклонил ${stage} (status ${status}).`);
  }
}

function decodeProtocolError(frame: Buffer): string | undefined {
  // Error replies have a distinct 0x43 marker and carry one length-tagged text value
  // after their receiver identifiers. Keep diagnostics to that first field; do not
  // expose trailing platform addresses or application state to Agent callers.
  const text = stringAt(frame, 35);
  if (!text || !text.text || !isPrintableText(text.text)) {return undefined;}
  return text.text;
}

function isPrintableText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {return false;}
  }
  return true;
}

function isNetworkGreeting(frame: Buffer): boolean {
  return frame.length === NETWORK_GREETING.length + SCOM_TRAILER.length
    && frame.subarray(0, NETWORK_GREETING.length).equals(NETWORK_GREETING);
}

function frameText(frame: Buffer): string {
  const body = frame.subarray(frame.subarray(0, 3).equals(SCOM_BOM) ? 3 : 0, -SCOM_TRAILER.length);
  return body.toString('utf8');
}

function machineName(): string {
  return (process.env.COMPUTERNAME || os.hostname()).trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function guidToLittleEndian(value: string): Buffer {
  if (!isGuid(value)) {throw new NativeTestClientError('NATIVE_INVALID_GUID', 'Некорректный GUID.');}
  const bytes = Buffer.from(value.replace(/-/g, ''), 'hex');
  return Buffer.concat([
    Buffer.from([bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6]]),
    bytes.subarray(8),
  ]);
}

function littleEndianToGuid(value: Buffer): string {
  if (value.length !== 16) {throw new Error('A TestClient GUID must contain 16 bytes.');}
  const bytes = Buffer.concat([
    Buffer.from([value[3], value[2], value[1], value[0], value[5], value[4], value[7], value[6]]),
    value.subarray(8),
  ]);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeInteger(value: number): Buffer {
  if (Number.isInteger(value) && value >= 0 && value <= 0xff) {return Buffer.from([0x8b, value]);}
  if (Number.isInteger(value) && value >= 0 && value <= 0xffff) {
    const encoded = Buffer.alloc(3);
    encoded[0] = 0x8d;
    encoded.writeUInt16LE(value, 1);
    return encoded;
  }
  const encoded = Buffer.alloc(5);
  encoded[0] = 0x8f;
  encoded.writeInt32LE(value, 1);
  return encoded;
}

function encodeProtocolString(value: string, family: number): Buffer {
  let payload: Buffer;
  let units: number;
  let utf16 = false;
  try {
    payload = Buffer.from(value, 'latin1');
    if (payload.toString('latin1') !== value) {throw new Error('not latin1');}
    units = payload.length;
  } catch {
    payload = Buffer.from(value, 'utf16le');
    units = payload.length / 2;
    utf16 = true;
  }
  if (units < 0x100) {
    return Buffer.concat([Buffer.from([family | (utf16 ? 0x07 : 0x0a), units]), payload]);
  }
  if (units <= 0xffff) {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(units);
    return Buffer.concat([Buffer.from([family | (utf16 ? 0x08 : 0x0b)]), length, payload]);
  }
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(units));
  return Buffer.concat([Buffer.from([family | (utf16 ? 0x09 : 0x0c)]), length, payload]);
}

function stringAt(raw: Buffer, offset: number, families = [0x90, 0xb0, 0xd0, 0xf0]): { text: string; size: number } | undefined {
  const tag = raw[offset];
  if (tag === undefined || !families.includes(tag & 0xf0)) {return undefined;}
  const low = tag & 0x0f;
  const width = ({ 7: 1, 8: 2, 9: 8, 10: 1, 11: 2, 12: 8 } as Record<number, number>)[low];
  if (!width || offset + 1 + width > raw.length) {return undefined;}
  const countBig = width === 8 ? raw.readBigUInt64LE(offset + 1) : BigInt(width === 1 ? raw[offset + 1] : raw.readUInt16LE(offset + 1));
  if (countBig > BigInt(raw.length)) {return undefined;}
  const count = Number(countBig);
  const header = 1 + width;
  const size = header + count * (low < 10 ? 2 : 1);
  if (offset + size > raw.length) {return undefined;}
  return {
    text: raw.subarray(offset + header, offset + size).toString(low < 10 ? 'utf16le' : 'latin1'),
    size,
  };
}

function valueSizeAt(raw: Buffer, offset: number): number {
  const tag = raw[offset];
  if (tag === 0x8b) {return offset + 2 <= raw.length ? 2 : 0;}
  if (tag === 0x8d) {return offset + 3 <= raw.length ? 3 : 0;}
  if (tag === 0x8f) {return offset + 5 <= raw.length ? 5 : 0;}
  return stringAt(raw, offset)?.size ?? 0;
}

function decodeRpcStatus(frame: Buffer, methodGuid?: string): number | undefined {
  const offset = rpcStatusOffset(frame, methodGuid);
  if (offset === undefined) {return undefined;}
  const tag = frame[offset];
  if (tag >= 0x81 && tag <= 0x8a) {return tag - 0x81;}
  const size = valueSizeAt(frame, offset);
  if (size === 2) {return frame[offset + 1];}
  if (size === 3) {return frame.readUInt16LE(offset + 1);}
  if (size === 5) {return frame.readInt32LE(offset + 1);}
  return undefined;
}

function rpcStatusOffset(frame: Buffer, methodGuid?: string): number | undefined {
  if (frame[0] !== 0x42 || !frame.subarray(-4).equals(SCOM_TRAILER) || frame.length < 50) {return undefined;}
  const counterSize = frame[1] >= 0x81 && frame[1] <= 0x8a ? 1 : valueSizeAt(frame, 1);
  if (!counterSize) {return undefined;}
  let offset = 1 + counterSize;
  if (!frame.subarray(offset, offset + 7).equals(Buffer.from([0x84, 0x83, 0x81, 0x83, 0xcb, 0x23, 0x95]))) {return undefined;}
  offset += 7;
  if (methodGuid && !frame.subarray(offset, offset + 16).equals(guidToLittleEndian(methodGuid))) {return undefined;}
  offset += 16;
  if (frame[offset] !== 0xd5) {return undefined;}
  offset += 17;
  if (frame[offset] !== 0x81 && ![0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c].includes(frame[offset])) {return undefined;}
  const keySize = frame[offset] === 0x81 ? 1 : valueSizeAt(frame, offset);
  if (!keySize || offset + keySize >= frame.length - 4) {return undefined;}
  return offset + keySize;
}

function resultEnd(frame: Buffer): number {
  if (!frame.subarray(-4).equals(SCOM_TRAILER)) {return -1;}
  const end = frame.length - 4;
  return end >= 3 && frame.subarray(end - 3, end).equals(Buffer.from([0x20, 0xa1, 0xa3]))
    ? end - 3
    : -1;
}

interface DecodedObjectRecord {
  key: string;
  handle: string;
  className: string;
  name?: string;
  text?: string;
  type?: string;
}

function decodeObjectRecords(frame: Buffer, parentKey?: string): DecodedObjectRecord[] {
  const end = resultEnd(frame);
  if (end < 0) {throw new NativeTestClientError('NATIVE_INVALID_RPC_REPLY', 'Ответ TestClient не содержит ожидаемый binary reply trailer.');}
  const records: DecodedObjectRecord[] = [];
  const seen = new Set<string>();
  const spans = findObjectKeySpans(frame, end);
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    const decoded = span.key;
    if (decoded === parentKey || seen.has(decoded)) {continue;}
    const last = /(?:^|\.)([A-Za-z][A-Za-z0-9]*)(?:\[([^\x5d]*)\])?$/.exec(decoded);
    if (!last) {continue;}
    const className = last[1];
    const recordEnd = index + 1 < spans.length ? spans[index + 1].offset - 16 : end;
    const recordStart = span.offset + span.size;
    const boundedEnd = Math.max(recordStart, recordEnd);
    const title = readRecordStringValue(frame, recordStart, boundedEnd);
    const name = readRecordStringValue(frame, title.nextOffset, boundedEnd);
    const type = readRecordType(frame, name.nextOffset, boundedEnd, className);
    records.push({
      key: decoded,
      handle: span.handle,
      className,
      ...(last[2] !== undefined ? { name: last[2] } : {}),
      ...(title.value !== undefined && title.value !== '' ? { text: title.value } : {}),
      ...(type !== undefined ? { type } : {}),
    });
    seen.add(decoded);
  }
  return records;
}

interface ObjectKeySpan {
  offset: number;
  size: number;
  key: string;
  handle: string;
}

function findObjectKeySpans(frame: Buffer, end: number): ObjectKeySpan[] {
  const spans: ObjectKeySpan[] = [];
  let offset = 0;
  let captionOffset = -1;
  while (offset < end - 1) {
    const decoded = stringAt(frame, offset);
    if (decoded && offset === captionOffset) {
      offset += decoded.size;
      captionOffset = -1;
      continue;
    }
    if (decoded && OBJECT_KEY.test(decoded.text) && offset >= 16) {
      spans.push({
        offset,
        size: decoded.size,
        key: decoded.text,
        handle: littleEndianToGuid(frame.subarray(offset - 16, offset)),
      });
      offset += decoded.size;
      captionOffset = offset + ([0x81, 0x82].includes(frame[offset]) ? 1 : 0);
      continue;
    }
    offset += 1;
  }
  return spans;
}

function readRecordStringValue(frame: Buffer, start: number, end: number): { value?: string; nextOffset: number } {
  let offset = start;
  if (frame[offset] === 0x81 || frame[offset] === 0x82) {offset += 1;}
  if (offset >= end) {return { nextOffset: start };}
  if (frame[offset] === 0xe1) {return { value: '', nextOffset: offset + 1 };}
  const value = stringAt(frame, offset, [0xf0]);
  if (value && offset + value.size <= end) {return { value: value.text, nextOffset: offset + value.size };}
  return { nextOffset: offset };
}

function readRecordType(frame: Buffer, start: number, end: number, className: string): string | undefined {
  if (className !== 'EditField' || start >= end) {return undefined;}
  let slotOffset = start;
  if (frame[slotOffset] === 0x81 || frame[slotOffset] === 0x82) {slotOffset += 1;}
  const directType = inputFieldType(frame[slotOffset]);
  if (directType) {return directType;}
  const anchor = Buffer.from([0x20, 0xa1]);
  const anchorOffset = frame.indexOf(anchor, start);
  if (anchorOffset < start || anchorOffset >= end) {return undefined;}
  const typeCodeOffset = [1, 2, 3, 4].map((distance) => anchorOffset - distance)
    .find((offset) => offset >= start && frame[offset] >= 0xe0 && frame[offset] <= 0xef);
  if (typeCodeOffset === undefined) {return undefined;}
  return inputFieldType(frame[typeCodeOffset]);
}

function inputFieldType(typeCode: number): string | undefined {
  const types: Record<number, string> = {
    0xe2: 'LabelField',
    0xe3: 'InputField',
    0xe4: 'CheckBoxField',
    0xe5: 'PictureField',
    0xe6: 'RadioButtonField',
    0xe7: 'SpreadsheetDocumentField',
    0xe8: 'TextDocumentField',
    0xe9: 'CalendarField',
    0xea: 'ProgressBarField',
  };
  return types[typeCode];
}

function decodeScalarText(frame: Buffer, methodGuid: string, allowConfirmedEmptyInput = false): string | undefined {
  const statusOffset = rpcStatusOffset(frame, methodGuid);
  const end = resultEnd(frame);
  if (statusOffset === undefined || end < statusOffset) {return undefined;}
  let start = statusOffset;
  if (frame.subarray(start, start + 3).equals(Buffer.from([0x81, 0x81, 0x81]))) {start += 3;}
  else {return undefined;}
  if (frame.subarray(start, start + 4).equals(Buffer.from([0xe0, 0x41, 0x81, 0x81]))) {start += 4;}
  if (allowConfirmedEmptyInput && start + 1 === end && frame[start] === 0xe1) {return '';}
  const value = stringAt(frame, start, [0xb0, 0x90, 0xf0]);
  return value && start + value.size <= end ? value.text : undefined;
}

function abortedError(): Error {
  const error = new Error('Подключение к TestClient отменено.');
  error.name = 'AbortError';
  return error;
}

async function connectSocket(options: NativeFormsConnectionOptions, signal?: AbortSignal): Promise<net.Socket> {
  if (signal?.aborted) {throw abortedError();}
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host: options.host, port: options.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new NativeTestClientError('NATIVE_CONNECT_TIMEOUT', 'Таймаут подключения к порту TestClient.'));
    }, options.timeoutMs);
    const onAbort = () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(abortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(new NativeTestClientError('NATIVE_CONNECT_FAILED', `Не удалось подключиться к TestClient ${options.host}:${options.port}: ${error.message}`));
    });
  });
}

class NativeTestClientSession implements NativeFormsSession {
  private counter = 100;
  // Windows SSPI sessions use the normal opcode prefix; only direct-session
  // bootstrap negotiation consumes the special first-binary marker variant.
  private firstBinary = false;
  private readonly objectByRef = new Map<string, { key: string; handle: string; record: DecodedObjectRecord }>();

  constructor(
    private readonly channel: NativeTestClientChannel,
    readonly host: string,
    readonly port: number,
    readonly sessionId: string,
    private readonly authenticator?: SspiAuthenticator,
  ) {}

  get connected(): boolean {
    return this.channel.connected;
  }

  async execute(action: NativeFormsAction, options: NativeFormsExecuteOptions): Promise<NativeFormsActionResult> {
    switch (action.action) {
      case 'overview':
        return this.overview(action.maxDepth ?? 3, action.maxNodes ?? 100, options);
      case 'find': {
        const overview = await this.overview(4, 300, options);
        return { matches: flatten(overview.activeWindow).filter((object) => matchesObject(object, action)) };
      }
      case 'readField': {
        const target = this.requireObject(action.ref.id);
        const reply = await this.rpc(GET_EDIT_TEXT, target, 'read', RESULT_SCALAR, options);
        const text = decodeScalarText(reply, GET_EDIT_TEXT, target.type === 'InputField');
        if (text === undefined) {throw new NativeTestClientError('NATIVE_INVALID_RPC_REPLY', 'Не удалось прочитать текст элемента формы.');}
        return { ref: action.ref, text };
      }
      case 'writeField': {
        if (typeof action.value !== 'string') {
          throw new NativeTestClientError('NATIVE_UNSUPPORTED_VALUE', 'Нативный writeField сейчас принимает только строковое значение.');
        }
        const target = this.requireObject(action.ref.id);
        const method = action.value === '' ? CLEAR : INPUT_TEXT;
        const argument = action.value === ''
          ? Buffer.alloc(0)
          : Buffer.concat([Buffer.from([0xe0, 0x41, 0x81, 0x81]), encodeProtocolString(action.value, 0xb0)]);
        for (const kind of ['action', 'commit'] as const) {
          await this.rpc(method, target, kind, argument, options, true, 'none');
        }
        const reply = await this.rpc(GET_EDIT_TEXT, target, 'read', RESULT_SCALAR, options, true);
        const text = decodeScalarText(reply, GET_EDIT_TEXT, target.type === 'InputField');
        if (text === undefined) {
          this.channel.close();
          throw new NativeTestClientError('FORMS_OPERATION_IN_DOUBT', 'Изменение отправлено, но TestClient не вернул проверяемое значение поля.', true);
        }
        return { ref: action.ref, accepted: text === action.value, text };
      }
      case 'act': {
        const target = this.requireObject(action.ref.id);
        const method = action.method === 'activate'
          ? ACTIVATE
          : target.className === 'EditField' || target.className === 'Group'
            ? CLICK_FIELD
            : target.className === 'Button'
              ? CLICK
              : undefined;
        if (!method) {
          throw new NativeTestClientError('NATIVE_UNSUPPORTED_ACTION_TARGET', `Нельзя выполнить click для объекта класса ${target.className}.`);
        }
        for (const kind of ['action', 'commit'] as const) {
          await this.rpc(method, target, kind, Buffer.alloc(0), options, true, 'none');
        }
        return { ref: action.ref, performed: true };
      }
      default:
        return assertNever(action);
    }
  }

  async close(): Promise<void> {
    this.channel.close();
    await this.authenticator?.dispose();
  }

  private async overview(maxDepth: number, maxNodes: number, options: NativeFormsExecuteOptions): Promise<NativeFormsOverviewResult> {
    const safeDepth = Math.max(0, Math.min(10, Math.floor(maxDepth)));
    const safeNodes = Math.max(1, Math.min(1000, Math.floor(maxNodes)));
    this.objectByRef.clear();
    const rootReply = await this.rpc(GET_ACTIVE_WINDOW, undefined, 'read', RESULT_COLLECTION, options, false, 'collection');
    const [active] = decodeObjectRecords(rootReply);
    if (!active) {throw new NativeTestClientError('NATIVE_ACTIVE_WINDOW_NOT_FOUND', 'TestClient не вернул активное окно.');}
    const root = this.asPublicObject(active);
    let count = 1;
    let truncated = false;
    const visit = async (parent: DecodedObjectRecord, object: NativeFormsObject, depth: number): Promise<void> => {
      if (depth >= safeDepth) {
        if (depth === safeDepth) {truncated = true;}
        return;
      }
      const reply = await this.rpc(GET_CHILD_OBJECTS, parent, 'read', CHILD_OBJECTS_REQUEST, options);
      const children = decodeObjectRecords(reply, parent.key);
      object.children = [];
      for (const child of children) {
        if (count >= safeNodes) {
          truncated = true;
          break;
        }
        count += 1;
        const publicChild = this.asPublicObject(child);
        object.children.push(publicChild);
        await visit(child, publicChild, depth + 1);
      }
    };
    await visit(active, root, 0);
    return { activeWindow: root, truncated };
  }

  private asPublicObject(record: DecodedObjectRecord): NativeFormsObject {
    const ref = crypto.randomUUID();
    this.objectByRef.set(ref, { key: record.key, handle: record.handle, record });
    return {
      ref: { id: ref },
      className: record.className,
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.text !== undefined ? { text: record.text } : {}),
    };
  }

  private requireObject(ref: string): DecodedObjectRecord {
    const target = this.objectByRef.get(ref);
    if (!target) {throw new NativeTestClientError('NATIVE_STALE_OBJECT_REF', 'Объект формы не найден в текущей native-сессии; запросите overview повторно.');}
    return target.record;
  }

  private async rpc(
    methodGuid: string,
    target: { key: string; handle: string } | undefined,
    kind: 'read' | 'action' | 'commit',
    middle: Buffer,
    options: NativeFormsExecuteOptions,
    mutating = false,
    result: 'scalar' | 'collection' | 'none' = 'scalar',
  ): Promise<Buffer> {
    this.counter = (this.counter + 1) & 0xffff;
    const frame = buildRpcFrame({
      sessionId: this.sessionId,
      counter: this.counter,
      methodGuid,
      key: target?.key,
      handle: target?.handle,
      kind,
      middle,
      result,
      firstBinary: this.firstBinary,
    });
    this.firstBinary = false;
    let requestMayHaveBeenSent = false;
    try {
      requestMayHaveBeenSent = true;
      await this.channel.sendFrame(frame, true, options.signal);
      let reply: Buffer | undefined;
      for (let frameIndex = 0; frameIndex < 16; frameIndex += 1) {
        const incoming = await this.channel.readFrame(true, options.timeoutMs, options.signal);
        if (incoming[0] === 0x42) {
          reply = incoming;
          break;
        }
        assertBinaryReply(incoming, 'RPC');
      }
      if (!reply) {
        this.channel.close();
        throw new NativeTestClientError('NATIVE_RPC_EVENT_LIMIT', 'TestClient отправил слишком много асинхронных кадров без ответа на RPC.');
      }
      assertBinaryReply(reply, 'RPC');
      const status = decodeRpcStatus(reply, methodGuid);
      if (status !== undefined && status !== 0) {
        throw new NativeTestClientError('NATIVE_OPERATION_REJECTED', `TestClient отклонил действие (status ${status}).`);
      }
      return reply;
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      const rejected = reason instanceof NativeTestClientError && reason.code === 'NATIVE_OPERATION_REJECTED';
      const alreadyInDoubt = reason instanceof NativeTestClientError && reason.code === 'FORMS_OPERATION_IN_DOUBT';
      if (mutating && requestMayHaveBeenSent && !rejected && !alreadyInDoubt) {
        this.channel.close();
        throw new NativeTestClientError('FORMS_OPERATION_IN_DOUBT', 'Ответ на изменяющее действие не получен; соединение закрыто, эффект операции неизвестен.', true);
      }
      throw error;
    }
  }
}

function flatten(root: NativeFormsObject): NativeFormsObject[] {
  const result: NativeFormsObject[] = [];
  const visit = (object: NativeFormsObject) => {
    result.push(object);
    object.children?.forEach(visit);
  };
  visit(root);
  return result;
}

function matchesObject(
  object: NativeFormsObject,
  filter: { name?: string; className?: string; text?: string; exact?: boolean },
): boolean {
  const matches = (actual: string | undefined, expected: string | undefined) => {
    if (expected === undefined) {return true;}
    return filter.exact ? actual === expected : Boolean(actual?.toLocaleLowerCase().includes(expected.toLocaleLowerCase()));
  };
  return matches(object.name, filter.name) && matches(object.className, filter.className) && matches(object.text, filter.text);
}

function assertNever(value: never): never {
  throw new NativeTestClientError('NATIVE_UNSUPPORTED_ACTION', `Неизвестное действие: ${String(value)}`);
}
