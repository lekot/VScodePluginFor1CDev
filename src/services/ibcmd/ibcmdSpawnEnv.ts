/**
 * Environment for spawning ibcmd when argv already includes `--config=…`.
 *
 * `IBCMD_INFOBASE_CONFIG` is commonly set for matrix/smoke/local scripts and points at a **different**
 * infobase than the catalog entry. The ibcmd process inherits the parent env; leaving the variable set
 * can make ibcmd apply the wrong default connection alongside explicit `--config`, producing misleading
 * errors (e.g. exit code 2 «база заблокирована» for another database).
 */
export function envForIbcmdExplicitConfigSpawn(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.IBCMD_INFOBASE_CONFIG;
  return env;
}
