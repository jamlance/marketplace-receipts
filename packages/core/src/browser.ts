/**
 * Canonical browser-side glue for every embedded app. Apps import this
 * (via their thin src/bv-init.ts re-export) so there's exactly one copy
 * to maintain.
 *
 * SESSION TRANSPORT — header, not cookie.
 *
 * The app runs in an iframe whose origin differs from the dashboard's,
 * so any cookie the server sets is a THIRD-PARTY cookie and gets
 * blocked by default in every modern browser. We therefore:
 *
 *   1. read `inkress_session` from the URL,
 *   2. POST it to /__bv/bootstrap,
 *   3. keep the returned opaque `session_id` in memory + sessionStorage,
 *   4. send it as `X-BV-Session` on every /api/* call.
 *
 * No cookies involved, so the cross-site iframe context is irrelevant.
 */

import { createInkressApp, type InkressApp } from "@inkress/app-bridge";

export interface BvUser {
  id: number | null;
  name: string | null;
  email: string | null;
}

export interface BvSession {
  inkress: InkressApp;
  merchant: {
    id: number;
    username: string | null;
    name: string | null;
    currency_code: string | null;
    email?: string | null;
    logo?: string | null;
  };
  /** The dashboard user operating the app — for attribution ("by X"). */
  user: BvUser;
  scopes: string[];
}

export interface BvToastFn {
  (message: string, kind?: "success" | "error" | "info" | "warning"): void;
}

const SESSION_KEY = "bv_app_session_id";

function getStoredSessionId(): string | null {
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    /* storage may be partitioned/blocked — fall back to memory */
  }
  return id || inMemorySessionId;
}

let inMemorySessionId: string | null = null;
let actorHeaders: Record<string, string> = {};

function storeSessionId(id: string) {
  inMemorySessionId = id;
  try {
    window.sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    /* ignore — in-memory copy still works for this page lifetime */
  }
}

export async function initBv(): Promise<BvSession> {
  // Grab the session JWT BEFORE the bridge SDK scrubs it from the URL.
  const params = new URLSearchParams(window.location.search);
  const sessionJwt = params.get("inkress_session");

  // Start the bridge (postMessage to the host; also scrubs the URL).
  const inkress = await createInkressApp();

  let merchantData: BvSession["merchant"] = {
    id: inkress.merchant.id,
    username: inkress.merchant.username,
    name: inkress.merchant.name,
    currency_code: inkress.merchant.currency_code,
  };
  let scopes = inkress.scopes;

  if (sessionJwt) {
    try {
      const r = await fetch("/__bv/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionJwt }),
      });
      if (r.ok) {
        const body = await r.json();
        if (body?.session_id) storeSessionId(body.session_id);
        if (body?.merchant) {
          merchantData = {
            id: body.merchant.id ?? merchantData.id,
            username: body.merchant.username ?? merchantData.username,
            name: body.merchant.name ?? merchantData.name,
            currency_code: body.merchant.currency_code ?? merchantData.currency_code,
            email: body.merchant.email ?? null,
            logo: body.merchant.logo ?? null,
          };
        }
        if (Array.isArray(body?.scopes)) scopes = body.scopes;
      } else {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail?.message || detail?.error || `bootstrap ${r.status}`);
      }
    } catch (err) {
      // Surface a clear error instead of silently degrading — a failed
      // bootstrap means no API access, which the app must show.
      inkress.notify({
        kind: "error",
        message: "Couldn't establish a session with Inkress. Try reloading.",
      });
      throw err;
    }
  } else {
    // No JWT at all — likely opened outside the dashboard. Still throw
    // so the app shows its fatal state rather than an empty shell.
    throw new Error("No session token — open this app from the Inkress dashboard.");
  }

  const u = inkress.user as { id?: number; name?: string; email?: string } | undefined;
  const user: BvUser = {
    id: u?.id ?? null,
    name: u?.name ?? null,
    email: u?.email ?? null,
  };
  actorHeaders = {
    "X-BV-User-Id": String(user.id ?? ""),
    "X-BV-User-Name": user.name ?? "",
  };

  return { inkress, merchant: merchantData, user, scopes };
}

export function makeToast(inkress: InkressApp): BvToastFn {
  return (message, kind = "info") => inkress.notify({ kind, message });
}

// Send attribution headers on writes so the server records who acted.
export function bvActor(session: BvSession): Record<string, string> {
  return {
    "X-BV-User-Id": String(session.user.id ?? ""),
    "X-BV-User-Name": session.user.name ?? "",
  };
}

export * from "./ui.js";
export { icon } from "./icons.js";

/** Authenticated fetch to the app's own server. Attaches X-BV-Session. */
export async function bvApi<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const sessionId = getStoredSessionId();
  const r = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Accept: "application/json",
      ...(sessionId ? { "X-BV-Session": sessionId } : {}),
      ...actorHeaders,
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  if (!r.ok) {
    const msg = body?.message || body?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body as T;
}
