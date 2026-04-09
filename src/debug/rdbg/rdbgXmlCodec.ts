/**
 * XML encoder/decoder for the RDBG protocol (1C Enterprise Remote Debugger).
 *
 * HTTP POST  http://host:1550/e1crdbg/rdbg?cmd={command}&dbgui={uuid}
 *
 * Namespaces:
 *   default / root element: http://v8.1c.ru/8.3/debugger/debugBaseData
 *   debugRDBGRequestResponse: http://v8.1c.ru/8.3/debugger/debugRDBGRequestResponse
 *   debugCalculations:        http://v8.1c.ru/8.3/debugger/debugCalculations
 *   debugBreakpoints:         http://v8.1c.ru/8.3/debugger/debugBreakpoints
 *
 * Encode functions use template strings (NOT XMLBuilder) because fast-xml-parser
 * builder cannot produce namespace-prefixed child elements.
 * Decode functions use XMLParser with removeNSPrefix: true.
 *
 * Namespace prefixes match the 1C Configurator (Wireshark reference):
 *   debugRDBGRequestResponse instead of rdbg
 *   debugCalculations instead of calc
 *   debugBreakpoints instead of bp
 *
 * Tested against a live 1C debug server. Fields marked TODO were not yet
 * confirmed with a real server response.
 */

import * as crypto from 'crypto';
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
const NS_CALC = 'http://v8.1c.ru/8.3/debugger/debugCalculations';
const NS_BP   = 'http://v8.1c.ru/8.3/debugger/debugBreakpoints';
const NS_CFG  = 'http://v8.1c.ru/8.1/data/enterprise/current-config';
const NS_V8   = 'http://v8.1c.ru/8.1/data/core';
const NS_XS   = 'http://www.w3.org/2001/XMLSchema';
const NS_XSI  = 'http://www.w3.org/2001/XMLSchema-instance';
const DEF_ALIAS = 'DefAlias';

// Namespace prefix constants — match the 1C Configurator reference (Wireshark capture).
const P_RDBG = 'debugRDBGRequestResponse';
const P_CALC = 'debugCalculations';
const P_BP   = 'debugBreakpoints';

/** Standard namespace declarations for the <request> root element. */
const REQUEST_NS_ATTRS =
  `xmlns="${NS_BASE}"` +
  ` xmlns:${P_RDBG}="${NS_RDBG}"` +
  ` xmlns:${P_BP}="${NS_BP}"` +
  ` xmlns:${P_CALC}="${NS_CALC}"` +
  ` xmlns:cfg="${NS_CFG}"` +
  ` xmlns:v8="${NS_V8}"` +
  ` xmlns:xs="${NS_XS}"` +
  ` xmlns:xsi="${NS_XSI}"`;

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
 * xsi:type is required for most requests (attachDebugUI, ping, setBreakpoints, step, etc.)
 * but the Configurator omits it for evalExpr (Wireshark capture). Pass undefined to omit.
 */
function wrapRequest(fields: string, xsiType?: string): string {
  const typeAttr = xsiType ? ` xsi:type="${escapeXml(xsiType)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<request ${REQUEST_NS_ATTRS}${typeAttr}>
${fields}</request>`;
}

/** Serialize a module ID to debugBreakpoints: prefixed XML fragment (BSLModuleIdInternal). */
function moduleIdToXml(mid: RdbgModuleId, indent: string): string {
  const ext = mid.extensionName
    ? `${indent}    <extensionName>${escapeXml(mid.extensionName)}</extensionName>\n`
    : '';
  return `${indent}<${P_BP}:id xsi:type="BSLModuleIdInternal">\n` +
    `${indent}  <objectID>${escapeXml(mid.objectId)}</objectID>\n` +
    `${indent}  <propertyID>${escapeXml(mid.propertyId)}</propertyID>\n` +
    ext +
    `${indent}</${P_BP}:id>\n`;
}


/**
 * Serialize a target ID WITH xsi:type for step/continue (proven to work with platform).
 * JAXB reference omits xsi:type, but 1C platform accepts it for step — keep for safety.
 */
function targetIdTypedToXml(id: string, indent: string): string {
  return `${indent}<${P_RDBG}:targetID xsi:type="DebugTargetIdLight">\n` +
    `${indent}  <id>${escapeXml(id)}</id>\n` +
    `${indent}</${P_RDBG}:targetID>\n`;
}

/** Serialize a target ID WITHOUT xsi:type for eval requests (xsi:type crashes dbgs). */
function targetIdToXml(id: string, indent: string): string {
  return `${indent}<${P_RDBG}:targetID>\n` +
    `${indent}  <id>${escapeXml(id)}</id>\n` +
    `${indent}</${P_RDBG}:targetID>\n`;
}

/** Serialize a target ID as debugRDBGRequestResponse:id WITHOUT xsi:type for getCallStack. */
function targetIdAsIdToXml(id: string, indent: string): string {
  return `${indent}<${P_RDBG}:id>\n` +
    `${indent}  <id>${escapeXml(id)}</id>\n` +
    `${indent}</${P_RDBG}:id>\n`;
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
    // Canonical field names from BslModuleIdInternal: XmlElementAttribute("objectID") / XmlElementAttribute("propertyID")
    objectId: String(raw['objectID'] ?? ''),
    propertyId: String(raw['propertyID'] ?? ''),
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
    // Canonical: XmlElementAttribute("infoBaseAlias") in DebugTargetId
    infobaseAlias: String(raw['infoBaseAlias'] ?? DEF_ALIAS),
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
 */
export function encodeAttachDebugUI(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGAttachDebugUIRequest`);
}

/**
 * DetachDebugUI — unregister this debug UI.
 */
export function encodeDetachDebugUI(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGDetachDebugUIRequest`);
}

/**
 * Ping — poll for asynchronous events.
 * HTTP 204 (no content) means no events.
 */
export function encodePing(debugUiId: string): string {
  const fields = `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGPingDebugUIRequest`);
}

/**
 * InitSettings — send initial debug settings to the server.
 */
export function encodeInitSettings(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGSetInitialDebugSettingsRequest`);
}

/**
 * SetAutoAttachSettings — configure auto-attach behaviour for new targets.
 */
export function encodeSetAutoAttachSettings(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n` +
    `  <${P_RDBG}:autoAttachIdleTargets>true</${P_RDBG}:autoAttachIdleTargets>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGSetAutoAttachSettingsRequest`);
}

/**
 * GetTargets — retrieve the list of currently attached debug targets.
 */
export function encodeGetTargets(debugUiId: string, infobaseAlias?: string): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGGetDbgTargetsRequest`);
}

/**
 * SetBreakpoints — send a list of breakpoints to the server.
 * One bpWorkspace contains one moduleBPInfo per unique module, each with multiple bpInfo entries.
 * Confirmed format: matches yukon39/bsl-debug-server reference implementation.
 */
export function encodeSetBreakpoints(
  debugUiId: string,
  bps: RdbgBreakpointRequest[],
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  let fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n`;

  // Group breakpoints by module (extensionName + objectId + propertyId).
  // extensionName is included in the key so that a BP in an extension module
  // and a BP in the base config module with the same objectId/propertyId are
  // not merged into the same moduleBPInfo block.
  const byModule = new Map<string, { moduleId: RdbgModuleId; bps: RdbgBreakpointRequest[] }>();
  for (const bp of bps) {
    const key = `${bp.moduleId.extensionName ?? ''}|${bp.moduleId.objectId}|${bp.moduleId.propertyId}`;
    let entry = byModule.get(key);
    if (!entry) {
      entry = { moduleId: bp.moduleId, bps: [] };
      byModule.set(key, entry);
    }
    entry.bps.push(bp);
  }

  if (byModule.size > 0) {
    fields += `  <${P_RDBG}:bpWorkspace xsi:type="${P_BP}:BPWorkspaceInternal">\n`;
    for (const { moduleId, bps: moduleBps } of byModule.values()) {
      fields += `    <${P_BP}:moduleBPInfo>\n` +
        moduleIdToXml(moduleId, '      ');
      for (const bp of moduleBps) {
        fields += `      <${P_BP}:bpInfo>\n` +
          `        <${P_BP}:line>${bp.lineNo}</${P_BP}:line>\n`;
        // isActive — only emit if explicitly set (platform defaults to true)
        if (bp.isActive !== undefined) {
          fields += `        <${P_BP}:isActive>${bp.isActive}</${P_BP}:isActive>\n`;
        }
        // Condition
        if (bp.condition !== undefined && bp.condition !== '') {
          fields += `        <${P_BP}:breakOnCondition>true</${P_BP}:breakOnCondition>\n` +
            `        <${P_BP}:condition>${escapeXml(bp.condition)}</${P_BP}:condition>\n`;
        }
        // Hit count — hitCountVariant comes BEFORE hitCount (per Messages.cs XmlElement order).
        // FIXME(hitCountVariant) OQ-8: Messages.cs:3535 declares hitCountVariant as `decimal`,
        // but RdbgBreakpointRequest.hitCountVariant is a string union ('eq'|'ge'|'multipleOf').
        // Sending a string into a decimal field will be rejected by the platform XSD.
        // akpaevj StoppingManager never sets this field — leaves the server default of 0.
        // Until we can map our string variants to real numeric codes (Wireshark trace needed),
        // BslDebugSession (P2C3) MUST NOT pass hitCountVariant in RdbgBreakpointRequest.
        // The encoder still emits it if explicitly set so that future fixes can use one place.
        if (bp.hitCount !== undefined && bp.hitCount > 0) {
          fields += `        <${P_BP}:breakOnHitCount>true</${P_BP}:breakOnHitCount>\n`;
          if (bp.hitCountVariant !== undefined) {
            fields += `        <${P_BP}:hitCountVariant>${escapeXml(bp.hitCountVariant)}</${P_BP}:hitCountVariant>\n`;
          }
          fields += `        <${P_BP}:hitCount>${bp.hitCount}</${P_BP}:hitCount>\n`;
        }
        // Log message / logpoint
        if (bp.logMessage !== undefined && bp.logMessage !== '') {
          fields += `        <${P_BP}:showOutputMessage>true</${P_BP}:showOutputMessage>\n` +
            `        <${P_BP}:putExpressionResult>${escapeXml(bp.logMessage)}</${P_BP}:putExpressionResult>\n` +
            `        <${P_BP}:continueExecution>true</${P_BP}:continueExecution>\n`;
        }
        fields += `      </${P_BP}:bpInfo>\n`;
      }
      fields += `    </${P_BP}:moduleBPInfo>\n`;
    }
    fields += `  </${P_RDBG}:bpWorkspace>\n`;
  }

  return wrapRequest(fields, `${P_RDBG}:RDBGSetBreakpointsRequest`);
}

/**
 * Step — single-step execution (into / over / out).
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
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n` +
    targetIdTypedToXml(targetId, '  ') +
    `  <${P_RDBG}:action>${escapeXml(actionMap[action])}</${P_RDBG}:action>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGStepRequest`);
}

/**
 * Continue — resume execution after a break.
 * Uses the same "step" endpoint as encodeStep, with action=Continue.
 * Confirmed: DebugStepAction enum in Messages.cs lists {Unknown, Step, StepIn, StepOut, Continue}.
 * There is no separate HTTP command for continue — "step" cmd with action Continue is the protocol.
 */
export function encodeContinue(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n` +
    targetIdTypedToXml(targetId, '  ') +
    `  <${P_RDBG}:action>Continue</${P_RDBG}:action>\n`;
  return wrapRequest(fields, `${P_RDBG}:RDBGStepRequest`);
}

/**
 * GetCallStack — request the current call stack for a target.
 * Confirmed: RDBGGetCallStackRequest (Messages.cs line 5836) contains a single <id> element
 * of type DebugTargetIdLight — matched by targetIdAsIdToXml.
 */
export function encodeGetCallStack(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n` +
    targetIdAsIdToXml(targetId, '  ');
  return wrapRequest(fields, `${P_RDBG}:RDBGGetCallStackRequest`);
}

/**
 * EvalLocalVariables — get local variables at a specific stack frame.
 * Expr contains only stackLevel (no srcCalcInfo) — platform returns all locals.
 * No xsi:type on <expr> — mismatched QName resets the TCP connection and kills dbgs.
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
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n` +
    `  <${P_RDBG}:calcWaitingTime>100</${P_RDBG}:calcWaitingTime>\n` +
    targetIdToXml(targetId, '  ') +
    `  <${P_RDBG}:expr>\n` +
    `    <${P_CALC}:stackLevel>${frameIndex}</${P_CALC}:stackLevel>\n` +
    `  </${P_RDBG}:expr>\n`;
  return wrapRequest(fields);
}

/**
 * Evaluate — evalExpr request matching the 1C Configurator Wireshark reference.
 * HTTP cmd: "evalExpr".
 * Format: srcCalcInfo with expressionID + expressionResultID (UUIDs) + interfaces=context.
 * No stackLevel in evalExpr — only srcCalcInfo (Configurator reference does not include it).
 */
export function encodeEvaluate(
  debugUiId: string,
  targetId: string,
  _seanceId: string,
  expression: string,
  _frameIndex: number,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  const exprId = crypto.randomUUID();
  const resultId = crypto.randomUUID();
  const fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n` +
    `  <${P_RDBG}:calcWaitingTime>100</${P_RDBG}:calcWaitingTime>\n` +
    targetIdToXml(targetId, '  ') +
    `  <${P_RDBG}:expr>\n` +
    `    <${P_CALC}:srcCalcInfo>\n` +
    `      <${P_CALC}:expressionID>${exprId}</${P_CALC}:expressionID>\n` +
    `      <${P_CALC}:expressionResultID>${resultId}</${P_CALC}:expressionResultID>\n` +
    `      <${P_CALC}:calcItem>\n` +
    `        <${P_CALC}:itemType>expression</${P_CALC}:itemType>\n` +
    `        <${P_CALC}:expression>${escapeXml(expression)}</${P_CALC}:expression>\n` +
    `      </${P_CALC}:calcItem>\n` +
    `      <${P_CALC}:interfaces>context</${P_CALC}:interfaces>\n` +
    `    </${P_CALC}:srcCalcInfo>\n` +
    `  </${P_RDBG}:expr>\n`;
  return wrapRequest(fields);
}

/** Target identifier carrying both id and seanceId for attach/detach operations. */
export interface RdbgTargetRef {
  id: string;
  seanceId: string;
}

/**
 * AttachTargets / DetachTargets — attach or detach specific debug targets.
 * Confirmed: RDBGAttachDetachDebugTargetsRequest (Messages.cs line 5574) uses:
 *   - <attach> bool flag (not separate attach/detach commands)
 *   - repeated <id> elements of type DebugTargetIdLight
 * HTTP cmd: "attachDetachDbgTargets" (DebugServerClient.cs line 159).
 */
export function encodeAttachTargets(
  debugUiId: string,
  targets: RdbgTargetRef[],
  attach: boolean,
  infobaseAlias?: string
): string {
  const alias = infobaseAlias ?? DEF_ALIAS;
  let fields =
    `  <${P_RDBG}:infoBaseAlias>${escapeXml(alias)}</${P_RDBG}:infoBaseAlias>\n` +
    `  <${P_RDBG}:idOfDebuggerUI>${escapeXml(debugUiId)}</${P_RDBG}:idOfDebuggerUI>\n` +
    `  <${P_RDBG}:attach>${attach}</${P_RDBG}:attach>\n`;

  for (const target of targets) {
    fields +=
      `  <${P_RDBG}:id>\n` +
      `    <id>${escapeXml(target.id)}</id>\n` +
      `  </${P_RDBG}:id>\n`;
  }

  return wrapRequest(fields, `${P_RDBG}:RDBGAttachDetachDebugTargetsRequest`);
}

// ---------------------------------------------------------------------------
// DECODE — XML string → TypeScript types (XMLParser with removeNSPrefix: true)
// ---------------------------------------------------------------------------

/**
 * Decode the list of debug targets from a GetTargets response.
 * Canonical: RdbgsGetDbgTargetsResponse (Messages.cs line 5383) uses repeated <id> elements
 * of type DebugTargetId (which extends DebugTargetIdLight with <id>).
 * Fields of DebugTargetId: id, seanceId, infoBaseAlias, userName, targetType.
 */
export function decodeTargets(xml: string): RdbgTargetInfo[] {
  const root = parseXml(xml);
  const response = (root['response'] ?? root['result'] ?? {}) as Record<string, unknown>;
  // Canonical element name is "id" (XmlElementAttribute("id") on the DebugTargetId collection)
  const items = toArray(response['id']);

  return items.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r['id'] ?? ''),
      seanceId: String(r['seanceId'] ?? ''),
      userName: String(r['userName'] ?? ''),
      targetType: Number(r['targetType'] ?? 0),
      infobaseAlias: String(r['infoBaseAlias'] ?? DEF_ALIAS),
    };
  });
}

/**
 * Decode confirmed breakpoints from a SetBreakpoints response.
 * Canonical: RdbgGetBreakpointsResponse (Messages.cs line 5700) uses XmlArray("bpWorkspace")
 * with XmlArrayItem("moduleBPInfo"). Each moduleBPInfo (ModuleBPInfoInternal) has:
 *   - <id> (BslModuleIdInternal) — the module id
 *   - <bpInfo>[] (BreakpointInfo) — each with <line> and <isActive>
 * Note: BreakpointInfo uses <line> (not lineNo) and <isActive> (not enable).
 */
export function decodeBreakpoints(xml: string): RdbgBreakpoint[] {
  const root = parseXml(xml);
  const response = (root['response'] ?? root['result'] ?? {}) as Record<string, unknown>;
  // Canonical: bpWorkspace is an XmlArray wrapper containing moduleBPInfo elements
  const bpWorkspace = (response['bpWorkspace'] ?? {}) as Record<string, unknown>;
  const moduleBpInfoItems = toArray(bpWorkspace['moduleBPInfo']);

  const result: RdbgBreakpoint[] = [];
  for (const raw of moduleBpInfoItems) {
    const r = raw as Record<string, unknown>;
    // Canonical: ModuleBPInfoInternal.Id uses XmlElementAttribute("id")
    const moduleRaw = (r['id'] ?? {}) as Record<string, unknown>;
    const moduleId = parseModuleId(moduleRaw);
    const bpInfoItems = toArray(r['bpInfo']);
    for (const bpRaw of bpInfoItems) {
      const bp = bpRaw as Record<string, unknown>;
      result.push({
        moduleId,
        // Canonical: BreakpointInfo uses <line> (not lineNo) and <isActive> (not enable)
        lineNo: Number(bp['line'] ?? 0),
        enabled: bp['isActive'] !== 'false' && bp['isActive'] !== false,
      });
    }
  }
  return result;
}

/** Map one RDBG stack frame element (ping or getCallStack) to RdbgCallStackItem. */
function mapRawCallStackFrame(raw: Record<string, unknown>): RdbgCallStackItem {
  // Canonical: XmlElementAttribute("moduleID") in StackItemViewInfoData; XmlElementAttribute("presentation", base64Binary)
  const moduleRaw = (raw['moduleID'] ?? {}) as Record<string, unknown>;
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
  // Canonical field names from StackItemViewInfoData: moduleID, lineNo, presentation
  const isFrameLike = (o: Record<string, unknown>): boolean =>
    o['moduleID'] !== undefined ||
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
      // valueString is base64Binary per BaseValueInfoData — decode if present, else fall back to pres
      const valueStringRaw = valueInfo['valueString'];
      const fromValueString =
        typeof valueStringRaw === 'string' && valueStringRaw.length > 0
          ? decodeBase64Utf8(valueStringRaw)
          : '';
      const value = String(fromValueString || fromPres || '');
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
  // exceptionStr is base64Binary per CalculationResultBaseData — decode it
  const exceptionStrRaw = result['exceptionStr'];
  const rvi = (result['resultValueInfo'] ?? {}) as Record<string, unknown>;
  const presRaw = rvi['pres'];
  const fromPres =
    typeof presRaw === 'string' && presRaw.length > 0 ? decodeBase64Utf8(presRaw) : '';
  // valueString is base64Binary per BaseValueInfoData — decode if present, then fall back to pres
  const valueStringRaw = rvi['valueString'];
  const fromValueString =
    typeof valueStringRaw === 'string' && valueStringRaw.length > 0
      ? decodeBase64Utf8(valueStringRaw)
      : '';
  const value = String(fromValueString || fromPres || '');
  const typeName = String(rvi['typeName'] ?? '');
  const isExpandable = rvi['isExpandable'] === true || rvi['isExpandable'] === 'true';
  // No legacy fallback fields in canonical CalculationResultBaseData — errorOccurred + exceptionStr is the only error path
  let error: string | undefined;
  if (errOccurred) {
    const ex =
      typeof exceptionStrRaw === 'string' && exceptionStrRaw.length > 0
        ? decodeBase64Utf8(exceptionStrRaw)
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
        // stopByBP: true → breakpoint, false → step.
        // Exceptions arrive via separate DBGUIExtCmdInfoRte event (Messages.cs:4248),
        // not via this CallStackFormed event — etalon DbguiExtCmdInfoCallStackFormed
        // (Messages.cs:4325) does not contain any exception field.
        const reason: RdbgStoppedEvent['reason'] =
          String(r['stopByBP']) === 'true' ? 'breakpoint' : 'step';

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
        // Canonical: DbguiExtCmdInfoRte has <exception> (RuntimeException, GenericException base)
        // and repeated <callStack> (StackItemViewInfoData). moduleId/lineNo come from callStack[0].
        const exceptionEl = (r['exception'] ?? {}) as Record<string, unknown>;
        const rteFrames = flattenCallStackElements(r['callStack']);
        const rteTopFrame = rteFrames[0];
        const rteError: RdbgRuntimeError = {
          // GenericException uses <descr> (XmlElementAttribute("descr"))
          description: String(exceptionEl['descr'] ?? ''),
          moduleId: rteTopFrame ? parseModuleId((rteTopFrame['moduleID'] ?? {}) as Record<string, unknown>) : parseModuleId({}),
          lineNo: rteTopFrame ? Number(rteTopFrame['lineNo'] ?? 0) : 0,
        };
        return [{
          type: 'runtimeError',
          targetId,
          error: rteError,
        }];
      }

      case 'DBGUIExtCmdInfoExprEvaluated': {
        // Canonical: DbguiExtCmdInfoExprEvaluated has <evalExprResBaseData> (CalculationResultBaseData)
        // which contains <resultValueInfo> (BaseValueInfoData) and <errorOccurred> + <exceptionStr>
        const calcResult = (r['evalExprResBaseData'] ?? {}) as Record<string, unknown>;
        const rvi2 = (calcResult['resultValueInfo'] ?? {}) as Record<string, unknown>;
        const pres2Raw = rvi2['pres'];
        const fromPres2 =
          typeof pres2Raw === 'string' && pres2Raw.length > 0 ? decodeBase64Utf8(pres2Raw) : '';
        const vsRaw2 = rvi2['valueString'];
        const fromVs2 =
          typeof vsRaw2 === 'string' && vsRaw2.length > 0 ? decodeBase64Utf8(vsRaw2) : '';
        const errOccurred2 = calcResult['errorOccurred'] === true || calcResult['errorOccurred'] === 'true';
        const exStr2 = calcResult['exceptionStr'];
        let evalError: string | undefined;
        if (errOccurred2) {
          const ex2 =
            typeof exStr2 === 'string' && exStr2.length > 0 ? decodeBase64Utf8(exStr2) : '';
          evalError = ex2.length > 0 ? ex2 : 'Evaluation error';
        }
        return [{
          type: 'expressionEvaluated',
          targetId,
          result: {
            value: String(fromVs2 || fromPres2 || ''),
            typeName: String(rvi2['typeName'] ?? ''),
            isExpandable: rvi2['isExpandable'] === true || rvi2['isExpandable'] === 'true',
            error: evalError,
          },
        }];
      }

      case 'DBGUIExtCmdInfoCorrectedBP': {
        // Canonical: DbguiExtCmdInfoCorrectedBp has <bpWorkspace> XmlArray → <moduleBPInfo>[] (ModuleBPInfoInternal).
        // Each moduleBPInfo has <id> (BslModuleIdInternal) and <bpInfo>[] (BreakpointInfo with <line> and <isActive>).
        // There is no bpSource/bpTarget in the etalon — bpWorkspace is the list of corrected breakpoints.
        // For now, emit one event using the first moduleBPInfo/bpInfo pair as a best-effort mapping.
        const bpWs = (r['bpWorkspace'] ?? {}) as Record<string, unknown>;
        const mods = toArray(bpWs['moduleBPInfo']);
        if (mods.length === 0) { return []; }
        const firstMod = mods[0] as Record<string, unknown>;
        const modId = parseModuleId((firstMod['id'] ?? {}) as Record<string, unknown>);
        const bpInfos = toArray(firstMod['bpInfo']);
        const firstBp = bpInfos.length > 0 ? bpInfos[0] as Record<string, unknown> : {};
        return [{
          type: 'breakpointCorrected',
          original: {
            moduleId: modId,
            lineNo: Number(firstBp['line'] ?? 0),
          },
          corrected: {
            moduleId: modId,
            // Canonical: BreakpointInfo uses <line> and <isActive>
            lineNo: Number(firstBp['line'] ?? 0),
            enabled: firstBp['isActive'] !== 'false' && firstBp['isActive'] !== false,
          },
        }];
      }

      default:
        // Unknown or unhandled event type — silently skip
        return [];
    }
  });
}
