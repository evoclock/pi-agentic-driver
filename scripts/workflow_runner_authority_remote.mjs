const unavailable = () => ({ ok: false, error: { code: 'AUTHORITY_UNAVAILABLE', message: 'authority unavailable', retryable: true } });
/** Credentials are read only when the configured provider is called; never logged. */
export function accessAuthHeaders({ clientIdEnv = 'PAD_AUTHORITY_CF_ACCESS_CLIENT_ID', clientSecretEnv = 'PAD_AUTHORITY_CF_ACCESS_CLIENT_SECRET', env = process.env } = {}) {
  return async () => {
    const id = env[clientIdEnv], secret = env[clientSecretEnv];
    if (!id || !secret) return {};
    return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
  };
}
export function createRemoteAuthority({ baseUrl, tenantId, taskId, fetch: transport = globalThis.fetch,
  authHeaders = accessAuthHeaders(), timeoutMs = 5000 } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('authority requires an HTTPS origin');
  if (![tenantId, taskId].every(v => /^[A-Za-z0-9_-]{8,64}$/.test(v ?? ''))) throw new Error('opaque authority identity required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('invalid authority timeout');
  const root = `/v1/tenants/${tenantId}/tasks/${taskId}`;
  async function call(route, body) {
    // Serialize once. Retries must preserve clientSeenSeq as well as requestId.
    const serialized = body ? JSON.stringify(body) : undefined;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const controller = new AbortController(); let timer;
      try {
        const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
        const request = (async () => {
          const headers = { ...(await authHeaders()), 'Content-Type': 'application/json',
            ...(body ? { 'Idempotency-Key': body.requestId } : {}) };
          return transport(new URL(route, base).href, { method: body ? 'POST' : 'GET', headers,
            body: serialized, signal: controller.signal, redirect: 'error' });
        })();
        const response = await Promise.race([request, timeout]);
        if (response.status === 404 || response.status >= 500) continue;
        let parsed;
        try { parsed = await Promise.race([response.json(), timeout]); } catch { parsed = null; }
        if (response.status === 401 || response.status === 403) {
          const code = response.status === 401 ? 'UNAUTHENTICATED' : parsed?.error?.code === 'TENANT_MISMATCH' ? 'TENANT_MISMATCH' : 'FORBIDDEN';
          return { ok: false, error: { code, message: code, retryable: false } };
        }
        if (!parsed || typeof parsed.ok !== 'boolean' || !Number.isSafeInteger(parsed.seq) && parsed.ok || !Number.isSafeInteger(parsed.epoch) && parsed.ok) continue;
        if (!response.ok && parsed.ok) return unavailable();
        if (!parsed.ok && ['AUTHORITY_DISABLED', 'AUTHORITY_UNAVAILABLE'].includes(parsed.error?.code)) continue;
        return parsed;
      } catch { /* An uncertain transport outcome is never an admission. */ }
      finally { clearTimeout(timer); }
    }
    return unavailable();
  }
  return { commitCancel: body => call(`${root}/cancel`, body), readEpoch: () => call(`${root}/epoch`),
    casAdmitEffect: body => call(`${root}/admit`, body), status: () => call('/v1/status') };
}
