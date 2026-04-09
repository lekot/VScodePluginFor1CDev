import {
  RdbgTargetInfo,
  RdbgRuntimeError,
  RdbgBreakpoint,
  RdbgEvalResult,
  RdbgCallStackItem,
} from './rdbgTypes';

export interface RdbgStoppedEvent {
  type: 'stopped';
  targetId: string;
  reason: 'breakpoint' | 'step' | 'exception' | 'entry';
  error?: RdbgRuntimeError;
  callStack?: RdbgCallStackItem[];
}

export interface RdbgContinuedEvent {
  type: 'continued';
  targetId: string;
}

export interface RdbgTargetStartedEvent {
  type: 'targetStarted';
  target: RdbgTargetInfo;
}

export interface RdbgTargetQuitEvent {
  type: 'targetQuit';
  targetId: string;
}

export interface RdbgRuntimeErrorEvent {
  type: 'runtimeError';
  targetId: string;
  error: RdbgRuntimeError;
}

/**
 * Phase 4 (OQ-5): redesigned to match the etalon DbguiExtCmdInfoCorrectedBp (Messages.cs:4213).
 * The etalon carries bpWorkspace → moduleBPInfo[] (canonical corrected state of BPs for modules).
 * There is no original/corrected pair distinction in the protocol — only the corrected set.
 */
export interface RdbgBreakpointCorrectedEvent {
  type: 'breakpointCorrected';
  /** Canonical: list of corrected breakpoints from bpWorkspace[].moduleBPInfo[].bpInfo[] */
  bps: RdbgBreakpoint[];
}

export interface RdbgExpressionEvaluatedEvent {
  type: 'expressionEvaluated';
  targetId: string;
  result: RdbgEvalResult;
}

export type RdbgEvent =
  | RdbgStoppedEvent
  | RdbgContinuedEvent
  | RdbgTargetStartedEvent
  | RdbgTargetQuitEvent
  | RdbgRuntimeErrorEvent
  | RdbgBreakpointCorrectedEvent
  | RdbgExpressionEvaluatedEvent;
