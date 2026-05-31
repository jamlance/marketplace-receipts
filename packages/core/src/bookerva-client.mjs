// Bookerva partner client. Our embedded-app backends call Bookerva's
// /api/v1/partner/* endpoints on a merchant's behalf, authenticated by a
// service token (HS256) signed with the SERVICE_TOKEN_SECRET that Bookerva
// also holds. The token asserts "I act for inkress merchant <externalId>";
// Bookerva resolves that to a Bookerva tenant via its partner_links table.
//
//   const bk = bookerva();
//   const { merchant } = await bk.ensureTenant(merchantId, { name, email });
//   const services = await bk.listServices(merchantId);
//
// No external JWT lib needed — HS256 is a single HMAC.

import crypto from "node:crypto";

const ISSUER = "bookerva";
const AUDIENCE = "bookerva-partner";

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signServiceToken(secret, externalId, { source = "inkress", ttlSeconds = 24 * 60 * 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256" };
  const payload = {
    scope: "partner",
    source,
    externalId: String(externalId),
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = b64url(crypto.createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

export class BookervaError extends Error {
  constructor(status, code, message, body) {
    super(message || code || `bookerva_http_${status}`);
    this.name = "BookervaError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function bookervaConfig() {
  const baseUrl = stripTrailingSlash(
    process.env.BOOKERVA_API_BASE || "https://bookerva.tserve.webapps.host",
  );
  const secret = process.env.SERVICE_TOKEN_SECRET || "";
  const source = process.env.BOOKERVA_PARTNER_SOURCE || "inkress";
  return { baseUrl, secret, source };
}

export function bookervaConfigured() {
  const { baseUrl, secret } = bookervaConfig();
  return Boolean(baseUrl && secret);
}

export function bookerva(cfg = bookervaConfig()) {
  if (!cfg.secret) {
    throw new BookervaError(0, "not_configured", "SERVICE_TOKEN_SECRET is not set; Bookerva partner client disabled.");
  }

  async function call(externalId, method, path, { query, body } = {}) {
    const token = signServiceToken(cfg.secret, externalId, { source: cfg.source });
    let url = `${cfg.baseUrl}/api/v1/partner/${path.replace(/^\/+/, "")}`;
    if (query && Object.keys(query).length) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
        else sp.set(k, String(v));
      }
      url += `?${sp.toString()}`;
    }
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";

    const r = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data = null;
    const text = await r.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!r.ok) {
      const err = data && typeof data === "object" ? data.error : null;
      throw new BookervaError(r.status, err?.code || err?.reason || `http_${r.status}`, err?.message, data);
    }
    return data;
  }

  return {
    config: cfg,

    /** Resolve or provision the Bookerva tenant for an Inkress merchant. */
    async ensureTenant(externalId, input) {
      const res = await call(externalId, "POST", "ensure-tenant", { body: input });
      return res.data;
    },

    async getMe(externalId) {
      const res = await call(externalId, "GET", "me");
      return res.data;
    },

    async listServices(externalId, { includeInactive = false } = {}) {
      const res = await call(externalId, "GET", "services", {
        query: includeInactive ? { include_inactive: "true" } : undefined,
      });
      return res.data;
    },

    async createService(externalId, service) {
      const res = await call(externalId, "POST", "services", { body: service });
      return res.data;
    },

    async listProviders(externalId, { serviceId } = {}) {
      const res = await call(externalId, "GET", "providers", {
        query: serviceId ? { service_id: serviceId } : undefined,
      });
      return res.data;
    },

    async getAvailability(externalId, { providerId, serviceId, rangeStart, rangeEnd }) {
      const res = await call(externalId, "GET", "availability", {
        query: {
          provider_id: providerId,
          service_id: serviceId,
          range_start: rangeStart,
          range_end: rangeEnd,
        },
      });
      return res.data;
    },

    async listAppointments(externalId, { status, providerId, rangeStart, rangeEnd, limit } = {}) {
      const res = await call(externalId, "GET", "appointments", {
        query: {
          status,
          provider_id: providerId,
          range_start: rangeStart,
          range_end: rangeEnd,
          limit,
        },
      });
      return res.data;
    },

    async createAppointment(externalId, appointment) {
      const res = await call(externalId, "POST", "appointments", { body: appointment });
      return res.data;
    },

    async transitionAppointment(externalId, id, { status, reason } = {}) {
      const res = await call(externalId, "POST", `appointments/${encodeURIComponent(id)}/transition`, {
        body: { status, reason },
      });
      return res.data;
    },

    async rescheduleAppointment(externalId, id, scheduledAt) {
      const res = await call(externalId, "POST", `appointments/${encodeURIComponent(id)}/reschedule`, {
        body: { scheduled_at: scheduledAt },
      });
      return res.data;
    },

    async listClients(externalId, { q, limit } = {}) {
      const res = await call(externalId, "GET", "clients", { query: { q, limit } });
      return res.data;
    },

    async createClient(externalId, client) {
      const res = await call(externalId, "POST", "clients", { body: client });
      return res.data;
    },
  };
}
