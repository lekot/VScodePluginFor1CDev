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

/** Standard namespace declarations for the <request> root element. */
const REQUEST_NS_ATTRS =
  `xmlns="${NS_BASE}" xmlns:rdbg="${NS_RDBG}" xmlns:xsi="${NS_XSI}"`;

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

/** Serialize a module ID to rdbg: prefixed XML fragment. */
function moduleIdToXml(mid: RdbgModuleId, indent: string): string {
  const ext = mid.extensionName
    ? `${indent}  <rdbg:extensionName>${escapeXml(mid.extensionName)}</rdbg:extensionName>\n`
    : '';
  return `${indent}<rdbg:moduleID>\n` +
    `${indent}  <rdbg:objectID>${escapeXml(mid.objectId)}</rdbg:objectID>\n` +
    `${indent}  <rdbg:propertyID>${escapeXml(mid.propertyId)}</rdbg:propertyID>\n` +
    ext +
    `${indent}</rdbg:moduleID>\n`;
}

/** Serialize a target ID to rdbg: prefixed XML fragment. */
function targetIdToXml(id: string, seanceId: string, indent: string): string {
  return `${indent}<rdbg:targetID>\n` +
    `${indent}  <rdbg:id>${escapeXml(id)}</rdbg:id>\n` +
    `${indent}  <rdbg:seanceId>${escapeXml(seanceId)}</rdbg:seanceId>\n` +
    `${indent}</rdbg:targetID>\n`;
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
  return {
    objectId: String(raw['objectID'] ?? raw['objectId'] ?? ''),
    propertyId: String(raw['propertyID'] ?? raw['propertyId'] ?? ''),
    extensionName: raw['extensionName'] as string | undefined,
  };
}

/** Parse a targetID element (used in events and call stack). */
function parseTargetId(raw: Record<string, unknown>): { id: string; seanceId: string } {
  return {
    id: String(raw['id'] ?? ''),
    seanceId: String(raw['seanceId'] ?? ''),
  };
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
 * GetTargets — retrieve the list of currently attached debug targets.
 * xsi:type="rdbg:RDBGGetDbgTargetsRequest"
 */
export function encodeGetTargets(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n`;
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
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n`;

  // TODO: verify wrapper element name — may be bpWorkspace or bpWorkspaceInternal
  for (const bp of bps) {
    fields +=
      `  <rdbg:bpWorkspace>\n` +
      `    <rdbg:breakpoint>\n` +
      moduleIdToXml(bp.moduleId, '      ') +
      `      <rdbg:lineNo>${bp.lineNo}</rdbg:lineNo>\n` +
      `    </rdbg:breakpoint>\n` +
      `  </rdbg:bpWorkspace>\n`;
  }

  return wrapRequest('rdbg:RDBGSetBreakpointsRequest', fields);
}

/**
 * Step — single-step execution (into / over / out).
 * xsi:type="rdbg:RDBGStepRequest"
 * TODO: confirm action string values vs numeric codes.
 */
export function encodeStep(
  debugUiId: string,
  targetId: string,
  action: 'into' | 'over' | 'out',
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const actionMap: Record<string, string> = {
    into: 'Step',
    over: 'StepOver',
    out: 'StepOut',
  };
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    // TODO: targetID structure may need seanceId as well
    targetIdToXml(targetId, '', '  ') +
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
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    targetIdToXml(targetId, '', '  ') +
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
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    targetIdToXml(targetId, '', '  ');
  return wrapRequest('rdbg:RDBGGetCallStackRequest', fields);
}

/**
 * EvalLocalVariables — get local variables at a specific stack frame.
 * xsi:type="rdbg:RDBGEvalLocalVariablesRequest"
 * TODO: field name for frame index (callStackLevel vs stackLevel vs frameIndex).
 */
export function encodeEvalLocalVariables(
  debugUiId: string,
  targetId: string,
  frameIndex: number,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    targetIdToXml(targetId, '', '  ') +
    `  <rdbg:callStackLevel>${frameIndex}</rdbg:callStackLevel>\n`; // TODO: verify field name
  return wrapRequest('rdbg:RDBGEvalLocalVariablesRequest', fields);
}

/**
 * Evaluate — evaluate an arbitrary expression in the context of a stack frame.
 * xsi:type="rdbg:RDBGEvalExprRequest"
 * TODO: field name for frame index, expression wrapper element name.
 */
export function encodeEvaluate(
  debugUiId: string,
  targetId: string,
  expression: string,
  frameIndex: number,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    targetIdToXml(targetId, '', '  ') +
    `  <rdbg:expression>${escapeXml(expression)}</rdbg:expression>\n` +
    `  <rdbg:callStackLevel>${frameIndex}</rdbg:callStackLevel>\n`; // TODO: verify field name
  return wrapRequest('rdbg:RDBGEvalExprRequest', fields);
}

/**
 * AttachTargets / DetachTargets — attach or detach specific debug targets.
 * xsi:type="rdbg:RDBGAttachDetachDebugTargetsRequest"
 * TODO: exact structure of targetID list and attach/detach flag not yet confirmed.
 */
export function encodeAttachTargets(
  debugUiId: string,
  targetIds: string[],
  attach: boolean,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  let fields =
    `  <rdbg:idOfDebuggerUI>${escapeXml(debugUiId)}</rdbg:idOfDebuggerUI>\n` +
    `  <rdbg:infoBaseAlias>${escapeXml(alias)}</rdbg:infoBaseAlias>\n` +
    `  <rdbg:attach>${attach}</rdbg:attach>\n`; // TODO: may be separate attach/detach commands

  // TODO: verify structure — seanceId may also be required in targetID
  for (const id of targetIds) {
    fields += targetIdToXml(id, '', '  ');
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

/**
 * Decode the call stack from a GetCallStack response.
 * TODO: exact element names (callStack / item / frame) not yet confirmed.
 */
export function decodeCallStack(xml: string): RdbgCallStackItem[] {
  const root = parseXml(xml);
  const response = (root['response'] ?? root['result'] ?? {}) as Record<string, unknown>;
  const callStack = (response['callStack'] ?? response['callstack'] ?? {}) as Record<string, unknown>;
  const items = toArray(callStack['item'] ?? callStack['frame'] ?? response['item']);

  return items.map((raw) => {
    const r = raw as Record<string, unknown>;
    const moduleRaw = (r['moduleID'] ?? r['moduleId'] ?? {}) as Record<string, unknown>;
    return {
      moduleId: parseModuleId(moduleRaw),
      lineNo: Number(r['lineNo'] ?? 0),
      presentation: String(r['presentation'] ?? ''),
    };
  });
}

/**
 * Decode local variables from an EvalLocalVariables response.
 * TODO: element names (localVariables / variable / item / localVar) not yet confirmed.
 */
export function decodeVariables(xml: string): RdbgVariable[] {
  const root = parseXml(xml);
  const response = (root['response'] ?? root['result'] ?? {}) as Record<string, unknown>;
  const container = (
    response['localVariables'] ??
    response['variables'] ??
    response
  ) as Record<string, unknown>;
  const items = toArray(
    container['variable'] ??
    container['localVar'] ??
    container['item']
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
 * Decode an expression evaluation result.
 * TODO: error field name and structure not yet confirmed.
 */
export function decodeEvalResult(xml: string): RdbgEvalResult {
  const root = parseXml(xml);
  const response = (root['response'] ?? {}) as Record<string, unknown>;
  const result = (response['result'] ?? response) as Record<string, unknown>;

  const error = result['error'] ?? result['errorDescription'];
  return {
    value: String(result['value'] ?? result['presentation'] ?? ''),
    typeName: String(result['typeName'] ?? result['type'] ?? ''),
    isExpandable: result['isExpandable'] === true || result['isExpandable'] === 'true',
    error: error !== undefined ? String(error) : undefined,
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
    const xsiType = String(r['@_type'] ?? r['type'] ?? '');
    const targetIdEl = (r['targetID'] ?? r['id'] ?? {}) as Record<string, unknown>;
    const { id: targetId } = parseTargetId(targetIdEl);

    switch (xsiType) {
      case 'DBGUIExtCmdInfoCallStackFormed': {
        const reason: RdbgStoppedEvent['reason'] = r['rteInfo'] ? 'exception' : 'breakpoint';
        return [{
          type: 'stopped',
          targetId,
          reason,
        }];
      }

      case 'DBGUIExtCmdInfoStarted': {
        const tEl = (r['targetID'] ?? {}) as Record<string, unknown>;
        return [{
          type: 'targetStarted',
          target: {
            id: String(tEl['id'] ?? targetId),
            seanceId: String(tEl['seanceId'] ?? ''),
            userName: String(r['userName'] ?? ''),
            targetType: Number(r['targetType'] ?? 0),
            infobaseAlias: String(r['infoBaseAlias'] ?? DEF_ALIAS),
          },
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
