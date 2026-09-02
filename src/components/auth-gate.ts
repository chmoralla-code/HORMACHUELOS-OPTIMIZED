import { api } from "../ipc";
import { el } from "./util";

const HOSTED_API = "https://hormachuelos.vercel.app";

type DeviceStart = {
  ok: boolean;
  userCode: string;
  deviceCode: string;
  verifyUrl: string;
  intervalSeconds?: number;
};

type DevicePoll = {
  ok: boolean;
  status: "pending" | "complete" | "expired" | "claimed" | string;
  token?: string;
  waitingForRelink?: boolean;
  user?: WebsiteAccount;
};

export type WebsiteAccount = {
  id?: string;
  email: string;
  name?: string;
  plan?: string | null;
  licenseKey?: string | null;
  credits?: number;
  emailVerified?: boolean;
  tokenBudget?: number;
  tokensUsed?: number;
  licenseActive?: boolean;
  expiresAt?: string;
  planRemainingPct?: number;
};

export class WebsiteAccountRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WebsiteAccountRequestError";
  }
}

export function isWebsiteSessionRejected(error: unknown): boolean {
  return (
    error instanceof WebsiteAccountRequestError &&
    (error.status === 401 || error.status === 403)
  );
}

async function hostedFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${HOSTED_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data;
}

function readableNetworkError(error: unknown): string {
  const message = String((error as Error)?.message || error || "");
  if (/failed to fetch|networkerror|load failed|connection/i.test(message)) {
    return "Can't reach the Hormachuelos sign-in service yet. Retrying automatically…";
  }
  return message || "Sign-in service unavailable. Retrying automatically…";
}

export async function fetchWebsiteAccount(token: string): Promise<WebsiteAccount> {
  const res = await fetch(`${HOSTED_API}/api/auth/me`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WebsiteAccountRequestError(
      (data as { error?: string }).error || "Session expired",
      res.status,
    );
  }
  const user = (data as { user?: WebsiteAccount }).user;
  if (!user || typeof user.email !== "string" || !user.email.trim()) {
    throw new WebsiteAccountRequestError("Invalid account response", 502);
  }
  return user;
}

export async function ensureWebsiteSession(): Promise<WebsiteAccount | null> {
  let token: string | null = null;
  try {
    token = await api.getWebsiteSession();
  } catch {
    /* fallback to localStorage */
  }
  if (!token) {
    try {
      token = localStorage.getItem("horma:website_session");
    } catch {
      /* ignore */
    }
  }
  if (!token) return null;
  try {
    return await fetchWebsiteAccount(token);
  } catch (error) {
    // A CSP/network/service outage is not a logout. Preserve the encrypted
    // session so it can be verified again when connectivity recovers.
    if (isWebsiteSessionRejected(error)) {
      await api.clearWebsiteSession().catch(() => {});
      try {
        localStorage.removeItem("horma:website_session");
      } catch {}
    }
    return null;
  }
}

/**
 * Full-screen gate: opens the website for login/signup, polls until the browser
 * session is linked, then stores the desktop session token locally.
 */
export function showAuthGate(onSignedIn: (user: WebsiteAccount) => void): HTMLElement {
  const overlay = el("div", { class: "auth-gate-overlay", role: "dialog", "aria-modal": "true" });
  const card = el("div", { class: "auth-gate-card" });
  card.appendChild(el("div", { class: "auth-gate-brand" }, ["HORMACHUELOS"]));
  card.appendChild(el("h1", { class: "auth-gate-title" }, ["Sign in to continue"]));
  card.appendChild(
    el("p", { class: "auth-gate-sub" }, [
      "If you're already signed in on the website, the browser will link this app automatically. Keep this window open.",
    ]),
  );

  const status = el("p", { class: "auth-gate-status", role: "status" }, [
    "Preparing secure login…",
  ]);
  const codeEl = el("div", { class: "auth-gate-code mono", hidden: "true" }, []);
  const openBtn = el("button", { class: "btn primary", type: "button" }, [
    "Open website to log in / sign up",
  ]) as HTMLButtonElement;
  openBtn.disabled = true;
  const hint = el("p", { class: "auth-gate-hint" }, [
    "Already logged in on hormachuelos.vercel.app? Use the same browser window that opens — click “Link desktop now” if it doesn’t finish automatically.",
  ]);

  card.appendChild(status);
  card.appendChild(codeEl);
  card.appendChild(openBtn);
  card.appendChild(hint);
  overlay.appendChild(card);

  let deviceCode = "";
  let verifyUrl = "";
  let timer: number | null = null;
  let retryTimer: number | null = null;
  let retryDelayMs = 1_500;
  let stopped = false;
  let finishing = false;
  let startedAt = 0;

  const stop = () => {
    stopped = true;
    if (timer != null) window.clearInterval(timer);
    if (retryTimer != null) window.clearTimeout(retryTimer);
    timer = null;
    retryTimer = null;
  };

  const finish = async (token: string, user: WebsiteAccount) => {
    if (finishing) return;
    finishing = true;
    stop();
    status.textContent = "Saving sign-in…";
    try {
      try {
        await api.setWebsiteSession(token);
      } catch (err) {
        console.warn("api.setWebsiteSession warning", err);
      }
      try {
        localStorage.setItem("horma:website_session", token);
      } catch {
        /* ignore */
      }

      // Re-verify with /api/auth/me if reachable, or use the authenticated profile from poll
      let verified = user;
      try {
        const fresh = await fetchWebsiteAccount(token);
        if (fresh && fresh.email) {
          verified = fresh;
        }
      } catch (fetchErr) {
        console.warn("fetchWebsiteAccount verification warning, using polled user profile", fetchErr);
      }

      if (verified.licenseKey) {
        try {
          await api.applyLicenseKey(verified.licenseKey);
          window.dispatchEvent(new CustomEvent("horma:license-updated"));
        } catch (e) {
          console.warn("auto license apply failed", e);
        }
      }
      status.textContent = `Signed in as ${verified.email}`;
      overlay.remove();
      try {
        onSignedIn(verified);
      } catch (uiErr) {
        console.error("onSignedIn callback error", uiErr);
      }
    } catch (e) {
      finishing = false;
      status.textContent = `Could not save session: ${String((e as Error).message || e)}. Retrying…`;
      openBtn.disabled = false;
      // Restart pairing so website can mint a fresh token.
      window.setTimeout(() => {
        void begin();
      }, 1200);
    }
  };

  const poll = async () => {
    if (stopped || !deviceCode || finishing) return;
    try {
      const data = (await hostedFetch("/api/auth/device-poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode }),
      })) as DevicePoll;

      if (data.status === "pending") {
        status.textContent = data.waitingForRelink
          ? "Website linked — waiting for sign-in token… click “Link desktop now” in the browser if needed."
          : "Waiting for website login…";
        // Soft timeout: restart pairing after 12 minutes so codes stay fresh.
        if (startedAt && Date.now() - startedAt > 12 * 60 * 1000) {
          status.textContent = "Login timed out. Starting a fresh link…";
          void begin();
        }
        return;
      }

      if (data.status === "expired") {
        status.textContent = "Login code expired. Starting a fresh link…";
        void begin();
        return;
      }

      // Older servers returned "claimed" as a dead-end; treat as wait/retry.
      if (data.status === "claimed") {
        status.textContent =
          "Browser linked — waiting for token. Click “Link desktop now” or “Send link again” on the website.";
        return;
      }

      if (data.status === "complete") {
        if (!data.token) {
          status.textContent = "Almost there — waiting for website to send the session…";
          return;
        }
        status.textContent = "Linking desktop…";
        const user: WebsiteAccount = {
          email: data.user?.email || "account",
          name: data.user?.name,
          licenseKey: data.user?.licenseKey ?? null,
          plan: data.user?.plan ?? null,
          tokenBudget: data.user?.tokenBudget,
          tokensUsed: data.user?.tokensUsed,
          licenseActive: data.user?.licenseActive,
          expiresAt: data.user?.expiresAt,
          planRemainingPct: data.user?.planRemainingPct,
          credits: data.user?.credits,
          emailVerified: data.user?.emailVerified,
        };
        await finish(data.token, user);
      }
    } catch (e) {
      status.textContent = readableNetworkError(e);
    }
  };

  const begin = async () => {
    stop();
    stopped = false;
    finishing = false;
    openBtn.disabled = true;
    status.textContent = "Starting secure login…";
    try {
      const data = (await hostedFetch("/api/auth/device-start", {
        method: "POST",
        body: "{}",
      })) as DeviceStart;
      deviceCode = data.deviceCode;
      verifyUrl = data.verifyUrl;
      startedAt = Date.now();
      retryDelayMs = 1_500;
      codeEl.hidden = false;
      codeEl.textContent = data.userCode;
      status.textContent = "Browser will open — if you're already signed in, it links automatically.";
      openBtn.disabled = false;
      openBtn.textContent = "Open website to finish sign-in";
      try {
        await api.openExternalUrl(verifyUrl);
      } catch {
        /* user can click the button */
      }
      const interval = Math.max(2, Number(data.intervalSeconds) || 2) * 1000;
      timer = window.setInterval(() => {
        void poll();
      }, interval);
      void poll();
    } catch (e) {
      status.textContent = readableNetworkError(e);
      openBtn.disabled = false;
      const delay = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!finishing) void begin();
      }, delay);
    }
  };

  openBtn.addEventListener("click", () => {
    if (verifyUrl) {
      void api.openExternalUrl(verifyUrl).catch(() => window.open(verifyUrl, "_blank"));
      status.textContent = "Browser opened — finish linking there, then return here.";
      return;
    }
    void begin();
  });

  void begin();
  return overlay;
}
