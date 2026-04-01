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
  context: vscode.ExtensionContext,
  options: GitPhase4HeadHandlers,
): vscode.Disposable {
  const subs: vscode.Disposable[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
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
    const key = repo.rootUri.toString();
    pending.set(key, repo.state.HEAD?.commit);
    subs.push(
      repo.state.onDidChange(() => {
        if (!gitHeadHandlersActive(options)) {
          return;
        }
        const prev = pending.get(key);
        const next = repo.state.HEAD?.commit;
        if (next !== undefined && next !== prev) {
          pending.set(key, next);
          scheduleReload();
        }
      }),
    );
  };

  const gitExt = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!gitExt) {
    return { dispose: () => undefined };
  }

  void gitExt.activate().then(
    (git) => {
      try {
        const api = git.getAPI(1);
        for (const r of api.repositories) {
          attach(r);
        }
        subs.push(api.onDidOpenRepository((r) => attach(r)));
      } catch (err) {
        Logger.warn('Git API unavailable; HEAD-change reload disabled', err);
      }
    },
    (err) => {
      Logger.warn('Git extension activation failed; HEAD-change reload disabled', err);
    },
  );

  const all = vscode.Disposable.from(
    { dispose: () => subs.forEach((d) => d.dispose()) },
    {
      dispose: () => {
        if (debounce !== undefined) {
          clearTimeout(debounce);
        }
      },
    },
  );
  context.subscriptions.push(all);
  return all;
}
