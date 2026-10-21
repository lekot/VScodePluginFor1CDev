/**
 * WOW Phase 4 #63 — после смены HEAD в git-репозитории workspace перезагрузка дерева метаданных
 * (типичный случай: pull / merge / checkout) и обновление Infobase Manager.
 */

import * as vscode from 'vscode';
import {
  getGitRefreshInfobaseManagerOnHeadChangeSetting,
  getGitReloadMetadataOnHeadChangeSetting,
} from './metadataTreeSettings';
import { Logger } from '../utils/logger';

/** Минимальные типы встроенного расширения vscode.git (без зависимости от @types). */
interface GitRepositoryState {
  readonly HEAD?: { commit?: string };
  readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

const GIT_HEAD_DEBOUNCE_MS = 1200;

function gitHeadHandlersActive(options: GitPhase4HeadHandlers): boolean {
  const meta =
    !!options.onReloadMetadataTree && getGitReloadMetadataOnHeadChangeSetting();
  const ib =
    !!options.onRefreshInfobaseManager && getGitRefreshInfobaseManagerOnHeadChangeSetting();
  return meta || ib;
}

export interface GitPhase4HeadHandlers {
  onReloadMetadataTree?: () => Promise<void>;
  onRefreshInfobaseManager?: () => void;
}

/**
 * Одна подписка на vscode.git: при смене HEAD (debounce) вызывает обработчики согласно настройкам
 * {@link getGitReloadMetadataOnHeadChangeSetting} / {@link getGitRefreshInfobaseManagerOnHeadChangeSetting}.
 */
export function registerGitPhase4HeadChangeHandlers(
  options: GitPhase4HeadHandlers,
): vscode.Disposable {
  const subs: vscode.Disposable[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const pending = new Map<string, string | undefined>();

  const fireHandlers = (): void => {
    if (options.onReloadMetadataTree && getGitReloadMetadataOnHeadChangeSetting()) {
      void options.onReloadMetadataTree();
    }
    if (options.onRefreshInfobaseManager && getGitRefreshInfobaseManagerOnHeadChangeSetting()) {
      options.onRefreshInfobaseManager();
    }
  };

  const scheduleReload = (): void => {
    if (!gitHeadHandlersActive(options)) {
      return;
    }
    if (debounce !== undefined) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      debounce = undefined;
      fireHandlers();
    }, GIT_HEAD_DEBOUNCE_MS);
  };

  const attach = (repo: GitRepository): void => {
    if (disposed) {
      return;
    }
    const key = repo.rootUri.toString();
    pending.set(key, repo.state.HEAD?.commit);
    const subscription = repo.state.onDidChange(() => {
        if (!gitHeadHandlersActive(options)) {
          return;
        }
        const prev = pending.get(key);
        const next = repo.state.HEAD?.commit;
        if (next !== undefined && next !== prev) {
          pending.set(key, next);
          scheduleReload();
        }
      });
    if (disposed) {
      subscription.dispose();
    } else {
      subs.push(subscription);
    }
  };

  const gitExt = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!gitExt) {
    return { dispose: () => undefined };
  }

  void gitExt.activate().then(
    (git) => {
      try {
        if (disposed) {
          return;
        }
        const api = git.getAPI(1);
        for (const r of api.repositories) {
          attach(r);
        }
        const subscription = api.onDidOpenRepository((r) => attach(r));
        if (disposed) {
          subscription.dispose();
        } else {
          subs.push(subscription);
        }
      } catch (err) {
        Logger.warn('Git API unavailable; HEAD-change reload disabled', err);
      }
    },
    (err) => {
      Logger.warn('Git extension activation failed; HEAD-change reload disabled', err);
    },
  );

  const all = {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        if (debounce !== undefined) {
          clearTimeout(debounce);
        }
        for (const subscription of subs.splice(0).reverse()) {
          try {
            subscription.dispose();
          } catch (err) {
            Logger.warn('Git HEAD-change subscription disposal failed', err);
          }
        }
      },
    };
  return all;
}
