// Per-merchant refresh-token store, so an app's PUBLIC (no-auth) pages can act
// on a merchant's behalf — e.g. create an Inkress order when a customer buys a
// gift card or reserves a pre-order, with no live dashboard session.
//
// On bootstrap the app saves the merchant's refresh_token (requires the OAuth
// client to hold `offline_access`). Public routes call accessTokenFor(merchantId)
// which refreshes + caches a short-lived access token. Refresh tokens are stored
// AES-256-GCM encrypted with a key derived from the app's OAuth client secret.
//
//   const tokens = await openMerchantTokens("gift_cards", core.cfg);
//   // on bootstrap: tokens.save(entry.merchantId, entry.refreshToken)
//   // in a public route: const at = await tokens.accessTokenFor(merchantId)

import crypto from "node:crypto";
import { openPg } from "./pgdb.mjs";
import { refreshAccessToken } from "./inkress-api.mjs";

const keyFrom = (secret) => crypto.createHash("sha256").update(String(secret || "")).digest();

function encrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decrypt(b64, key) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export async function openMerchantTokens(appName, cfg) {
  const db = await openPg(appName, `
    CREATE TABLE IF NOT EXISTS merchant_tokens (
      merchant_id BIGINT PRIMARY KEY,
      refresh_enc TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const key = keyFrom(cfg.clientSecret);
  const cache = new Map();   // merchantId -> { token, exp }
  const inflight = new Map(); // merchantId -> Promise

  return {
    db,
    async save(merchantId, refreshToken) {
      if (!merchantId || !refreshToken) return false;
      await db.run(
        `INSERT INTO merchant_tokens (merchant_id, refresh_enc, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (merchant_id) DO UPDATE SET refresh_enc=$2, updated_at=now()`,
        [merchantId, encrypt(refreshToken, key)]);
      cache.delete(merchantId);
      return true;
    },
    async hasToken(merchantId) {
      return Boolean(await db.one(`SELECT 1 FROM merchant_tokens WHERE merchant_id=$1`, [merchantId]));
    },
    async accessTokenFor(merchantId) {
      const c = cache.get(merchantId);
      if (c && c.exp > Date.now() + 30000) return c.token;
      if (inflight.has(merchantId)) return inflight.get(merchantId);
      const p = (async () => {
        const row = await db.one(`SELECT refresh_enc FROM merchant_tokens WHERE merchant_id=$1`, [merchantId]);
        if (!row) throw new Error("merchant_not_connected");
        const rt = decrypt(row.refresh_enc, key);
        const t = await refreshAccessToken(cfg, rt);
        if (t.refresh_token && t.refresh_token !== rt) {
          await db.run(`UPDATE merchant_tokens SET refresh_enc=$1, updated_at=now() WHERE merchant_id=$2`, [encrypt(t.refresh_token, key), merchantId]);
        }
        cache.set(merchantId, { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 });
        return t.access_token;
      })().finally(() => inflight.delete(merchantId));
      inflight.set(merchantId, p);
      return p;
    },
  };
}
