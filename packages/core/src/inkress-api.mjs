// Plain-JS twin of inkress-api.ts. Apps import the .mjs directly so
// the runtime container doesn't need a TS compiler / loader.

export async function exchangeSessionToken(cfg, sessionJwt, opts = {}) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    subject_token: sessionJwt,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
  if (opts.scope?.length) body.set("scope", opts.scope.join(" "));

  const tokenUrl = `${stripTrailingSlash(cfg.apiBaseUrl)}/hooks/oauth/token`;
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    let detail;
    try {
      detail = await r.json();
    } catch {
      detail = await r.text();
    }
    throw new InkressApiError(
      detail?.error || `http_${r.status}`,
      detail?.error_description || `Token exchange failed (HTTP ${r.status})`,
    );
  }
  return await r.json();
}

/**
 * Refresh-token grant. Exchanges a stored refresh_token for a fresh access
 * token (and possibly a rotated refresh_token). Lets public no-auth pages act
 * on a merchant's behalf without a live dashboard session. Requires the app's
 * OAuth client to hold `offline_access` so the original exchange returned a
 * refresh_token. Returns the raw token response {access_token, refresh_token?,
 * expires_in, ...}.
 */
export async function refreshAccessToken(cfg, refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const tokenUrl = `${stripTrailingSlash(cfg.apiBaseUrl)}/hooks/oauth/token`;
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    let detail;
    try { detail = await r.json(); } catch { detail = await r.text(); }
    throw new InkressApiError(detail?.error || `http_${r.status}`, detail?.error_description || `Refresh failed (HTTP ${r.status})`);
  }
  return await r.json();
}

export async function inkressApi(cfg, accessToken, path, init = {}) {
  const url = `${stripTrailingSlash(cfg.apiBaseUrl)}/${stripLeadingSlash(path)}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!r.ok) {
    let detail = null;
    try {
      detail = await r.json();
    } catch {
      detail = await r.text();
    }
    throw new InkressApiError(
      detail?.result?.reason || `http_${r.status}`,
      detail?.result?.message ||
        (typeof detail?.result === "string" ? detail.result : null) ||
        `Inkress API call failed (HTTP ${r.status}) ${path}`,
    );
  }
  return await r.json();
}

export class InkressApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "InkressApiError";
  }
}

// ---------------------------------------------------------------------------
// Orders + hosted checkout.
//
// Schema mirrors Bookerva's production payment adapter (the proven path):
//   POST /orders { reference_id, total, kind:"online", title, currency_code,
//                  customer{email,first_name,last_name,phone}, products[],
//                  meta_data{...,return_url,cancel_url} }
//   → result { id, status, payment_urls:{ payment_url, short_link }, expires_at }
//
// IMPORTANT: Inkress `total` is in MAJOR units (e.g. 40.99 dollars), NOT minor.
// `kind:"online"` yields a hosted-checkout order that stays PENDING (status 1)
// until the customer pays; the payment webhook flips it to PAID (status 3).
// `reference_id` must be unique per order — use it to reconcile app draft →
// Inkress order without duplicates.
// ---------------------------------------------------------------------------

/**
 * Create a hosted-checkout Inkress order.
 * @param input {referenceId, total, currencyCode, title, customer,
 *   products?:[{product_id,quantity}], kind?, metaData?, returnUrl?, cancelUrl?}
 * @returns {id, payment_url, short_link, expires_at, status, raw}
 */
export async function createInkressOrder(cfg, accessToken, input) {
  const body = {
    reference_id: input.referenceId,
    total: input.total,
    kind: input.kind || "online",
    title: input.title,
    currency_code: input.currencyCode,
    customer: input.customer,
    ...(input.products?.length ? { products: input.products } : {}),
    meta_data: {
      ...(input.metaData || {}),
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
    },
  };
  const r = await inkressApi(cfg, accessToken, "orders", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const d = r?.result ?? r ?? {};
  return {
    id: d.id,
    payment_url: d.payment_urls?.payment_url ?? null,
    short_link: d.payment_urls?.short_link ?? null,
    frame_url: d.payment_urls?.frame_url ?? null,
    expires_at: d.expires_at ?? null,
    status: d.status,
    raw: d,
  };
}

/** Fetch a single Inkress order by id. Returns the `result` object or null. */
export async function getInkressOrder(cfg, accessToken, id) {
  const r = await inkressApi(cfg, accessToken, `orders/${encodeURIComponent(id)}`);
  return r?.result ?? null;
}

/** List Inkress orders. `query` is a raw querystring (without leading ?). */
export async function listInkressOrders(cfg, accessToken, query = "") {
  const r = await inkressApi(cfg, accessToken, `orders${query ? `?${query}` : ""}`);
  return r?.result ?? r ?? null;
}

// Inkress order status integers → names. Orders come back with an
// integer `status` (and sometimes a string `status_name`); apps that
// reason about "paid vs refunded vs pending" must normalise both.
// Source of truth: admin-sdk data-mappings Status.
const ORDER_STATUS = {
  1: "pending", 2: "error", 3: "paid", 4: "confirmed", 5: "cancelled",
  6: "prepared", 7: "shipped", 8: "delivered", 9: "completed",
  10: "returned", 11: "refunded", 12: "verifying", 13: "stale",
  14: "archived", 32: "partial",
};

/** Normalise an order's status to a lowercase string name, accepting
 *  either the integer `status` or the string `status_name`. */
export function orderStatusName(order) {
  const raw = order?.status_name ?? order?.status;
  if (typeof raw === "number") return ORDER_STATUS[raw] || "unknown";
  if (typeof raw === "string") {
    // Could be "order_paid", "paid", or a number-as-string.
    const n = Number(raw);
    if (!Number.isNaN(n)) return ORDER_STATUS[n] || "unknown";
    return raw.replace(/^order_/, "").toLowerCase();
  }
  return "unknown";
}

const PAID_STATES = new Set(["paid", "confirmed", "prepared", "shipped", "delivered", "completed"]);
export function isPaidStatus(order) {
  return PAID_STATES.has(orderStatusName(order));
}

function stripTrailingSlash(s) {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
function stripLeadingSlash(s) {
  return s.startsWith("/") ? s.slice(1) : s;
}
