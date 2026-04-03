import {
  RdbgTargetInfo,
  RdbgRuntimeError,
  RdbgBreakpointRequest,
  RdbgBreakpoint,
  RdbgEvalResult,
} from './rdbgTypes';

export interface RdbgStoppedEvent {
  type: 'stopped';
  targetId: string;
  reason: 'breakpoint' | 'step' | 'exception' | 'entry';
  error?: RdbgRuntimeError;
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

export interface RdbgBreakpointCorrectedEvent {
  type: 'breakpointCorrected';
  original: RdbgBreakpointRequest;
  corrected: RdbgBreakpoint;
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
