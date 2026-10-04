import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { AgentResult } from './types';

export type AgentTaskState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTaskReceipt {
  readonly status: 'working';
  readonly taskId: string;
  readonly message: string;
}

export interface AgentTaskSnapshot {
  readonly taskId: string;
  readonly name: string;
  readonly status: AgentTaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly cancellationRequested: boolean;
  readonly message: string;
  readonly recentMessages: readonly string[];
}

export interface AgentTaskResultSnapshot extends AgentTaskSnapshot {
  /** The original AgentResult is kept intact and nested here when the task settles. */
  readonly result?: AgentResult<unknown>;
}

interface TaskRecord {
  readonly taskId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly cancellationSource: vscode.CancellationTokenSource;
  readonly recentMessages: string[];
  status: AgentTaskState;
  updatedAt: number;
  finishedAt?: number;
  cancellationRequested: boolean;
  message: string;
  result?: AgentResult<unknown>;
}

export interface AgentTaskManagerOptions {
  readonly now?: () => number;
  readonly createCancellationSource?: () => vscode.CancellationTokenSource;
  readonly maxTasks?: number;
  readonly terminalTtlMs?: number;
  readonly maxRecentMessages?: number;
  readonly maxMessageLength?: number;
}

const DEFAULT_MAX_TASKS = 64;
const DEFAULT_TERMINAL_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_RECENT_MESSAGES = 24;
const DEFAULT_MAX_MESSAGE_LENGTH = 320;

/** In-memory lifecycle manager for long-running Agent operations. */
export class AgentTaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly now: () => number;
  private readonly createCancellationSource: () => vscode.CancellationTokenSource;
  private readonly maxTasks: number;
  private readonly terminalTtlMs: number;
  private readonly maxRecentMessages: number;
  private readonly maxMessageLength: number;

  constructor(options: AgentTaskManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createCancellationSource = options.createCancellationSource
      ?? (() => new vscode.CancellationTokenSource());
    this.maxTasks = Math.max(1, options.maxTasks ?? DEFAULT_MAX_TASKS);
    this.terminalTtlMs = Math.max(0, options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS);
    this.maxRecentMessages = Math.max(1, options.maxRecentMessages ?? DEFAULT_MAX_RECENT_MESSAGES);
    this.maxMessageLength = Math.max(32, options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH);
  }

  start(
    name: string,
    execute: (token: vscode.CancellationToken, reportStage: (message: string) => void) => Promise<AgentResult<unknown>>,
  ): AgentResult<AgentTaskReceipt> {
    this.prune();
    this.makeRoom();
    if (this.tasks.size >= this.maxTasks) {
      return {
        success: false,
        code: 'TASK_CAPACITY_REACHED',
        error: 'Достигнут предел одновременно хранимых задач. Повторите запрос после завершения текущих задач.',
      };
    }

    const createdAt = this.now();
    const taskId = randomUUID();
    const task: TaskRecord = {
      taskId,
      name: sanitizeMessage(name, this.maxMessageLength),
      createdAt,
      updatedAt: createdAt,
      cancellationSource: this.createCancellationSource(),
      recentMessages: [],
      status: 'running',
      cancellationRequested: false,
      message: 'Задача выполняется.',
    };
    this.tasks.set(taskId, task);
    this.recordMessage(task, 'Задача принята.');

    // Defer execution until after the immediate receipt has been returned.
    void Promise.resolve()
      .then(() => execute(task.cancellationSource.token, (message) => this.reportStage(taskId, message)))
      .then((result) => this.complete(task, result))
      .catch((error: unknown) => this.complete(task, {
        success: false,
        code: 'TASK_EXECUTION_FAILED',
        error: sanitizeMessage(error instanceof Error ? error.message : String(error), this.maxMessageLength),
      }));

    return {
      success: true,
      data: {
        status: 'working',
        taskId,
        message: 'Задача запущена. Используйте task.status и task.result для отслеживания.',
      },
    };
  }

  status(taskId: string): AgentResult<AgentTaskSnapshot> {
    const task = this.find(taskId);
    if (!task) {
      return this.notFound();
    }
    return { success: true, data: this.snapshot(task) };
  }

  result(taskId: string): AgentResult<AgentTaskResultSnapshot> {
    const task = this.find(taskId);
    if (!task) {
      return this.notFound();
    }
    return {
      success: true,
      data: {
        ...this.snapshot(task),
        ...(task.result ? { result: task.result } : {}),
      },
    };
  }

  cancel(taskId: string): AgentResult<{
    readonly taskId: string;
    readonly status: AgentTaskState;
    readonly cancellationRequested: boolean;
    readonly message: string;
  }> {
    const task = this.find(taskId);
    if (!task) {
      return this.notFound();
    }
    if (task.status === 'running' && !task.cancellationRequested) {
      task.cancellationRequested = true;
      task.message = 'Отмена запрошена; ожидается подтверждённый результат процесса.';
      task.updatedAt = this.now();
      this.recordMessage(task, task.message);
      task.cancellationSource.cancel();
    }
    return {
      success: true,
      data: {
        taskId,
        status: task.status,
        cancellationRequested: task.cancellationRequested,
        message: task.status === 'running'
          ? task.message
          : 'Задача уже завершилась; результат можно получить через task.result.',
      },
    };
  }

  reportStage(taskId: string, message: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') {
      return;
    }
    task.message = sanitizeMessage(message, this.maxMessageLength);
    task.updatedAt = this.now();
    this.recordMessage(task, task.message);
  }

  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        task.cancellationRequested = true;
        task.cancellationSource.cancel();
      }
      task.cancellationSource.dispose();
    }
    this.tasks.clear();
  }

  private complete(task: TaskRecord, result: AgentResult<unknown>): void {
    if (!this.tasks.has(task.taskId) || task.status !== 'running') {
      return;
    }
    task.result = result;
    const repositoryStatus = readRepositoryStatus(result);
    task.status = repositoryStatus === 'cancelled' || result.code === 'REQUEST_CANCELLED'
      ? 'cancelled'
      : result.success ? 'completed' : 'failed';
    task.finishedAt = this.now();
    task.message = task.status === 'completed'
      ? 'Задача завершена успешно.'
      : task.status === 'cancelled'
        ? 'Операция подтверждённо отменена.'
        : task.cancellationRequested
          ? 'Операция завершилась после запроса отмены; итоговый результат сохранён.'
          : 'Задача завершилась с ошибкой.';
    task.updatedAt = task.finishedAt;
    this.recordMessage(task, task.message);
    task.cancellationSource.dispose();
    this.prune();
  }

  private find(taskId: string): TaskRecord | undefined {
    this.prune();
    return this.tasks.get(taskId);
  }

  private snapshot(task: TaskRecord): AgentTaskSnapshot {
    return {
      taskId: task.taskId,
      name: task.name,
      status: task.status,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      elapsedMs: Math.max(0, (task.finishedAt ?? this.now()) - task.createdAt),
      cancellationRequested: task.cancellationRequested,
      message: task.message,
      recentMessages: [...task.recentMessages],
    };
  }

  private recordMessage(task: TaskRecord, message: string): void {
    task.recentMessages.push(sanitizeMessage(message, this.maxMessageLength));
    if (task.recentMessages.length > this.maxRecentMessages) {
      task.recentMessages.splice(0, task.recentMessages.length - this.maxRecentMessages);
    }
  }

  private makeRoom(): void {
    if (this.tasks.size < this.maxTasks) {
      return;
    }
    const terminal = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.tasks.size >= this.maxTasks && terminal.length > 0) {
      const oldest = terminal.shift()!;
      oldest.cancellationSource.dispose();
      this.tasks.delete(oldest.taskId);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.terminalTtlMs;
    for (const [taskId, task] of this.tasks) {
      if (task.status !== 'running' && task.updatedAt < cutoff) {
        task.cancellationSource.dispose();
        this.tasks.delete(taskId);
      }
    }
  }

  private notFound(): AgentResult<never> {
    return { success: false, code: 'TASK_NOT_FOUND', error: 'Задача не найдена или срок хранения её результата истёк.' };
  }
}

function readRepositoryStatus(result: AgentResult<unknown>): string | undefined {
  if (!result.data || typeof result.data !== 'object') {
    return undefined;
  }
  const status = (result.data as { status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
}

/** Store stage messages only; redact credential-shaped fragments and bound their size. */
function sanitizeMessage(message: string, maxLength: number): string {
  const sanitized = message
    .replace(/\b(password|passwd|пароль|token|bearer)\b(\s*[:=]\s*)[^\s,;]+/gi, '$1$2<redacted>')
    .replace(/(\/ConfigurationRepositoryP\s+)\S+/gi, '$1<redacted>')
    .replace(/([?&](?:password|token)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength - 1)}…` : sanitized;
}
