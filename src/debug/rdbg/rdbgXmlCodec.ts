/**
 * XML encoder/decoder for the RDBG protocol (1C Enterprise Remote Debugger).
 *
 * HTTP POST  http://host:1550/e1crdbg/rdbg?cmd={command}&dbgui={uuid}
 *
 * Namespaces:
 *   default / root element: http://v8.1c.ru/8.3/debugger/debugBaseData
 *   rdbg prefix:            http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse
 *
 * Encode functions use template strings (NOT XMLBuilder) because fast-xml-parser
 * builder cannot produce namespace-prefixed child elements like <rdbg:foo>.
 * Decode functions use XMLParser with removeNSPrefix: true.
 *
 * Tested against a live 1C debug server. Fields marked TODO were not yet
 * confirmed with a real server response.
 */

import { XMLParser } from 'fast-xml-parser';
import {
  RdbgTargetInfo,
  RdbgBreakpointRequest,
  RdbgBreakpoint,
  RdbgCallStackItem,
  RdbgVariable,
  RdbgEvalResult,
  RdbgModuleId,
  RdbgRuntimeError,
} from './rdbgTypes';
import {
  RdbgEvent,
  RdbgStoppedEvent,
} from './rdbgEvents';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NS_BASE = 'http://v8.1c.ru/8.3/debugger/debugBaseData';
const NS_RDBG = 'http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse';
const NS_XSI  = 'http://www.w3.org/2001/XMLSchema-instance';
const DEF_ALIAS = 'DefAlias';

const NS_CALC = 'http://v8.1c.ru/8.3/debugger/debugCalculations';

/** Standard namespace declarations for the <request> root element. */
const REQUEST_NS_ATTRS =
  `xmlns="${NS_BASE}" xmlns:rdbg="${NS_RDBG}" xmlns:bp="http://v8.1c.ru/8.3/debugger/debugBreakpoints" xmlns:calc="${NS_CALC}" xmlns:xsi="${NS_XSI}"`;

// ---------------------------------------------------------------------------
// Parser instance
// ---------------------------------------------------------------------------

const RDBG_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  parseTrueNumberOnly: false,
  removeNSPrefix: true,   // strip "rdbg:", "xsi:", "cfg:" etc. from tag names
  allowBooleanAttributes: true,
};

const parser = new XMLParser(RDBG_PARSER_OPTIONS);

// ---------------------------------------------------------------------------
// Internal helpers — encode side
// ---------------------------------------------------------------------------

/** Escape special XML characters in a string value. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wrap field XML into the standard <request> envelope.
 * @param xsiType   e.g. "rdbg:RDBGAttachDebugUIRequest"
 * @param fields    inner XML string with rdbg:-prefixed elements
 */
function wrapRequest(xsiType: string, fields: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<request ${REQUEST_NS_ATTRS} xsi:type="${escapeXml(xsiType)}">
${fields}</request>`;
}

/** Serialize a module ID to bp: prefixed XML fragment (BSLModuleIdInternal). */
function moduleIdToXml(mid: RdbgModuleId, indent: string): string {
  const ext = mid.extensionName
    ? `${indent}    <extensionName>${escapeXml(mid.extensionName)}</extensionName>\n`
    : '';
  return `${indent}<bp:id xsi:type="BSLModuleIdInternal">\n` +
    `${indent}  <objectID>${escapeXml(mid.objectId)}</objectID>\n` +
    `${indent}  <propertyID>${escapeXml(mid.propertyId)}</propertyID>\n` +
    ext +
    `${indent}</bp:id>\n`;
}


/** Serialize a target ID for step/continue/eval RDBG requests. */
function targetIdToXml(id: string, indent: string): string {
  return `${indent}<rdbg:targetID>\n` +
    `${indent}  <id>${escapeXml(id)}</id>\n` +
    `${indent}</rdbg:targetID>\n`;
}

/** Serialize a target ID as rdbg:id for getCallStack RDBG requests. */
function targetIdAsIdToXml(id: string, indent: string): string {
  return `${indent}<rdbg:id>\n` +
    `${indent}  <id>${escapeXml(id)}</id>\n` +
    `${indent}</rdbg:id>\n`;
}

// ---------------------------------------------------------------------------
// Internal helpers — decode side
// ---------------------------------------------------------------------------

/** Wrap raw value in an array, handling the fast-xml-parser single-item quirk. */
function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) { return []; }
  return Array.isArray(x) ? x : [x];
}

/** Parse XML string, throw with context on failure. */
function parseXml(xml: string): Record<string, unknown> {
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `RDBG XML parse error: ${err instanceof Error ? err.message : String(err)} — ${xml.slice(0, 200)}`
    );
  }
}

/** Parse a module ID element from the parsed XML (after removeNSPrefix). */
function parseModuleId(raw: Record<string, unknown>): RdbgModuleId {
  const version = raw['version'] !== undefined ? String(raw['version']) : undefined;
  return {
    objectId: String(raw['objectID'] ?? raw['objectId'] ?? ''),
    propertyId: String(raw['propertyID'] ?? raw['propertyId'] ?? ''),
    extensionName: raw['extensionName'] as string | undefined,
    version,
  };
}

/** Parse a targetID element (used in events and call stack). */
function parseTargetId(raw: Record<string, unknown>): RdbgTargetInfo {
  return {
    id: String(raw['id'] ?? ''),
    seanceId: String(raw['seanceId'] ?? ''),
    userName: String(raw['userName'] ?? ''),
    targetType: raw['targetType'] !== undefined ? String(raw['targetType']) : 0,
    infobaseAlias: String(raw['infoBaseAlias'] ?? raw['infobaseAlias'] ?? DEF_ALIAS),
  };
}

/** Decode a base64-encoded UTF-8 string from the server. */
function decodeBase64Utf8(s: string): string {
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// ENCODE — TypeScript → XML string (template strings, no XMLBuilder)
// ---------------------------------------------------------------------------

/**
 * AttachDebugUI — register this debug UI with the server.
 * Verified format: xsi:type="rdbg:RDBGAttachDebugUIRequest"
 */
export function encodeAttachDebugUI(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n`;
  return wrapRequest('rdbg:RDBGAttachDebugUIRequest', fields);
}

/**
 * DetachDebugUI — unregister this debug UI.
 * xsi:type="rdbg:RDBGDetachDebugUIRequest"
 */
export function encodeDetachDebugUI(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n`;
  return wrapRequest('rdbg:RDBGDetachDebugUIRequest', fields);
}

/**
 * Ping — poll for asynchronous events.
 * xsi:type="rdbg:RDBGPingDebugUIRequest"
 * HTTP 204 (no content) means no events.
 */
export function encodePing(debugUiId: string): string {
  const fields = `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n`;
  return wrapRequest('rdbg:RDBGPingDebugUIRequest', fields);
}

/**
 * InitSettings — send initial debug settings to the server.
 * xsi:type="rdbg:RDBGSetInitialDebugSettingsRequest"
 */
export function encodeInitSettings(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n`;
  return wrapRequest('rdbg:RDBGSetInitialDebugSettingsRequest', fields);
}

/**
 * SetAutoAttachSettings — configure auto-attach behaviour for new targets.
 * xsi:type="rdbg:RDBGSetAutoAttachSettingsRequest"
 */
export function encodeSetAutoAttachSettings(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n`;
  return wrapRequest('rdbg:RDBGSetAutoAttachSettingsRequest', fields);
}

/**
 * GetTargets — retrieve the list of currently attached debug targets.
 * xsi:type="rdbg:RDBGGetDbgTargetsRequest"
 */
export function encodeGetTargets(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n`;
  return wrapRequest('rdbg:RDBGGetDbgTargetsRequest', fields);
}

/**
 * SetBreakpoints — send a list of breakpoints to the server.
 * xsi:type="rdbg:RDBGSetBreakpointsRequest"
 * TODO: exact wrapper element name (bpWorkspace vs bpWorkspaceInternal) not yet confirmed.
 */
export function encodeSetBreakpoints(
  debugUiId: string,
  bps: RdbgBreakpointRequest[],
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  let fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n`;

  for (const bp of bps) {
    fields +=
      `  <rdbg:bpWorkspace xsi:type="bp:BPWorkspaceInternal">\n` +
      `    <bp:moduleBPInfo>\n` +
      moduleIdToXml(bp.moduleId, '      ') +
      `      <bp:bpInfo>\n` +
      `        <bp:line>${bp.lineNo}</bp:line>\n` +
      `      </bp:bpInfo>\n` +
      `    </bp:moduleBPInfo>\n` +
      `  </rdbg:bpWorkspace>\n`;
  }

  return wrapRequest('rdbg:RDBGSetBreakpointsRequest', fields);
}

/**
 * Step — single-step execution (into / over / out).
 * xsi:type="rdbg:RDBGStepRequest"
 * HTTP cmd name: "step" (same endpoint for continue with action Continue).
 */
export function encodeStep(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  action: 'into' | 'over' | 'out',
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  // Matches 1C DebugStepAction (yukon39/bsl-debug-server): Step = step over, StepIn / StepOut.
  const actionMap: Record<string, string> = {
    over: 'Step',
    into: 'StepIn',
    out: 'StepOut',
  };
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    targetIdToXml(targetId, '  ') +
    `  <rdbg:action>${escapeXml(actionMap[action])}</rdbg:action>\n`;
  return wrapRequest('rdbg:RDBGStepRequest', fields);
}

/**
 * Continue — resume execution after a break.
 * Fallback: uses RDBGStepRequest with action=Continue until the exact command is confirmed.
 * TODO: verify whether this is a separate command or action value "Continue"/"go".
 */
export function encodeContinue(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    targetIdToXml(targetId, '  ') +
    `  <rdbg:action>Continue</rdbg:action>\n`; // TODO: may be "go", "resume", or numeric
  return wrapRequest('rdbg:RDBGStepRequest', fields);
}

/**
 * GetCallStack — request the current call stack for a target.
 * xsi:type="rdbg:RDBGGetCallStackRequest"
 * TODO: exact field set not yet confirmed with a live response.
 */
export function encodeGetCallStack(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    targetIdAsIdToXml(targetId, '  ');
  return wrapRequest('rdbg:RDBGGetCallStackRequest', fields);
}

/**
 * EvalLocalVariables — get local variables at a specific stack frame.
 * xsi:type="rdbg:RDBGEvalLocalVariablesRequest"
 * Expr list items are CalculationSourceDataStorage (yukon39): calc:stackLevel only is valid.
 * Do not add xsi:type on &lt;rdbg:expr&gt; — JAXB reference impl does not; a mismatched QName
 * has been observed to reset the TCP connection and kill dbgs (ECONNRESET → ECONNREFUSED on ping).
 * No root-level callStackLevel (HTTP 400 XDTO).
 */
export function encodeEvalLocalVariables(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  frameIndex: number,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>\n` +
    targetIdToXml(targetId, '  ') +
    `  <rdbg:expr>\n` +
    `    <calc:stackLevel>${frameIndex}</calc:stackLevel>\n` +
    `  </rdbg:expr>\n`;
  return wrapRequest('rdbg:RDBGEvalLocalVariablesRequest', fields);
}

/**
 * Evaluate — RDBGEvalExprRequest (same expr shape as RDBGEvalLocalVariablesRequest in yukon39).
 * HTTP cmd: "evalExpr" (not evaluateRequest).
 */
export function encodeEvaluate(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  expression: string,
  frameIndex: number,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:calcWaitingTime>5000</rdbg:calcWaitingTime>\n` +
    targetIdToXml(targetId, '  ') +
    `  <rdbg:expr>\n` +
    `    <calc:stackLevel>${frameIndex}</calc:stackLevel>\n` +
    `    <calc:srcCalcInfo>\n` +
    `      <calc:calcItem>\n` +
    `        <calc:itemType>expression</calc:itemType>\n` +
    `        <calc:expression>${escapeXml(expression)}</calc:expression>\n` +
    `      </calc:calcItem>\n` +
    `    </calc:srcCalcInfo>\n` +
    `  </rdbg:expr>\n`;
  return wrapRequest('rdbg:RDBGEvalExprRequest', fields);
}

/** Target identifier carrying both id and seanceId for attach/detach operations. */
export interface RdbgTargetRef {
  id: string;
  seanceId: string;
}

/**
 * AttachTargets / DetachTargets — attach or detach specific debug targets.
 * xsi:type="rdbg:RDBGAttachDetachDebugTargetsRequest"
 * TODO: exact structure of targetID list and attach/detach flag not yet confirmed.
 */
export function encodeAttachTargets(
  debugUiId: string,
  targets: RdbgTargetRef[],
  attach: boolean,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  let fields =
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:attach>${attach}</rdbg:attach>\n`; // TODO: may be separate attach/detach commands

  for (const target of targets) {
    fields +=
      `  <rdbg:id>\n` +
      `    <id>${escapeXml(target.id)}</id>\n` +
      `  </rdbg:id>\n`;
  }

  return wrapRequest('rdbg:RDBGAttachDetachDebugTargetsRequest', fields);
}

// ---------------------------------------------------------------------------
// DECODE — XML string → TypeScript types (XMLParser with removeNSPrefix: true)
// ---------------------------------------------------------------------------

/**
 * Decode the list of debug targets from a GetTargets response.
 * TODO: exact wrapper element name (item / targets / target) not yet confirmed.
 */
export function decodeTargets(xml: string): RdbgTargetInfo[] {
  const root = parseXml(xml);
  const response = (root['response'] ?? root['result'] ?? {}) as Record<string, unknown>;
  const items = toArray(response['item'] ?? response['targets'] ?? response['target']);

  return items.map((raw) => {
    const r = raw as Record<string, unknown>;
    const targetIdEl = (r['targetID'] ?? r['id'] ?? {}) as Record<string, unknown>;
    return {
      id: String(targetIdEl['id'] ?? r['id'] ?? ''),
      seanceId: String(targetIdEl['seanceId'] ?? r['seanceId'] ?? ''),
      userName: String(r['userName'] ?? r['user'] ?? ''),
      targetType: Number(r['targetType'] ?? r['type'] ?? 0),
      infobaseAlias: String(r['infoBaseAlias'] ?? r['infobaseAlias'] ?? DEF_ALIAS),
    };
  });
}

/**
 * Decode confirmed breakpoints from a SetBreakpoints response.
 * TODO: wrapper element name not yet confirmed.
 */
export function decodeBreakpoints(xml: string): RdbgBreakpoint[] {
  const root = parseXml(xml);
  const response = (root['response'] ?? root['result'] ?? {}) as Record<string, unknown>;
  const items = toArray(
    response['item'] ??
    response['breakpoints'] ??
    response['bpWorkspace'] ??
    response['bpWorkspaceInternal']
  );

  return items.map((raw) => {
    const r = raw as Record<string, unknown>;
    const bpEl = (r['breakpoint'] ?? r) as Record<string, unknown>;
    const moduleRaw = (bpEl['moduleID'] ?? bpEl['moduleId'] ?? {}) as Record<string, unknown>;
    return {
      moduleId: parseModuleId(moduleRaw),
      lineNo: Number(bpEl['lineNo'] ?? 0),
      enabled: bpEl['enable'] !== 'false' && bpEl['enable'] !== false,
    };
  });
}

/** Map one RDBG stack frame element (ping or getCallStack) to RdbgCallStackItem. */
function mapRawCallStackFrame(raw: Record<string, unknown>): RdbgCallStackItem {
  const moduleRaw = (raw['moduleID'] ?? raw['moduleId'] ?? {}) as Record<string, unknown>;
  const presentationRaw = String(raw['presentation'] ?? '');
  const presentation = presentationRaw ? decodeBase64Utf8(presentationRaw) : '';
  return {
    moduleId: parseModuleId(moduleRaw),
    lineNo: Number(raw['lineNo'] ?? 0),
    presentation,
  };
}

/**
 * Normalize a callStack field from parsed XML to a flat list of frame records
 * (handles repeated elements, item/frame wrappers, and single-frame objects).
 */
function flattenCallStackElements(callStackField: unknown): Record<string, unknown>[] {
  if (callStackField === undefined || callStackField === null) {
    return [];
  }
  const isFrameLike = (o: Record<string, unknown>): boolean =>
    o['moduleID'] !== undefined ||
    o['moduleId'] !== undefined ||
    o['lineNo'] !== undefined ||
    o['presentation'] !== undefined;

  const normalizeOne = (el: unknown): Record<string, unknown>[] => {
    if (!el || typeof el !== 'object') {
      return [];
    }
    const o = el as Record<string, unknown>;
    const nested = o['item'] ?? o['frame'];
    if (nested !== undefined) {
      return toArray(nested).flatMap((x) => normalizeOne(x));
    }
    if (isFrameLike(o)) {
      return [o];
    }
    return [];
  };

  return toArray(callStackField).flatMap((el) => normalizeOne(el));
}

/**
 * Decode the call stack from a GetCallStack HTTP response.
 * Also handles: nested result.callStack, single frame as object (no item wrapper), base64 presentation.
 */
export function decodeCallStack(xml: string): RdbgCallStackItem[] {
  if (!xml || !xml.trim()) {
    return [];
  }
  const root = parseXml(xml);
  const top = (root['response'] ?? root) as Record<string, unknown>;
  let holder: Record<string, unknown> = top;
  const res = top['result'];
  if (res && typeof res === 'object' && !Array.isArray(res)) {
    const r = res as Record<string, unknown>;
    if (r['callStack'] !== undefined || r['callstack'] !== undefined) {
      holder = r;
    }
  }
  const csKey = holder['callStack'] !== undefined ? 'callStack' : 'callstack';
  const csNode: unknown = holder[csKey] ?? top['callStack'] ?? top['callstack'];

  let frames = flattenCallStackElements(csNode);
  if (frames.length === 0) {
    frames = flattenCallStackElements(top['item']);
  }

  return frames.map((raw) => mapRawCallStackFrame(raw));
}

/**
 * Decode local variables from RDBGEvalLocalVariablesResponse.
 * Platform returns a single CalculationResultBaseData in result; locals live in
 * calculationResult.valueOfContextPropInfo[] (propInfo + valueInfo), see yukon39 model.
 */
export function decodeVariables(xml: string): RdbgVariable[] {
  if (!xml || !xml.trim()) {
    return [];
  }
  const root = parseXml(xml);
  const response = (root['response'] ?? root) as Record<string, unknown>;
  const rawResult = response['result'] ?? response;
  const resultParts = toArray(
    rawResult as Record<string, unknown> | Record<string, unknown>[] | undefined
  );
  const result = (resultParts[0] ?? {}) as Record<string, unknown>;

  const calcResult = (result['calculationResult'] ?? {}) as Record<string, unknown>;
  const fromContext = toArray(calcResult['valueOfContextPropInfo']);
  if (fromContext.length > 0) {
    return fromContext.map((raw, idx) => {
      const r = raw as Record<string, unknown>;
      const propInfo = (r['propInfo'] ?? {}) as Record<string, unknown>;
      const valueInfo = (r['valueInfo'] ?? {}) as Record<string, unknown>;
      const name = String(propInfo['propName'] ?? `var${idx}`);
      const presRaw = valueInfo['pres'];
      const fromPres =
        typeof presRaw === 'string' && presRaw.length > 0 ? decodeBase64Utf8(presRaw) : '';
      const value = String(
        valueInfo['valueString'] ?? valueInfo['presentation'] ?? (fromPres || '')
      );
      const typeName = String(valueInfo['typeName'] ?? '');
      const isExpandable =
        valueInfo['isExpandable'] === true || valueInfo['isExpandable'] === 'true';
      return {
        name,
        typeName,
        value,
        isExpandable,
        variableReference: 0,
      };
    });
  }

  // Legacy / alternate shapes
  const container = (
    response['localVariables'] ??
    response['variables'] ??
    result
  ) as Record<string, unknown>;
  const items = toArray(
    container['variable'] ?? container['localVar'] ?? container['item']
  );

  return items.map((raw, idx) => {
    const r = raw as Record<string, unknown>;
    return {
      name: String(r['name'] ?? `var${idx}`),
      typeName: String(r['typeName'] ?? r['type'] ?? ''),
      value: String(r['value'] ?? r['presentation'] ?? ''),
      isExpandable: r['isExpandable'] === true || r['isExpandable'] === 'true',
      variableReference: Number(r['variableReference'] ?? r['varRef'] ?? 0),
    };
  });
}

/**
 * Decode RDBGEvalExprResponse: result is CalculationResultBaseData[] (yukon39).
 */
export function decodeEvalResult(xml: string): RdbgEvalResult {
  const root = parseXml(xml);
  const response = (root['response'] ?? {}) as Record<string, unknown>;
  const rawResult = response['result'] ?? response;
  const items = toArray(rawResult as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const result = (items[0] ?? {}) as Record<string, unknown>;

  const errOccurred = result['errorOccurred'] === true || result['errorOccurred'] === 'true';
  const exceptionStr = result['exceptionStr'];
  const rvi = (result['resultValueInfo'] ?? {}) as Record<string, unknown>;
  const presRaw = rvi['pres'];
  const fromPres =
    typeof presRaw === 'string' && presRaw.length > 0 ? decodeBase64Utf8(presRaw) : '';
  const value = String(
    rvi['valueString'] ??
      rvi['presentation'] ??
      result['value'] ??
      result['presentation'] ??
      (fromPres || '')
  );
  const typeName = String(rvi['typeName'] ?? result['typeName'] ?? result['type'] ?? '');
  const isExpandable = rvi['isExpandable'] === true || rvi['isExpandable'] === 'true';
  const legacyErr = result['error'] ?? result['errorDescription'];

  let error: string | undefined;
  if (legacyErr !== undefined && legacyErr !== null && String(legacyErr).length > 0) {
    error = String(legacyErr);
  } else if (errOccurred) {
    const ex =
      typeof exceptionStr === 'string' && exceptionStr.length > 0
        ? decodeBase64Utf8(exceptionStr)
        : '';
    error = ex.length > 0 ? ex : 'Evaluation error';
  }

  return {
    value,
    typeName,
    isExpandable,
    error,
  };
}

/**
 * Decode asynchronous events from a Ping response.
 * Returns [] for HTTP 204 (empty body) or a response with no events.
 *
 * xsi:type mapping (after removeNSPrefix strips the namespace):
 *   DBGUIExtCmdInfoCallStackFormed → stopped
 *   DBGUIExtCmdInfoStarted         → targetStarted
 *   DBGUIExtCmdInfoQuit            → targetQuit
 *   DBGUIExtCmdInfoRte             → runtimeError
 *   DBGUIExtCmdInfoExprEvaluated   → expressionEvaluated
 *   DBGUIExtCmdInfoCorrectedBP     → breakpointCorrected
 */
export function decodePingEvents(xml: string): RdbgEvent[] {
  // HTTP 204 → empty body — no events
  if (!xml || xml.trim() === '') {
    return [];
  }

  const root = parseXml(xml);
  const response = (root['response'] ?? {}) as Record<string, unknown>;

  // Each event is a <result xsi:type="..."> element.
  // After removeNSPrefix: xsi:type attribute becomes @_type.
  const results = toArray(response['result']);

  return results.flatMap((raw): RdbgEvent[] => {
    const r = raw as Record<string, unknown>;
    const rawType = String(r['@_type'] ?? r['type'] ?? '');
    const xsiType = rawType.includes(':') ? rawType.split(':').pop()! : rawType;
    const targetIdEl = (r['targetID'] ?? r['id'] ?? {}) as Record<string, unknown>;
    const targetInfo = parseTargetId(targetIdEl);
    const targetId = targetInfo.id;

    switch (xsiType) {
      case 'DBGUIExtCmdInfoCallStackFormed': {
        // stopByBP: true → breakpoint, false → step; rteInfo present → exception
        let reason: RdbgStoppedEvent['reason'];
        if (r['rteInfo']) {
          reason = 'exception';
        } else if (String(r['stopByBP']) === 'true') {
          reason = 'breakpoint';
        } else {
          reason = 'step';
        }

        const frameRaws = flattenCallStackElements(r['callStack']);
        const callStack = frameRaws.map((cs) => mapRawCallStackFrame(cs));

        return [{
          type: 'stopped',
          targetId,
          reason,
          callStack: callStack.length > 0 ? callStack : undefined,
        }];
      }

      case 'DBGUIExtCmdInfoStarted': {
        const tEl = (r['targetID'] ?? {}) as Record<string, unknown>;
        const target = parseTargetId(tEl);
        return [{
          type: 'targetStarted',
          target,
        }];
      }

      case 'DBGUIExtCmdInfoQuit': {
        return [{
          type: 'targetQuit',
          targetId,
        }];
      }

      case 'DBGUIExtCmdInfoRte': {
        const rteEl = (r['rteInfo'] ?? r) as Record<string, unknown>;
        const moduleRaw = (rteEl['moduleID'] ?? rteEl['moduleId'] ?? {}) as Record<string, unknown>;
        const rteError: RdbgRuntimeError = {
          description: String(rteEl['description'] ?? rteEl['errorDescription'] ?? ''),
          moduleId: parseModuleId(moduleRaw),
          lineNo: Number(rteEl['lineNo'] ?? 0),
        };
        return [{
          type: 'runtimeError',
          targetId,
          error: rteError,
        }];
      }

      case 'DBGUIExtCmdInfoExprEvaluated': {
        const evalRaw = (r['expressionResultID'] ?? r['result'] ?? r) as Record<string, unknown>;
        return [{
          type: 'expressionEvaluated',
          targetId,
          result: {
            value: String(evalRaw['value'] ?? evalRaw['presentation'] ?? ''),
            typeName: String(evalRaw['typeName'] ?? evalRaw['type'] ?? ''),
            isExpandable: evalRaw['isExpandable'] === true || evalRaw['isExpandable'] === 'true',
            error: evalRaw['error'] ? String(evalRaw['error']) : undefined,
          },
        }];
      }

      case 'DBGUIExtCmdInfoCorrectedBP': {
        const srcBp = (r['bpSource'] ?? r['original'] ?? {}) as Record<string, unknown>;
        const dstBp = (r['bpTarget'] ?? r['corrected'] ?? {}) as Record<string, unknown>;
        const srcModule = parseModuleId((srcBp['moduleID'] ?? srcBp['moduleId'] ?? {}) as Record<string, unknown>);
        const dstModule = parseModuleId((dstBp['moduleID'] ?? dstBp['moduleId'] ?? {}) as Record<string, unknown>);
        return [{
          type: 'breakpointCorrected',
          original: {
            moduleId: srcModule,
            lineNo: Number(srcBp['lineNo'] ?? 0),
          },
          corrected: {
            moduleId: dstModule,
            lineNo: Number(dstBp['lineNo'] ?? 0),
            enabled: dstBp['enable'] !== 'false' && dstBp['enable'] !== false,
          },
        }];
      }

      default:
        // Unknown or unhandled event type — silently skip
        return [];
    }
  });
}
