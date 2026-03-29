/**
 * Environment for spawning ibcmd when argv already задаёт целевую ИБ явно (`--config=` или `--db-path=`).
 *
 * `IBCMD_INFOBASE_CONFIG` is commonly set for matrix/smoke/local scripts and points at a **different**
 * infobase than the catalog entry. The ibcmd process inherits the parent env; leaving the variable set
 * can make ibcmd apply the wrong default connection alongside explicit `--config`, producing misleading
 * errors (e.g. exit code 2 «база заблокирована» for another database).
 *
 * `IBCMD_USER` / `IBCMD_PASSWORD` (see WOW ibcmd-api-reference §6) can also steer ibcmd toward a default
 * standalone-server layout on some builds while YAML `infobase.file` is ignored or merged incorrectly —
 * observed as «Информационная база не обнаружена» under `%LocalAppData%\1C\1cv8\standalone-server\…`.
 */
export function envForIbcmdExplicitConfigSpawn(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.IBCMD_INFOBASE_CONFIG;
  delete env.IBCMD_USER;
  delete env.IBCMD_PASSWORD;
  return env;
}

/** True, если в argv задано явное подключение к ИБ (не только `--data`). */
export function ibcmdArgvImpliesExplicitOfflineConnection(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') {
      continue;
    }
    if (a.startsWith('--config=') || a.startsWith('--db-path=')) {
      return true;
    }
    if ((a === '--config' || a === '--db-path') && i + 1 < args.length) {
      return true;
    }
  }
  return false;
}
