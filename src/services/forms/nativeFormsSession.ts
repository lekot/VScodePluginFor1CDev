import type { NativeFormsAction, NativeFormsActionResult } from '../../agent/agentFormsTypes';

export interface NativeFormsExecuteOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Owns only the TestClient TCP connection; closing it never stops the 1C process. */
export interface NativeFormsSession {
  readonly host: string;
  readonly port: number;
  readonly connected: boolean;
  execute(action: NativeFormsAction, options: NativeFormsExecuteOptions): Promise<NativeFormsActionResult>;
  close(): Promise<void>;
}

export interface NativeFormsConnectionOptions {
  host: string;
  port: number;
  platformVersion?: string;
  timeoutMs: number;
}

export type NativeFormsConnector = (
  options: NativeFormsConnectionOptions,
  signal?: AbortSignal,
) => Promise<NativeFormsSession>;
