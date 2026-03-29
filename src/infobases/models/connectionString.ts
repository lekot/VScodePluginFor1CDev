/**
 * WOW Infobase Manager §3B #50 — разбор и сбор фрагмента строки подключения 1С
 * в формате `Srvr=...;Ref=...` (как в `.v8i` / списке баз платформы).
 *
 * @see docs/WOW/v8i-format-spec.md §4.2
 */

export type ParseServerConnectionStringResult =
  | {
      ok: true;
      server: string;
      ref: string;
      user?: string;
      /** Непустой пароль из `Pwd=`, если ключ был задан с непустым значением. */
      password?: string;
      /** В исходной строке встретился ключ `Pwd=` (включая `Pwd="";`). */
      pwdKeyPresent: boolean;
    }
  | { ok: false; error: string };

/**
 * Разбирает фрагмент вида `Srvr="host";Ref="db";` или с префиксом `Connect=`.
 * Ключи без учёта регистра. Поддерживаются значения в двойных кавычках и без кавычек до `;`.
 */
export function parseServerConnectionString(raw: string): ParseServerConnectionStringResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'Введите строку с Srvr и Ref.' };
  }

  let body = trimmed.replace(/^\ufeff/, '');
  const connectPrefix = /^connect\s*=\s*/i;
  if (connectPrefix.test(body)) {
    body = body.slice(body.match(connectPrefix)![0].length).trim();
  }

  const params: Record<string, string> = {};
  const keyPresent = new Set<string>();
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^;]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = m[1].toLowerCase();
    keyPresent.add(key);
    const value = (m[2] ?? m[3] ?? '').trim();
    params[key] = value;
  }

  const srvr = (params.srvr ?? '').trim();
  const ref = (params.ref ?? '').trim();
  if (!srvr || !ref) {
    return {
      ok: false,
      error: 'Нужны непустые Srvr и Ref, например: Srvr="server1c";Ref="Demo_UT";',
    };
  }

  const userRaw = params.usr?.trim();
  const pwdKeyPresent = keyPresent.has('pwd');
  const pwdRaw = pwdKeyPresent ? (params.pwd ?? '') : undefined;

  return {
    ok: true,
    server: srvr,
    ref,
    user: userRaw || undefined,
    password: pwdRaw !== undefined && pwdRaw.length > 0 ? pwdRaw : undefined,
    pwdKeyPresent,
  };
}

export type FormatServerConnectionStringOptions = {
  server: string;
  ref: string;
  /** Если задан — добавляется как `Usr="..."` (без пароля). */
  user?: string;
};

function yamlStyleDoubleQuotedScalar(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Собирает фрагмент `Srvr="...";Ref="..."` (+ опционально `Usr=`) для отображения и правки в UI.
 * Пароль намеренно не включается — он хранится только в SecretStorage расширения.
 */
export function formatServerConnectionString(opts: FormatServerConnectionStringOptions): string {
  const server = opts.server.trim();
  const ref = opts.ref.trim();
  let s = `Srvr=${yamlStyleDoubleQuotedScalar(server)};Ref=${yamlStyleDoubleQuotedScalar(ref)}`;
  const u = opts.user?.trim();
  if (u) {
    s += `;Usr=${yamlStyleDoubleQuotedScalar(u)}`;
  }
  return s;
}
