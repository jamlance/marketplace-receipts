import crypto from "node:crypto";

export const SESSION_COOKIE = "bv_app_session";

export class SessionStore {
  constructor(opts = {}) {
    this.map = new Map();
    const sweepEverySec = opts.sweepEverySec ?? 60;
    this.sweepHandle = setInterval(() => this.sweep(), sweepEverySec * 1000);
    this.sweepHandle.unref?.();
  }

  put(token) {
    const sessionId = crypto.randomUUID();
    const entry = {
      sessionId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scope: (token.scope || "").split(" ").filter(Boolean),
      merchantId: token.merchant_id ?? 0,
      expiresAt:
        Math.floor(Date.now() / 1000) + Math.max(60, token.expires_in - 60),
      data: {},
    };
    this.map.set(sessionId, entry);
    return entry;
  }

  get(sessionId) {
    if (!sessionId) return null;
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      this.map.delete(sessionId);
      return null;
    }
    return entry;
  }

  delete(sessionId) {
    if (sessionId) this.map.delete(sessionId);
  }

  sweep() {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, entry] of this.map) {
      if (entry.expiresAt < now) this.map.delete(id);
    }
  }
}
