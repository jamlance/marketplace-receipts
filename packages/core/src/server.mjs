import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { exchangeSessionToken, inkressApi, InkressApiError } from "./inkress-api.mjs";
import { SessionStore, SESSION_COOKIE } from "./session-store.mjs";

const DEFAULT_FRAME_ANCESTORS =
  "https://merchant.inkress.com https://dev.inkress.com https://dev.commerce.webapps.host https://*.commerce.webapps.host";

// Decode a JWT payload without verifying (we only need the `aud`
// claim to pick which client credentials to present; the API verifies
// the signature during exchange).
function peekAud(jwt) {
  return peekClaim(jwt, "aud");
}
function peekClaim(jwt, claim) {
  try {
    const part = jwt.split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json)[claim];
  } catch {
    return null;
  }
}

export function mountAppCore(app, opts) {
  const sessions = new SessionStore();
  const frameAncestors = opts.frameAncestors || DEFAULT_FRAME_ANCESTORS;

  // Multi-client support: a single deploy can serve several oauth_clients
  // (path-routed suites). `opts.clients` maps client_id → client_secret.
  // Falls back to the single clientId/clientSecret pair.
  const clientMap =
    opts.clients && Object.keys(opts.clients).length
      ? { ...opts.clients }
      : { [opts.clientId]: opts.clientSecret };
  const defaultClientId = opts.clientId || Object.keys(clientMap)[0];

  const cfgFor = (clientId) => ({
    clientId,
    clientSecret: clientMap[clientId],
    apiBaseUrl: opts.apiBaseUrl,
  });
  // Default cfg (for app code that calls callInkress without a specific
  // client — the access token is what matters there, not the client id).
  const cfg = cfgFor(defaultClientId);

  app.use(cookieParser());
  app.use(express.json({ limit: "256kb" }));

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "clipboard-write=(self)");
    next();
  });

  app.post("/__bv/bootstrap", async (req, res) => {
    const sessionJwt = typeof req.body?.sessionJwt === "string" ? req.body.sessionJwt.trim() : "";
    if (!sessionJwt) {
      return res.status(400).json({ error: "missing_session_jwt" });
    }
    try {
      // Pick the client credentials matching the session token's aud.
      const aud = peekAud(sessionJwt);
      const exchangeCfg = aud && clientMap[aud] ? cfgFor(aud) : cfg;
      const token = await exchangeSessionToken(exchangeCfg, sessionJwt);
      const entry = sessions.put(token);
      if (opts.preloadMerchant !== false && entry.merchantId > 0) {
        try {
          const r = await inkressApi(cfg, entry.accessToken, `merchants/${entry.merchantId}`);
          entry.data.merchant = r?.result ?? null;
        } catch {
          /* ignore */
        }
      }
      // Header-based session: return the opaque id in the body. The
      // iframe keeps it in memory + sessionStorage and sends it as
      // X-BV-Session. We still set a cookie too (harmless; works for
      // non-iframe/local use) but never depend on it.
      // Stash the acting user on the session for attribution fallback.
      entry.data.user_id = peekClaim(sessionJwt, "user_id");
      // Let the app cache merchant branding (for public pages) etc.
      if (typeof opts.onBootstrap === "function") {
        try { opts.onBootstrap(entry); } catch { /* non-fatal */ }
      }
      res.cookie(SESSION_COOKIE, entry.sessionId, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 1000 * 60 * 60 * 24,
        path: "/",
      });
      res.json({
        ok: true,
        session_id: entry.sessionId,
        merchant: entry.data.merchant ?? null,
        merchant_id: entry.merchantId,
        scopes: entry.scope,
        expires_at: entry.expiresAt,
      });
    } catch (err) {
      const code = err instanceof InkressApiError ? err.code : "exchange_failed";
      const message = err instanceof Error ? err.message : "Token exchange failed";
      res.status(401).json({ error: code, message });
    }
  });

  app.post("/__bv/logout", (req, res) => {
    sessions.delete(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // Resolve a session from the X-BV-Session header (primary, works in
  // cross-site iframes) or the cookie (fallback for same-site use).
  const resolveSession = (req) =>
    sessions.get(req.get("x-bv-session")) ||
    sessions.get(req.cookies?.[SESSION_COOKIE]);

  app.get("/__bv/me", (req, res) => {
    const entry = resolveSession(req);
    if (!entry) return res.status(401).json({ error: "no_session" });
    res.json({
      merchant: entry.data.merchant ?? null,
      merchant_id: entry.merchantId,
      scopes: entry.scope,
      expires_at: entry.expiresAt,
    });
  });

  const requireSession = (req, res, next) => {
    const entry = resolveSession(req);
    if (!entry) return res.status(401).json({ error: "no_session" });
    req.session = entry;
    // Attribution: who is acting (from the X-BV-User-* headers the
    // browser kit attaches). Falls back to the JWT's consenting user.
    req.actor = {
      id: Number(req.get("x-bv-user-id")) || entry.data?.user_id || null,
      name: req.get("x-bv-user-name") || entry.data?.user_name || null,
    };
    next();
  };

  app.use(express.static(opts.staticDir, { extensions: ["html"] }));

  return {
    sessions,
    requireSession,
    callInkress: (session, pathPart, init) => inkressApi(cfg, session.accessToken, pathPart, init),
    cfg,
    mountSpaFallback: () => {
      app.get("*", (_req, res) => {
        res.sendFile(path.join(opts.staticDir, "index.html"));
      });
    },
  };
}

// Re-exports so callers can import the API helpers via the same module.
export {
  exchangeSessionToken,
  inkressApi,
  InkressApiError,
  orderStatusName,
  isPaidStatus,
  createInkressOrder,
  getInkressOrder,
  listInkressOrders,
  refreshAccessToken,
} from "./inkress-api.mjs";
export { SessionStore, SESSION_COOKIE } from "./session-store.mjs";
