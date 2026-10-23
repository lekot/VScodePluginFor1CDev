import * as fs from 'fs';
import * as path from 'path';

import { isSamePath } from '../../src/services/configurationSession/pathBoundary';

export interface MutationPlanPublicationRule {
  readonly targetPath: string;
  readonly operation?: 'link' | 'rename';
  readonly before?: () => Promise<void>;
  readonly after?: () => Promise<void>;
}

/** Installs a test-only seam around either no-replace links or replacement renames. */
export function installMutationPlanPublicationInterception(
  rules: readonly MutationPlanPublicationRule[],
): { restore(): void } {
  const originalLink = fs.promises.link;
  const originalRename = fs.promises.rename;
  const pendingRules = rules.map((rule) => ({ ...rule, triggered: false }));
  let restored = false;

  const publish = async (
    operation: 'link' | 'rename',
    destination: fs.PathLike,
    effect: () => Promise<void>,
  ): Promise<void> => {
    for (const rule of pendingRules) {
      if (
        rule.triggered
        || (rule.operation !== undefined && rule.operation !== operation)
        || !(await isSameCanonicalTestPath(destination, rule.targetPath))
      ) {
        continue;
      }
      rule.triggered = true;
      await rule.before?.();
      await effect();
      await rule.after?.();
      return;
    }
    await effect();
  };

  fs.promises.link = async function (existingPath: fs.PathLike, newPath: fs.PathLike): Promise<void> {
    return publish('link', newPath, () => originalLink.call(fs.promises, existingPath, newPath));
  };
  fs.promises.rename = async function (sourcePath: fs.PathLike, destination: fs.PathLike): Promise<void> {
    return publish('rename', destination, () => originalRename.call(fs.promises, sourcePath, destination));
  };

  return {
    restore() {
      if (restored) {
        return;
      }
      restored = true;
      fs.promises.link = originalLink;
      fs.promises.rename = originalRename;
    },
  };
}

export function installMutationPlanTempOpenFailure(
  targetPath: string,
  message: string,
): { arm(): void; readonly triggered: boolean; restore(): void } {
  const originalOpen = fs.promises.open;
  let armed = false;
  let triggered = false;
  let restored = false;
  const targetDirectory = path.dirname(targetPath);

  fs.promises.open = async function (
    filePath: fs.PathLike,
    flags?: string | number,
    mode?: fs.Mode,
  ): Promise<fs.promises.FileHandle> {
    if (
      armed
      && !triggered
      && path.basename(String(filePath)).startsWith('.cdt-plan-')
      && isSamePath(path.dirname(await canonicalMutationTestPath(filePath)), targetDirectory)
    ) {
      triggered = true;
      throw new Error(message);
    }
    return mode === undefined
      ? originalOpen.call(fs.promises, filePath, flags)
      : originalOpen.call(fs.promises, filePath, flags, mode);
  };

  return {
    arm() {
      armed = true;
    },
    get triggered() {
      return triggered;
    },
    restore() {
      if (restored) {
        return;
      }
      restored = true;
      fs.promises.open = originalOpen;
    },
  };
}

async function isSameCanonicalTestPath(left: fs.PathLike, right: fs.PathLike): Promise<boolean> {
  return isSamePath(await canonicalMutationTestPath(left), await canonicalMutationTestPath(right));
}

export async function canonicalMutationTestPath(targetPath: fs.PathLike): Promise<string> {
  const absolutePath = path.resolve(String(targetPath));
  const parentPath = path.dirname(absolutePath);
  const canonicalParent = await fs.promises.realpath(parentPath).catch(() => parentPath);
  return path.join(canonicalParent, path.basename(absolutePath));
}
