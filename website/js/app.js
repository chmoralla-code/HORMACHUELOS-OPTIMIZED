/**
 * Hormachuelos marketing site — SPA with server auth (email/password, no email magic links).
 * PHP pricing with a secure GCash proof-review checkout.
 */

const STORAGE_USER = "horma:user";
const STORAGE_TOKEN = "horma:token";
const STORAGE_ADMIN = "horma:admin";
const STORAGE_ORDERS = "horma:orders";
const STORAGE_PAYMENT_REQUESTS = "horma:payment_requests";
const STORAGE_DESKTOP_CODE = "horma:desktop_code";
const STORAGE_DESKTOP_FLOW = "horma:desktop_flow";

/** Hosted marketing media, such as the product demo video. */
const ASSET_BASE =
  "https://mketkzycxmtvgdbwzsvh.supabase.co/storage/v1/object/public/public-assets";

/**
 * The verified GitHub Release mirror is the website's first-paint fallback.
 * The update API can still replace it with an admin-published asset URL.
 */
const RELEASE_DOWNLOAD_BASE =
  "https://github.com/chmoralla-code/HORMACHUELOS/releases/download/v0.1.76";

/** Desktop installer files for the current production release. */
const DESKTOP_DOWNLOADS = {
  version: "0.1.76",
  windows: {
    msi: {
      label: "Windows installer (MSI)",
      href: `${RELEASE_DOWNLOAD_BASE}/Hormachuelos_0.1.76_x64_en-US.msi`,
      file: "Hormachuelos_0.1.76_x64_en-US.msi",
    },
    setup: {
      label: "Windows setup (EXE)",
      href: `${RELEASE_DOWNLOAD_BASE}/Hormachuelos_0.1.76_x64-setup.exe`,
      file: "Hormachuelos_0.1.76_x64-setup.exe",
    },
  },
};

/** Independent FPS-focused edition with Adaptive Director and maximized modes. */
const OPTIMIZED_DOWNLOAD_BASE =
  "https://github.com/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases/download/v1.2.13";

const OPTIMIZED_DOWNLOADS = {
  version: "1.2.13",
  releaseNotes: "https://github.com/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases/tag/v1.2.13",
  windows: {
    msi: {
      label: "Optimized installer (MSI)",
      href: `${OPTIMIZED_DOWNLOAD_BASE}/Hormachuelos_Optimized_1.2.13_x64.msi`,
    },
    setup: {
      label: "Optimized setup (EXE)",
      href: `${OPTIMIZED_DOWNLOAD_BASE}/Hormachuelos_Optimized_1.2.13_x64-setup.exe`,
    },
  },
};

function primaryDownloadHref() {
  return DESKTOP_DOWNLOADS.windows.msi.href;
}

function renderDownloadButton(extraClass = "btn-lg") {
  const cls = extraClass ? ` ${extraClass}` : "";
  return `<a class="btn${cls}" href="${primaryDownloadHref()}" download="${DESKTOP_DOWNLOADS.windows.msi.file}">Download</a>`;
}

function renderDownloadButtons(extraClass = "") {
  const cls = extraClass ? ` ${extraClass}` : "";
  return `
    <a class="btn btn-primary btn-lg${cls}" href="${primaryDownloadHref()}" download="${DESKTOP_DOWNLOADS.windows.msi.file}">
      Download for Windows
    </a>
    <a class="btn btn-lg${cls}" href="${DESKTOP_DOWNLOADS.windows.setup.href}" download="${DESKTOP_DOWNLOADS.windows.setup.file}">
      Setup (.exe)
    </a>
  `;
}

/** Usage-limit base pricing — pay as you go (PHP). */
const BILLING = {
  payg: {
    id: "payg",
    label: "Pay as you go",
    short: "usage",
    period: "usage-based",
  },
};

/** Max tiers — multipliers for team plans (token pools stay server-side). */
const MAX_ROI_TIERS = {
  "5x": {
    id: "max5",
    label: "5×",
    multiplier: 5,
    price: 2499,
    tagline: "Teams & parallel builds",
  },
  "10x": {
    id: "max10",
    label: "10×",
    multiplier: 10,
    price: 4999,
    tagline: "Agency sprints",
  },
  "20x": {
    id: "max20",
    label: "20×",
    multiplier: 20,
    price: 9999,
    tagline: "Multi-seat shops",
  },
};

const GCASH_RECEIVER_LABEL = "CH*****O M.";

/** Keep in sync with website/api/_lib/payments.js PLAN_CHECKOUTS. */
const GCASH_CHECKOUTS = {
  starter: { planName: "Starter", amountPhp: 299, qrPath: "/images/gcash/gcash-299.png" },
  pro: { planName: "Pro", amountPhp: 999, qrPath: "/images/gcash/gcash-999.png" },
  proplus: { planName: "Pro+", amountPhp: 2499, qrPath: "/images/gcash/gcash-2499.png" },
  max5: { planName: "Max 5×", amountPhp: 2499, qrPath: "/images/gcash/gcash-2499.png" },
  max10: { planName: "Max 10×", amountPhp: 4999, qrPath: "/images/gcash/gcash-4999.png" },
  max20: { planName: "Max 20×", amountPhp: 9999, qrPath: "/images/gcash/gcash-9999.png" },
};

function normalizeCheckoutPlanId(planId, tierKey = "") {
  const id = String(planId || "pro").toLowerCase();
  if (id === "max" || id === "agency" || id === "ultra") {
    const tier = MAX_ROI_TIERS[tierKey] || MAX_ROI_TIERS["5x"];
    return tier?.id || "max5";
  }
  if (id === "pro+" || id === "pro_plus") return "proplus";
  if (id === "fifteen" || id === "15day" || id === "15-day") return "pro";
  return id;
}

function gcashCheckoutDetails(planId, tierKey = "") {
  const normalized = normalizeCheckoutPlanId(planId, tierKey);
  const details = GCASH_CHECKOUTS[normalized];
  if (!details) {
    return { planId: "pro", ...GCASH_CHECKOUTS.pro, receiverLabel: GCASH_RECEIVER_LABEL };
  }
  return { planId: normalized, ...details, receiverLabel: GCASH_RECEIVER_LABEL };
}

const PLANS = [
  {
    id: "starter",
    name: "Starter",
    desc: "Real client work on your first GCash load.",
    featured: false,
    price: 299,
    features: [
      "Full desktop agent (GPT 5.6, Opus 5, Claude & more)",
      "Included usage wallet",
      "Plan · Auto modes",
      "Pinoy templates + Client Pack",
      "GCash QR checkout",
      "Messenger support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    desc: "Daily client builds and serious side projects.",
    featured: true,
    price: 999,
    features: [
      "Everything in Starter",
      "Larger usage wallet",
      "Full autonomy mode",
      "Priority model routing",
      "GCash proof review",
      "Client Pack + deploy checklist",
      "Priority support (Viber / FB)",
    ],
  },
  {
    id: "max",
    name: "Max",
    tierLabel: "5× · 10× · 20×",
    desc: "Teams billing multiple clients in parallel.",
    featured: false,
    tiers: MAX_ROI_TIERS,
    defaultTier: "5x",
    features: [
      "Everything in Pro",
      "Highest usage headroom",
      "Up to 5 team seats",
      "Shared workspaces",
      "BIR-ready receipts",
      "Dedicated onboarding call",
    ],
  },
];

const FEATURES = [
  { icon: "AI", title: "Local-first agent", body: "Open a project folder and let the agent read, edit, and run tools — on your machine." },
  { icon: "₱", title: "Pay with GCash", body: "No foreign card required. Pay the exact PHP amount through GCash, then submit a receipt proof for review." },
  { icon: "Pk", title: "Client Pack", body: "One-click zip + CLIENT_HANDOFF.md with deploy checklist — ready to send to clients." },
  { icon: "Pl", title: "Plan · Auto · Full", body: "Start careful, scale autonomy when you trust the run. OpenCode-style controls." },
  { icon: "Mo", title: "Bring your models", body: "DeepSeek, OpenRouter, and more. Your keys, your spend, your rules." },
  { icon: "Ms", title: "Taglish + PH templates", body: "Reply in Taglish. Start from portfolio, sari-sari, booking, or FB ads landing." },
  { icon: "Cr", title: "Credit top-ups", body: "Mag-load when you need more tokens. Same wallet flow you already use daily." },
];

const FAQ = [
  {
    q: "Bakit mas unique ang Hormachuelos vs Cursor / ChatGPT?",
    a: "Global AI tools almost never accept GCash. We price in ₱ PHP and support GCash checkout so freelancers and students can pay without a credit card or USD billing.",
  },
  {
    q: "Real ba ang GCash payment ngayon?",
    a: "Yes. After choosing a plan, you will see its exact GCash QR amount, upload a clear receipt image, and receive the plan after the receipt passes automated checks or a manual review.",
  },
  {
    q: "Paano gumagana ang pay-as-you-go pricing?",
    a: "Each plan includes a generous usage limit. When you need more, mag-load credits via GCash — no fixed monthly lock-in. Pay only for what you actually use.",
  },
  {
    q: "Kasama ba ang model API costs?",
    a: "Subscription unlocks the agent and a token budget. Heavy use may need GCash credit top-ups. You can also bring your own provider API keys.",
  },
  {
    q: "Pwede ba i-refund?",
    a: "Within 7 days of first paid purchase if you have not heavily used the token allotment — see Refunds. Contact support with your order id.",
  },
  {
    q: "Desktop app ba o web?",
    a: "Hormachuelos is a desktop agent (Tauri). This website handles account, plans, and GCash-ready billing.",
  },
];

// ——— storage helpers ———

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getSessionUser() {
  return loadJSON(STORAGE_USER, null);
}

function getSessionToken() {
  return localStorage.getItem(STORAGE_TOKEN) || "";
}

function setSessionUser(user, token) {
  if (user) saveJSON(STORAGE_USER, user);
  else localStorage.removeItem(STORAGE_USER);
  if (token) localStorage.setItem(STORAGE_TOKEN, token);
  if (!user) localStorage.removeItem(STORAGE_TOKEN);
}

function authHeaders(extra = {}) {
  const token = getSessionToken();
  const headers = { Accept: "application/json", ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiAuth(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.email = data.email;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshSessionUser() {
  if (!getSessionToken()) return null;
  try {
    const data = await apiAuth("/api/auth/me");
    setSessionUser(data.user, getSessionToken());
    if (Array.isArray(data.orders)) saveJSON(STORAGE_ORDERS, data.orders);
    if (Array.isArray(data.paymentRequests)) setPaymentRequests(data.paymentRequests);
    return data.user;
  } catch {
    setSessionUser(null);
    return null;
  }
}

function desktopCodeFromQuery() {
  const dcode = queryOf().get("dcode") || queryOf().get("desktop_code");
  if (dcode) return String(dcode).trim().toUpperCase();
  // Legacy: code=ABCD-EFGH (not a 6-digit email OTP)
  const code = String(queryOf().get("code") || "").trim().toUpperCase();
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return code;
  return "";
}

function rememberDesktopLinkFromUrl() {
  const code = desktopCodeFromQuery();
  if (code) {
    try {
      sessionStorage.setItem(STORAGE_DESKTOP_CODE, code);
      sessionStorage.setItem(STORAGE_DESKTOP_FLOW, "1");
    } catch {
      /* private mode */
    }
  } else if (queryOf().get("desktop") === "1") {
    try {
      sessionStorage.setItem(STORAGE_DESKTOP_FLOW, "1");
    } catch {
      /* ignore */
    }
  }
}

function pendingDesktopCode() {
  const fromUrl = desktopCodeFromQuery();
  if (fromUrl) return fromUrl;
  try {
    return String(sessionStorage.getItem(STORAGE_DESKTOP_CODE) || "").trim().toUpperCase();
  } catch {
    return "";
  }
}

function clearPendingDesktopLink() {
  try {
    sessionStorage.removeItem(STORAGE_DESKTOP_CODE);
    sessionStorage.removeItem(STORAGE_DESKTOP_FLOW);
  } catch {
    /* ignore */
  }
}

function isDesktopLinkFlow() {
  rememberDesktopLinkFromUrl();
  if (queryOf().get("desktop") === "1" || Boolean(desktopCodeFromQuery())) return true;
  try {
    return sessionStorage.getItem(STORAGE_DESKTOP_FLOW) === "1" || Boolean(pendingDesktopCode());
  } catch {
    return false;
  }
}

function withDesktopParams(path) {
  const code = pendingDesktopCode();
  if (!isDesktopLinkFlow()) return path;
  const base = path.startsWith("/") ? path : `/${path}`;
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}desktop=1${code ? `&dcode=${encodeURIComponent(code)}` : ""}`;
}

async function finishDesktopLinkIfNeeded() {
  rememberDesktopLinkFromUrl();
  const code = pendingDesktopCode();
  if (!code || !getSessionToken()) return false;
  try {
    const data = await apiAuth("/api/auth/device-complete", {
      method: "POST",
      body: { code },
    });
    // Keep pairing code so "Send link again" can re-issue a desktop token.
    toast(data.message || "Desktop app linked");
    navigate("/desktop-linked");
    return true;
  } catch (ex) {
    toast(String(ex.message || ex));
    return false;
  }
}

function getOrders() {
  return loadJSON(STORAGE_ORDERS, []);
}

function addOrder(order) {
  const orders = getOrders();
  orders.unshift(order);
  saveJSON(STORAGE_ORDERS, orders);
  return order;
}

function getPaymentRequests() {
  return loadJSON(STORAGE_PAYMENT_REQUESTS, []);
}

function setPaymentRequests(requests) {
  const safe = Array.isArray(requests) ? requests.filter((request) => request?.id) : [];
  saveJSON(STORAGE_PAYMENT_REQUESTS, safe.slice(0, 30));
}

function upsertPaymentRequest(request) {
  if (!request?.id) return;
  const next = [request, ...getPaymentRequests().filter((item) => item?.id !== request.id)];
  setPaymentRequests(next);
}

function formatPHP(n) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(n);
}

function paymentStatusText(status) {
  const labels = {
    awaiting_proof: "Waiting for proof",
    upload_ready: "Ready to scan",
    scanning: "Scanning receipt",
    review_required: "Needs review",
    approval_processing: "Activating plan",
    approved: "Approved",
    rejected: "Rejected",
    scan_failed: "Scan needs review",
  };
  return labels[String(status || "").toLowerCase()] || "Payment request";
}

function paymentStatusTone(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "approved") return "ok";
  if (normalized === "rejected") return "danger";
  if (normalized === "review_required" || normalized === "scan_failed") return "warn";
  return "pending";
}

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ——— routing ———

const routes = {
  "/": renderHome,
  "/features": renderFeatures,
  "/pricing": renderPricing,
  "/login": renderLogin,
  "/signup": renderSignup,
  "/verify": renderVerify,
  "/desktop-linked": renderDesktopLinked,
  "/dashboard": renderDashboard,
  "/admin": renderAdmin,
  "/checkout": renderCheckout,
  "/download": renderDownload,
  "/update": renderUpdate,
  "/faq": renderFaq,
  "/support": renderSupport,
  "/terms": () => renderLegal("Terms of Service", TERMS),
  "/privacy": () => renderLegal("Privacy Policy", PRIVACY),
  "/refund": () => renderLegal("Refund Policy", REFUNDS),
  "/success": renderSuccess,
};

function pathOf() {
  const h = location.hash.replace(/^#/, "") || "/";
  const path = h.split("?")[0];
  return path.startsWith("/") ? path : `/${path}`;
}

function queryOf() {
  const h = location.hash.replace(/^#/, "") || "/";
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
  return new URLSearchParams(q);
}

function navigate(path) {
  location.hash = path.startsWith("#") ? path : `#${path}`;
}

/** Cancel timers from previous page (typewriters, demos). */
let pageCleanups = [];

function onPageCleanup(fn) {
  pageCleanups.push(fn);
}

function runPageCleanups() {
  for (const fn of pageCleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  pageCleanups = [];
}

function render() {
  runPageCleanups();
  const path = pathOf();
  const main = document.getElementById("main");
  const fn = routes[path] || renderNotFound;
  main.innerHTML = "";
  main.appendChild(fn());
  updateHeader();
  document.querySelectorAll(".nav a").forEach((a) => {
    const href = a.getAttribute("href")?.replace(/^#/, "") || "";
    a.classList.toggle("active", href === path || (path === "/" && href === "/"));
  });
  window.scrollTo(0, 0);
  document.getElementById("nav")?.classList.remove("open");
  document.getElementById("nav-toggle")?.setAttribute("aria-expanded", "false");
  // After DOM is in, wire interactive text
  requestAnimationFrame(() => initTextInteractions(main));
}

function updateHeader() {
  const host = document.getElementById("header-actions");
  if (!host) return;
  host.innerHTML = "";
  const user = getSessionUser();
  if (user) {
    const chip = document.createElement("a");
    chip.href = "#/dashboard";
    chip.className = "user-chip";
    chip.innerHTML = `<span class="av">${escapeHtml((user.name || user.email)[0].toUpperCase())}</span><span class="name">${escapeHtml(user.name || user.email)}</span>`;
    host.appendChild(chip);
    const out = document.createElement("button");
    out.type = "button";
    out.className = "btn btn-sm btn-ghost";
    out.textContent = "Log out";
    out.addEventListener("click", async () => {
      try {
        await apiAuth("/api/auth/logout", { method: "POST" });
      } catch {
        /* ignore network errors on logout */
      }
      setSessionUser(null);
      toast("Logged out");
      navigate("/");
      render();
    });
    host.appendChild(out);
  } else {
    const login = document.createElement("a");
    login.href = "#/login";
    login.className = "btn btn-sm btn-ghost";
    login.textContent = "Log in";
    host.appendChild(login);
    const signup = document.createElement("a");
    signup.href = "#/signup";
    signup.className = "btn btn-sm btn-primary";
    signup.textContent = "Sign up";
    host.appendChild(signup);
  }
}

// ——— pages ———

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function page(childrenHtml) {
  return el(`<div class="page">${childrenHtml}</div>`);
}

function renderHome() {
  return page(`
    <section class="hero container">
      <div class="eyebrow ix-reveal" data-delay="0"><span class="dot"></span> Built for PH · GCash ready</div>
      <h1 class="ix-headline ix-hero-headline ix-reveal" data-delay="0" aria-label="OpenAI, Claude, DeepSeek, Hormachuelos, Ollama, OpenRouter. All models in one place.">
        <span class="ix-hero-models">
          <span class="ix-model-chip" data-provider="openai" style="--ix-delay:0" tabindex="0">OpenAi</span><span class="ix-hero-sep">,</span>
          <span class="ix-model-chip" data-provider="claude" style="--ix-delay:1" tabindex="0">Claude</span><span class="ix-hero-sep">,</span>
          <span class="ix-model-chip" data-provider="deepseek" style="--ix-delay:2" tabindex="0">Deepseek</span><span class="ix-hero-sep">,</span>
          <span class="ix-model-chip" data-provider="hormachuelos" style="--ix-delay:3" tabindex="0">Hormachuelos</span><span class="ix-hero-sep">,</span>
          <span class="ix-model-chip" data-provider="ollama" style="--ix-delay:4" tabindex="0">Ollama</span><span class="ix-hero-sep">,</span>
          <span class="ix-model-chip" data-provider="openrouter" style="--ix-delay:5" tabindex="0">Openrouter</span><span class="ix-hero-sep">.</span>
        </span>
        <span class="ix-hero-tagline">
          <span class="ix-static">All models in </span>
          <span class="ix-type-wrap" aria-live="polite">
            <span id="hero-type" class="ix-type" data-phrases="one place|one desktop|one checkout|your workflow">one place</span>
            <span class="ix-caret" aria-hidden="true"></span>
          </span>
        </span>
      </h1>
      <p class="lead ix-reveal" data-delay="1" data-ix-hover-words>
        PinoyMade ARTIFICIAL INTELLIGENCE (GUI) software and a website that is easy to use and built for vibe coders that don't have bank accounts.
      </p>
      <div class="hero-cta ix-reveal" data-delay="2">
        <a class="btn btn-primary btn-lg" href="#/pricing">View pricing</a>
        ${renderDownloadButton("btn-lg")}
        <a class="btn btn-lg" href="#/download">Optimized v${OPTIMIZED_DOWNLOADS.version}</a>
      </div>
      <div class="trust-row ix-reveal" data-delay="3">
        <button type="button" class="trust-chip" data-tip="Pay the exact amount then upload one clear receipt">GCash QR + proof review</button>
        <button type="button" class="trust-chip" data-tip="No USD conversion surprises">₱ transparent pricing</button>
        <button type="button" class="trust-chip" data-tip="Agent works on your local folders">Desktop agent · your folders</button>
      </div>
    </section>

    <section class="section demo-video-section">
      <div class="container">
        <figure class="demo-video-wrap ix-reveal">
          <figcaption class="demo-video-caption">DEMO WITH THE SOFTWARE</figcaption>
          <video
            class="demo-video"
            controls
            playsinline
            autoplay
            muted
            preload="auto"
            poster=""
            aria-label="Hormachuelos software demo"
          >
            <source src="${ASSET_BASE}/videos/hormachuelos-demo-ad.mp4" type="video/mp4" />
            Your browser does not support video playback.
          </video>
        </figure>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="section-head center ix-reveal">
          <h2 data-ix-split>Them vs us</h2>
          <p>Temporary comparison — prices illustrative. Click a row.</p>
        </div>
        <div class="compare ix-reveal">
          <table id="compare-table">
            <thead>
              <tr><th></th><th>Typical global AI</th><th>Hormachuelos</th></tr>
            </thead>
            <tbody>
              <tr tabindex="0" data-line="They stop at Visa. We start at GCash."><td>GCash</td><td class="no">No</td><td class="yes">Yes</td></tr>
              <tr tabindex="0" data-line="Every receipt gets amount, duplicate, and visual-risk checks."><td>Receipt review</td><td class="no">No</td><td class="yes">Yes</td></tr>
              <tr tabindex="0" data-line="See ₱ on the price tag, not $20 + FX."><td>PHP pricing</td><td class="no">USD + FX</td><td class="yes">₱ PHP</td></tr>
              <tr tabindex="0" data-line="Message us on Messenger — 09505339963."><td>Local support</td><td class="no">Email / Discord</td><td class="yes"><a class="compare-messenger" href="https://www.facebook.com/profile.php?id=61584774638218" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Messenger</a> + 09505339963</td></tr>
              <tr tabindex="0" data-line="No expiry — keep building on your plan wallet."><td>Usage reset</td><td class="no">Hourly · Weekly · Monthly</td><td class="yes">No Expiry</td></tr>
              <tr tabindex="0" data-line="Starter from ₱299 — lowest subscription, no card drama."><td>From</td><td class="no">~$20/mo card</td><td class="yes">299php lowest subscription</td></tr>
            </tbody>
          </table>
          <p class="compare-live mono" id="compare-live" aria-live="polite">Click a row to hear the pitch…</p>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="cta-band ix-reveal">
          <p data-ix-hover-words>Choose a plan, pay its exact GCash amount, then track your private proof review from the dashboard.</p>
          <a class="btn btn-primary btn-lg" href="#/pricing">See plans</a>
        </div>
      </div>
    </section>
  `);
}

function renderFeatures() {
  return page(`
    <section class="section" style="border-top:0;padding-top:48px">
      <div class="container">
        <div class="section-head ix-reveal">
          <h2 data-ix-split>Features</h2>
          <p data-ix-hover-words>Everything you need to ship client work and side projects without fighting payment walls. Hover any line.</p>
        </div>
        <div class="grid-3">
          ${FEATURES.map(
            (f, i) => `
            <article class="card ix-card ix-reveal" data-delay="${i % 3}" tabindex="0">
              <div class="card-icon">${f.icon}</div>
              <h3 data-ix-split>${escapeHtml(f.title)}</h3>
              <p class="ix-body" data-ix-hover-words>${escapeHtml(f.body)}</p>
            </article>`,
          ).join("")}
        </div>
      </div>
    </section>
  `);
}

function findPlanByCheckoutId(planId, tierKey = "") {
  const id = normalizeCheckoutPlanId(planId, tierKey);
  for (const plan of PLANS) {
    if (plan.id === id) return { plan, tier: null };
    if (plan.tiers) {
      for (const tier of Object.values(plan.tiers)) {
        if (tier.id === id) return { plan, tier };
      }
    }
  }
  return { plan: PLANS[1], tier: null };
}

function checkoutAmount(planId, tierKey = "") {
  return gcashCheckoutDetails(planId, tierKey).amountPhp;
}

function checkoutPlanLabel(planId, tierKey = "") {
  const { plan, tier } = findPlanByCheckoutId(planId, tierKey);
  if (tier) return `Max ${tier.label}`;
  return plan.name;
}

function renderPricing() {
  const wrap = page(`
    <section class="section" style="border-top:0;padding-top:48px">
      <div class="container">
        <div class="section-head center ix-reveal">
          <h2 data-ix-split>Pricing</h2>
          <p data-ix-hover-words>Pay-as-you-go in ₱ PHP. Pick a plan, load GCash when you need more.</p>
          <p class="pricing-live mono" id="pricing-live" aria-live="polite"></p>
        </div>
        <div class="center">
          <p class="pricing-model-badge" id="pricing-model">Usage limit base pricing (Pay as you go)</p>
        </div>
        <div class="pricing-grid" id="pricing-grid"></div>
        <div class="gcash-note ix-reveal">
          <span class="pay-badge">GCash</span>
          <span class="pay-badge">Exact ₱ amount</span>
          <span class="ix-type-once" data-text="Private proof upload · secure review"></span>
        </div>
      </div>
    </section>
  `);

  const period = "payg";
  let maxTier = "5x";
  const grid = wrap.querySelector("#pricing-grid");
  const live = wrap.querySelector("#pricing-live");

  function resolvePlanCheckout(plan, tierKey = maxTier) {
    if (plan.tiers) {
      const tier = plan.tiers[tierKey] || plan.tiers[plan.defaultTier || "5x"];
      return { planId: tier.id, price: tier.price, tierKey, tier, label: `Max ${tier.label}` };
    }
    return { planId: plan.id, price: plan.price, tierKey: null, tier: null, label: plan.name };
  }

  function featureLabel(f) {
    return typeof f === "string" ? f : f.title;
  }

  function paintCards(animate = false) {
    grid.innerHTML = PLANS.map((plan) => {
      const checkout = resolvePlanCheckout(plan);
      const price = checkout.price;
      const tier = checkout.tier;
      const tierToggle = plan.tiers
        ? `<div class="price-card-max">
            <p class="plan-tier-label">${escapeHtml(plan.tierLabel || "")}</p>
            <div class="max-tier-toggle" role="tablist" aria-label="Max usage multiplier">
              ${Object.entries(plan.tiers)
                .map(
                  ([key, t]) =>
                    `<button type="button" role="tab" class="${key === maxTier ? "active" : ""}" data-max-tier="${key}" aria-selected="${key === maxTier}">${t.label}</button>`,
                )
                .join("")}
            </div>
          </div>`
        : "";
      const tierMeta = "";
      return `
        <article class="price-card ix-card ${plan.featured ? "featured" : ""}" data-plan-card="${plan.id}" tabindex="0">
          ${plan.featured ? `<span class="badge">Popular</span>` : ""}
          <header class="price-card-head">
            <div class="plan-name">${escapeHtml(plan.name)}</div>
            <p class="plan-desc">${escapeHtml(plan.desc)}</p>
          </header>
          ${tierToggle}
          <div class="price-block">
            <div class="price-amount">
              <span class="currency">₱</span>
              <span class="num" data-count-to="${price}" data-animate="${animate ? "1" : "0"}">${price.toLocaleString("en-PH")}</span>
            </div>
            <p class="price-note">Pay as you go · GCash top-ups</p>
          </div>
          ${tierMeta}
          <ul class="feature-list feature-list-compact">
            ${plan.features.map((f) => `<li>${escapeHtml(featureLabel(f))}</li>`).join("")}
          </ul>
          <button type="button" class="btn ${plan.featured ? "btn-primary" : ""} btn-block" data-plan="${checkout.planId}" data-period="${period}" data-tier="${checkout.tierKey || ""}">
            Choose ${escapeHtml(checkout.label)}
          </button>
        </article>`;
    }).join("");

    grid.querySelectorAll("[data-max-tier]").forEach((btn) => {
      btn.addEventListener("click", () => {
        maxTier = btn.getAttribute("data-max-tier") || "5x";
        paintCards(true);
        const tier = MAX_ROI_TIERS[maxTier];
        typeInto(live, `Max ${tier.label} · ${formatPHP(tier.price)} · ${tier.tagline}`, 18);
      });
    });

    grid.querySelectorAll("button[data-plan]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const user = getSessionUser();
        const tierQ = btn.dataset.tier ? `&tier=${encodeURIComponent(btn.dataset.tier)}` : "";
        const q = `plan=${btn.dataset.plan}&period=${btn.dataset.period}${tierQ}`;
        if (!user) {
          toast("Create an account to continue to checkout");
          navigate(`/signup?next=${encodeURIComponent(`/checkout?${q}`)}`);
          return;
        }
        navigate(`/checkout?${q}`);
      });
    });

    // Animate price numbers
    grid.querySelectorAll("[data-count-to]").forEach((node) => {
      if (node.getAttribute("data-animate") === "1") {
        animateCount(node, Number(node.getAttribute("data-count-to")));
      }
    });
    splitWordsIn(wrap.querySelector(".section-head"));
  }

  paintCards(false);
  typeInto(live, "Starter · Pro · Max tiers · prices in ₱", 16);
  return wrap;
}

function renderLogin() {
  const next = queryOf().get("next") || (isDesktopLinkFlow() ? "/desktop-linked" : "/dashboard");
  const deskCode = pendingDesktopCode();
  const alreadyIn = Boolean(getSessionToken() && getSessionUser());

  // Already signed in + desktop pairing → show link UI (not the password form).
  if (isDesktopLinkFlow() && alreadyIn) {
    const user = getSessionUser();
    const wrap = page(`
      <div class="auth-wrap container">
        <div class="auth-card">
          <h1>Link desktop app</h1>
          <p class="sub">You're signed in as <strong>${escapeHtml(user.email || "account")}</strong>${
            deskCode ? ` · code <strong class="mono">${escapeHtml(deskCode)}</strong>` : ""
          }.</p>
          <p class="muted small" id="desk-link-status" style="margin:0 0 16px">Connecting Hormachuelos desktop…</p>
          <div class="field-error" id="desk-link-error" hidden></div>
          <button class="btn btn-primary btn-block" type="button" id="desk-link-btn">Link desktop now</button>
          <p class="auth-foot" style="margin-top:16px">Wrong account? <a href="#" id="desk-link-logout">Log out</a> then sign in again.</p>
        </div>
      </div>
    `);
    const statusEl = wrap.querySelector("#desk-link-status");
    const errEl = wrap.querySelector("#desk-link-error");
    const btn = wrap.querySelector("#desk-link-btn");
    const runLink = async () => {
      errEl.hidden = true;
      btn.disabled = true;
      btn.textContent = "Linking…";
      statusEl.textContent = "Sending sign-in to the desktop app…";
      const ok = await finishDesktopLinkIfNeeded();
      if (!ok) {
        errEl.hidden = false;
        errEl.textContent =
          "Could not link yet. Keep the Hormachuelos app open, then click Link desktop now again.";
        btn.disabled = false;
        btn.textContent = "Link desktop now";
        statusEl.textContent = "Waiting for another try…";
      }
    };
    btn.addEventListener("click", () => void runLink());
    wrap.querySelector("#desk-link-logout").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await apiAuth("/api/auth/logout", { method: "POST" });
      } catch {
        /* ignore */
      }
      setSessionUser(null);
      navigate(withDesktopParams("/login"));
      render();
    });
    queueMicrotask(() => void runLink());
    return wrap;
  }

  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Log in</h1>
        <p class="sub">${
          isDesktopLinkFlow()
            ? `Sign in to unlock the desktop app${deskCode ? ` · code <strong class="mono">${escapeHtml(deskCode)}</strong>` : ""}.`
            : "Access your plan, credits, and orders."
        }</p>
        <form id="login-form" novalidate>
          <div class="field">
            <label for="login-email">Email</label>
            <input id="login-email" name="email" type="email" autocomplete="email" required placeholder="you@email.com" />
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="••••••••" minlength="6" />
          </div>
          <div class="field-error" id="login-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Log in</button>
        </form>
        <div class="divider">or</div>
        <p class="auth-foot">New here? <a href="#${withDesktopParams("/signup")}">Create an account</a></p>
      </div>
    </div>
  `);

  wrap.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = wrap.querySelector("#login-email").value.trim();
    const password = wrap.querySelector("#login-password").value;
    const err = wrap.querySelector("#login-error");
    const btn = wrap.querySelector('button[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      const data = await apiAuth("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setSessionUser(data.user, data.token);
      toast(`Welcome back, ${data.user.name || data.user.email}`);
      if (await finishDesktopLinkIfNeeded()) return;
      navigate(next.startsWith("/") ? next : `/${next}`);
    } catch (ex) {
      if (ex.code === "email_unverified") {
        toast("Verify your email first");
        navigate(
          withDesktopParams(
            `/verify?email=${encodeURIComponent(ex.email || email)}&next=${encodeURIComponent(next)}`,
          ),
        );
        return;
      }
      err.hidden = false;
      err.textContent = String(ex.message || "Invalid email or password.");
      btn.disabled = false;
      btn.textContent = "Log in";
    }
  });

  return wrap;
}

function renderSignup() {
  const next = queryOf().get("next") || (isDesktopLinkFlow() ? "/desktop-linked" : "/pricing");
  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Create account</h1>
        <p class="sub">${
          isDesktopLinkFlow()
            ? "Create an account to unlock the Hormachuelos desktop app."
            : "Free to join. Upgrade anytime with GCash."
        }</p>
        <form id="signup-form" novalidate>
          <div class="field">
            <label for="su-name">Name</label>
            <input id="su-name" name="name" type="text" autocomplete="name" required placeholder="Juan Dela Cruz" />
          </div>
          <div class="field">
            <label for="su-email">Email</label>
            <input id="su-email" name="email" type="email" autocomplete="email" required placeholder="you@email.com" />
          </div>
          <div class="field">
            <label for="su-password">Password</label>
            <input id="su-password" name="password" type="password" autocomplete="new-password" required minlength="6" placeholder="Min. 6 characters" />
            <div class="hint">We'll email a code from HORMACHUELOS to confirm you're real (stops spam signups).</div>
          </div>
          <div class="field-error" id="signup-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Sign up</button>
        </form>
        <p class="auth-foot" style="margin-top:18px">Already have an account? <a href="#${withDesktopParams("/login")}">Log in</a></p>
      </div>
    </div>
  `);

  wrap.querySelector("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = wrap.querySelector("#su-name").value.trim();
    const email = wrap.querySelector("#su-email").value.trim();
    const password = wrap.querySelector("#su-password").value;
    const err = wrap.querySelector("#signup-error");
    const btn = wrap.querySelector('button[type="submit"]');
    err.hidden = true;
    if (password.length < 6) {
      err.hidden = false;
      err.textContent = "Password must be at least 6 characters.";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Sending code…";
    try {
      const data = await apiAuth("/api/auth/signup", {
        method: "POST",
        body: { name, email, password },
      });
      toast(data.message || "Check your email for the code");
      navigate(
        withDesktopParams(
          `/verify?email=${encodeURIComponent(data.email || email)}&next=${encodeURIComponent(next)}`,
        ),
      );
    } catch (ex) {
      if (ex.code === "pending_verification") {
        toast("Account pending verification — enter the code we emailed");
        navigate(
          withDesktopParams(
            `/verify?email=${encodeURIComponent(ex.email || email)}&next=${encodeURIComponent(next)}`,
          ),
        );
        return;
      }
      err.hidden = false;
      err.textContent = String(ex.message || "Could not create account.");
      btn.disabled = false;
      btn.textContent = "Sign up";
    }
  });

  return wrap;
}

function renderDesktopLinked() {
  const wrap = page(`
    <div class="container" style="padding:64px 0;max-width:560px;margin:0 auto;text-align:center">
      <div class="eyebrow" style="margin-bottom:16px"><span class="dot"></span> Desktop linked</div>
      <h1 style="margin:0 0 12px;font-size:2rem;letter-spacing:-0.03em">You're signed in</h1>
      <p class="muted" style="margin:0 0 20px">
        Return to the Hormachuelos app — it should sign in within a few seconds.
        If the app still says waiting, click below to send the link again.
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
        <button type="button" class="btn btn-primary" id="desk-relink-btn">Send link to app again</button>
        <a class="btn" href="#/dashboard">Open web dashboard</a>
      </div>
      <p class="muted small" id="desk-relink-status" style="margin-top:14px"></p>
    </div>
  `);
  wrap.querySelector("#desk-relink-btn")?.addEventListener("click", async () => {
    const status = wrap.querySelector("#desk-relink-status");
    const btn = wrap.querySelector("#desk-relink-btn");
    if (!getSessionToken()) {
      navigate(withDesktopParams("/login"));
      return;
    }
    // Restore last code if user still has the app waiting on the same pairing.
    if (!pendingDesktopCode()) {
      status.textContent = "Open the link from the desktop app again (it includes a fresh code).";
      return;
    }
    btn.disabled = true;
    status.textContent = "Re-sending…";
    // Re-enable flow flag and complete again (mints a fresh desktop token).
    try {
      sessionStorage.setItem(STORAGE_DESKTOP_FLOW, "1");
    } catch {
      /* ignore */
    }
    const ok = await finishDesktopLinkIfNeeded();
    status.textContent = ok
      ? "Sent. Check the Hormachuelos app window."
      : "Still waiting — keep the app open and try once more.";
    btn.disabled = false;
  });
  return wrap;
}

function renderVerify() {
  const q = queryOf();
  const email = q.get("email") || "";
  // Email OTP uses `code`; desktop pairing also uses `code` (ABCD-EFGH). Prefer OTP when 6 digits.
  const rawCode = q.get("code") || "";
  const presetCode = /^\d{6}$/.test(rawCode) ? rawCode : "";
  const next = q.get("next") || (isDesktopLinkFlow() ? "/desktop-linked" : "/dashboard");
  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Verify email</h1>
        <p class="sub">Enter the 6-digit code sent by <strong>HORMACHUELOS</strong>${
          isDesktopLinkFlow() ? " to finish unlocking the desktop app." : "."
        }</p>
        <form id="verify-form" novalidate>
          <div class="field">
            <label for="vf-email">Email</label>
            <input id="vf-email" name="email" type="email" required value="${escapeHtml(email)}" placeholder="you@email.com" />
          </div>
          <div class="field">
            <label for="vf-code">Verification code</label>
            <input id="vf-code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6" minlength="6" placeholder="123456" value="${escapeHtml(presetCode)}" />
          </div>
          <div class="field-error" id="verify-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Verify &amp; continue</button>
        </form>
        <p class="auth-foot" style="margin-top:18px">
          Didn't get it?
          <button type="button" class="linkish" id="resend-code" style="background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer">Resend code</button>
        </p>
      </div>
    </div>
  `);

  const err = wrap.querySelector("#verify-error");
  wrap.querySelector("#verify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = wrap.querySelector('button[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Verifying…";
    try {
      const data = await apiAuth("/api/auth/verify", {
        method: "POST",
        body: {
          email: wrap.querySelector("#vf-email").value.trim(),
          code: wrap.querySelector("#vf-code").value.trim(),
        },
      });
      setSessionUser(data.user, data.token);
      toast(data.message || "Email verified");
      if (await finishDesktopLinkIfNeeded()) return;
      navigate(next.startsWith("/") ? next : `/${next}`);
    } catch (ex) {
      err.hidden = false;
      err.textContent = String(ex.message || "Verification failed");
      btn.disabled = false;
      btn.textContent = "Verify & continue";
    }
  });

  wrap.querySelector("#resend-code").addEventListener("click", async () => {
    const em = wrap.querySelector("#vf-email").value.trim();
    if (!em) {
      err.hidden = false;
      err.textContent = "Enter your email first.";
      return;
    }
    try {
      const data = await apiAuth("/api/auth/resend-verification", {
        method: "POST",
        body: { email: em },
      });
      toast(data.message || "Code resent");
    } catch (ex) {
      err.hidden = false;
      err.textContent = String(ex.message || "Could not resend");
    }
  });

  if (email && presetCode) {
    queueMicrotask(() => wrap.querySelector("#verify-form")?.requestSubmit?.());
  }

  return wrap;
}

function renderDashboard() {
  const user = getSessionUser();
  if (!user || !getSessionToken()) {
    navigate("/login?next=/dashboard");
    return page(`<div class="container" style="padding:48px 0"><p class="muted">Redirecting to login…</p></div>`);
  }

  const wrap = page(`
    <div class="dash container">
      <div class="dash-head">
        <div>
          <h1>Dashboard</h1>
          <p class="muted small" id="dash-email">Loading account…</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-sm" href="#/pricing">Change plan</a>
          <a class="btn btn-sm btn-primary" href="#/download">Download app</a>
        </div>
      </div>
      <div id="dash-body"><p class="muted">Loading…</p></div>
    </div>
  `);

  (async () => {
    try {
      const data = await apiAuth("/api/auth/me");
      const full = data.user;
      setSessionUser(full, getSessionToken());
      if (Array.isArray(data.orders)) saveJSON(STORAGE_ORDERS, data.orders);
      if (Array.isArray(data.paymentRequests)) setPaymentRequests(data.paymentRequests);
      const orders = data.orders || getOrders().filter((o) => o.email === full.email);
      const paymentRequests = data.paymentRequests || getPaymentRequests();
      const planLabel = full.plan ? checkoutPlanLabel(full.plan) : null;
      const bill = BILLING[full.period] || BILLING.payg;
      const emailEl = wrap.querySelector("#dash-email");
      const body = wrap.querySelector("#dash-body");
      if (emailEl) emailEl.textContent = `Signed in as ${full.email}`;
      if (body) {
        body.innerHTML = `
          <div class="stat-row">
            <div class="stat">
              <div class="label">Plan</div>
              <div class="value">${planLabel ? escapeHtml(planLabel) : "Free"}</div>
            </div>
            <div class="stat">
              <div class="label">Model</div>
              <div class="value">${bill ? escapeHtml(bill.label) : "—"}</div>
            </div>
            <div class="stat">
              <div class="label">Credits</div>
              <div class="value">${(full.credits || 0).toLocaleString("en-PH")}</div>
            </div>
          </div>
          <div class="dash-grid">
            <div class="card">
              <h3>Account</h3>
              <p style="margin:12px 0" class="muted small">Name</p>
              <p style="margin:0 0 12px">${escapeHtml(full.name || "—")}</p>
              <p style="margin:0 0 4px" class="muted small">Member since</p>
              <p style="margin:0" class="mono small">${full.createdAt ? new Date(full.createdAt).toLocaleDateString() : "—"}</p>
              ${
                full.licenseKey
                  ? `<p style="margin:16px 0 4px" class="muted small">Desktop license</p>
                     <code class="mono small" style="display:block;word-break:break-all">${escapeHtml(full.licenseKey)}</code>`
                  : ""
              }
              ${
                !full.plan
                  ? `<div class="alert warn" style="margin-top:18px">No active plan yet. Pick a plan and unlock the agent.</div>
                     <a class="btn btn-primary" href="#/pricing">View pricing</a>`
                  : `<div class="alert ok" style="margin-top:18px">Active · ${escapeHtml(planLabel || "")} (${escapeHtml(bill?.label || "")}).</div>`
              }
            </div>
            <div class="card">
              <h3>Recent orders</h3>
              ${
                orders.length === 0
                  ? `<p class="muted small" style="margin-top:12px">No orders yet.</p>`
                  : `<ul class="feature-list" style="margin-top:12px">${orders
                      .slice(0, 5)
                      .map(
                        (o) =>
                          `<li><span class="mono">${escapeHtml(String(o.id || "").slice(0, 8))}</span> · ${escapeHtml(o.planName || o.planId || "")} · ${formatPHP(o.amount)} · ${escapeHtml(o.method || "")}</li>`,
                      )
                      .join("")}</ul>`
              }
            </div>
            <div class="card">
              <h3>Payment requests</h3>
              ${
                paymentRequests.length === 0
                  ? `<p class="muted small" style="margin-top:12px">No GCash payment requests yet.</p>`
                  : `<ul class="feature-list payment-request-list" style="margin-top:12px">${paymentRequests
                      .slice(0, 5)
                      .map(
                        (request) =>
                          `<li><span class="payment-status ${paymentStatusTone(request.status)}">${escapeHtml(paymentStatusText(request.status))}</span><span>${escapeHtml(request.planName || request.planId || "Plan")} · ${formatPHP(request.amountPhp)}</span><span class="mono muted small">${escapeHtml(String(request.id || "").slice(0, 8))}</span></li>`,
                      )
                      .join("")}</ul>`
              }
              <p class="muted small" style="margin:14px 0 0">Only approved payment requests activate a plan. Under-review requests stay visible here until a decision is made.</p>
            </div>
          </div>`;
      }
    } catch (ex) {
      setSessionUser(null);
      toast(String(ex.message || "Session expired"));
      navigate("/login?next=/dashboard");
    }
  })();

  return wrap;
}

function getAdminToken() {
  return localStorage.getItem(STORAGE_ADMIN) || "";
}

function setAdminToken(token) {
  if (token) localStorage.setItem(STORAGE_ADMIN, token);
  else localStorage.removeItem(STORAGE_ADMIN);
}

async function apiAdmin(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Admin request failed (${res.status})`);
  return data;
}

function renderAdmin() {
  const wrap = page(`
    <div class="dash container admin-dash">
      <div class="dash-head">
        <div>
          <h1>Admin</h1>
          <p class="muted small">Manage users, plans, secure provider credentials, aliases, and software releases.</p>
        </div>
        <div id="admin-actions" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>
      <div id="admin-root"><p class="muted">Loading…</p></div>
    </div>
  `);

  const root = wrap.querySelector("#admin-root");
  const actions = wrap.querySelector("#admin-actions");

  function paintLogin() {
    actions.innerHTML = "";
    root.innerHTML = `
      <div class="auth-card" style="max-width:420px;margin:0 auto">
        <h1 style="font-size:1.35rem">Admin login</h1>
        <p class="sub">Staff only. Not for customer accounts.</p>
        <form id="admin-login-form" novalidate>
          <div class="field">
            <label for="admin-user">Username</label>
            <input id="admin-user" name="username" autocomplete="username" required placeholder="admin" />
          </div>
          <div class="field">
            <label for="admin-pass">Password</label>
            <input id="admin-pass" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div class="field-error" id="admin-login-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Enter admin</button>
        </form>
      </div>`;
    root.querySelector("#admin-login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = root.querySelector("#admin-login-error");
      const btn = root.querySelector('button[type="submit"]');
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = "Checking…";
      try {
        const data = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            username: root.querySelector("#admin-user").value.trim(),
            password: root.querySelector("#admin-pass").value,
          }),
        }).then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Login failed");
          return j;
        });
        setAdminToken(data.token);
        toast("Admin signed in");
        await paintAdmin("users");
      } catch (ex) {
        err.hidden = false;
        err.textContent = String(ex.message || ex);
        btn.disabled = false;
        btn.textContent = "Enter admin";
      }
    });
  }

  function wireAdminChrome(tab) {
    actions.innerHTML = `
      <button type="button" class="btn btn-sm ${tab === "users" ? "btn-primary" : ""}" id="admin-tab-users">Users</button>
      <button type="button" class="btn btn-sm ${tab === "payments" ? "btn-primary" : ""}" id="admin-tab-payments">Payments</button>
      <button type="button" class="btn btn-sm ${tab === "models" ? "btn-primary" : ""}" id="admin-tab-models">Models</button>
      <button type="button" class="btn btn-sm ${tab === "releases" ? "btn-primary" : ""}" id="admin-tab-releases">Releases</button>
      <button type="button" class="btn btn-sm" id="admin-refresh">Refresh</button>
      <button type="button" class="btn btn-sm btn-ghost" id="admin-logout">Log out</button>`;
    actions.querySelector("#admin-logout").onclick = () => {
      setAdminToken("");
      toast("Admin logged out");
      paintLogin();
    };
    actions.querySelector("#admin-refresh").onclick = () => paintAdmin(tab);
    actions.querySelector("#admin-tab-users").onclick = () => paintAdmin("users");
    actions.querySelector("#admin-tab-payments").onclick = () => paintAdmin("payments");
    actions.querySelector("#admin-tab-models").onclick = () => paintAdmin("models");
    actions.querySelector("#admin-tab-releases").onclick = () => paintAdmin("releases");
  }

  async function paintAdmin(tab = "users") {
    if (!getAdminToken()) {
      paintLogin();
      return;
    }
    wireAdminChrome(tab);
    if (tab === "payments") {
      await paintPayments();
      return;
    }
    if (tab === "models") {
      await paintModels();
      return;
    }
    if (tab === "releases") {
      await paintReleases();
      return;
    }
    await paintUsers();
  }

  async function paintUsers() {
    root.innerHTML = `<p class="muted">Loading users…</p>`;
    try {
      const [data, providerData] = await Promise.all([
        apiAdmin("/api/admin/users"),
        apiAdmin("/api/admin/providers"),
      ]);
      const users = data.users || [];
      const providers = (Array.isArray(providerData.providers) ? providerData.providers : [])
        .filter((provider) => provider.active !== false && provider.providerId !== "commandcode");
      const configs = (Array.isArray(providerData.configs) ? providerData.configs : [])
        .filter((model) => model.active !== false && model.providerId !== "commandcode");
      const modelsByProvider = new Map();
      for (const model of configs) {
        const providerId = String(model.providerId || "").trim().toLowerCase();
        if (!providerId) continue;
        const items = modelsByProvider.get(providerId) || [];
        items.push(model);
        modelsByProvider.set(providerId, items);
      }

      if (!users.length) {
        root.innerHTML = `<div class="card"><p class="muted" style="margin:0">No registered users yet.</p></div>`;
        return;
      }

      const accessSummary = (user) => {
        if (!user.restricted) return "Plan default";
        const count = Array.isArray(user.allowedProviders) ? user.allowedProviders.length : 0;
        return count ? `${count} provider${count === 1 ? "" : "s"}` : "None allowed";
      };

      root.innerHTML = `
        <div class="admin-table-wrap">
          <table class="admin-table admin-users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Plan</th>
                <th>Credits</th>
                <th>Token budget</th>
                <th>Tokens used</th>
                <th>Expires</th>
                <th>License</th>
                <th>AI access</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${users
                .map((u) => {
                  const plan = u.plan || "free";
                  const planOptions = ["free", "starter", "pro", "proplus", "max5", "max10", "max20"];
                  if (plan && !planOptions.includes(plan)) planOptions.unshift(plan);
                  const allowedProviders = Array.isArray(u.allowedProviders) ? u.allowedProviders : [];
                  const allowedModels = u.allowedModels && typeof u.allowedModels === "object" ? u.allowedModels : {};
                  return `<tr class="admin-user-row" data-id="${escapeHtml(u.id)}" data-restricted="${u.restricted ? "1" : "0"}" data-allowed-providers="${escapeHtml(JSON.stringify(allowedProviders))}" data-allowed-models="${escapeHtml(JSON.stringify(allowedModels))}">
                    <td>
                      <div class="admin-user">
                        <strong>${escapeHtml(u.name || "—")}</strong>
                        <span class="muted small mono">${escapeHtml(u.email)}</span>
                        ${u.licenseKey ? `<span class="muted small mono">${escapeHtml(u.licenseKey)}</span>` : `<span class="muted small">No license key</span>`}
                      </div>
                    </td>
                    <td>
                      <select class="field admin-plan">
                        ${planOptions
                          .map(
                            (p) =>
                              `<option value="${p}" ${plan === p ? "selected" : ""}>${p}</option>`,
                          )
                          .join("")}
                      </select>
                    </td>
                    <td><input class="field admin-credits" type="number" min="0" step="1000" value="${Number(u.credits) || 0}" /></td>
                    <td><input class="field admin-budget" type="number" min="0" step="100000" value="${Number(u.tokenBudget) || 0}" /></td>
                    <td><input class="field admin-used" type="number" min="0" step="1000" value="${Number(u.tokensUsed) || 0}" /></td>
                    <td><input class="field admin-expires" type="date" value="${escapeHtml(u.expiresAt || "")}" /></td>
                    <td>
                      <label class="admin-active">
                        <input type="checkbox" class="admin-lic-active" ${u.licenseActive ? "checked" : ""} />
                        Active
                      </label>
                    </td>
                    <td>
                      <button type="button" class="btn btn-sm admin-access-toggle">${escapeHtml(accessSummary(u))}</button>
                    </td>
                    <td><button type="button" class="btn btn-sm btn-primary admin-save">Save</button></td>
                  </tr>
                  <tr class="admin-access-panel" data-id="${escapeHtml(u.id)}" hidden>
                    <td colspan="9">
                      <div class="admin-access-editor">
                        <label class="admin-active">
                          <input type="checkbox" class="admin-restrict" ${u.restricted ? "checked" : ""} />
                          Restrict which AI providers and models this user can use
                        </label>
                        <p class="muted small admin-access-hint">Paused providers and paused/prohibited model aliases are hidden here. Uncheck restriction to restore the normal plan-based catalog.</p>
                        <div class="admin-access-body" ${u.restricted ? "" : "hidden"}>
                          <div class="admin-access-col">
                            <strong>Providers</strong>
                            <div class="admin-access-checks admin-access-providers">
                              ${providers
                                .map((provider) => {
                                  const id = escapeHtml(provider.providerId);
                                  const checked = allowedProviders.includes(provider.providerId) ? "checked" : "";
                                  return `<label class="admin-access-check"><input type="checkbox" class="admin-provider-check" value="${id}" ${checked} /> ${escapeHtml(provider.displayName || provider.providerId)}</label>`;
                                })
                                .join("") || `<span class="muted small">No active providers configured.</span>`}
                            </div>
                          </div>
                          <div class="admin-access-col">
                            <strong>Models <span class="muted">(from selected providers only)</span></strong>
                            <div class="admin-access-checks admin-access-models"></div>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        <p class="muted small" style="margin-top:12px">${users.length} user${users.length === 1 ? "" : "s"} · edits apply to website account + hosted license usage · AI access controls the hosted catalog and chat proxy.</p>`;

      const renderModelsForRow = (userRow, panel) => {
        const modelsHost = panel.querySelector(".admin-access-models");
        if (!modelsHost) return;
        const restrictOn = panel.querySelector(".admin-restrict")?.checked;
        const selectedProviders = [...panel.querySelectorAll(".admin-provider-check:checked")].map(
          (input) => input.value,
        );
        let allowedModels = {};
        try {
          allowedModels = JSON.parse(userRow.getAttribute("data-allowed-models") || "{}") || {};
        } catch {
          allowedModels = {};
        }
        if (!restrictOn) {
          modelsHost.innerHTML = `<span class="muted small">Restriction off — plan default catalog applies.</span>`;
          return;
        }
        if (!selectedProviders.length) {
          modelsHost.innerHTML = `<span class="muted small">Select at least one provider to choose models.</span>`;
          return;
        }
        const parts = [];
        for (const providerId of selectedProviders) {
          const provider = providers.find((item) => item.providerId === providerId);
          const models = modelsByProvider.get(providerId) || [];
          const selected = Array.isArray(allowedModels[providerId]) ? allowedModels[providerId] : [];
          const allSelected = !selected.length || selected.includes("*");
          parts.push(`<div class="admin-access-model-group" data-provider="${escapeHtml(providerId)}">
            <div class="admin-access-model-group-head">
              <span>${escapeHtml(provider?.displayName || providerId)}</span>
              <label class="admin-access-check"><input type="checkbox" class="admin-model-all" data-provider="${escapeHtml(providerId)}" ${allSelected ? "checked" : ""} /> All active models</label>
            </div>
            <div class="admin-access-model-list" ${allSelected ? "hidden" : ""}>
              ${
                models.length
                  ? models
                      .map((model) => {
                        const checked = !allSelected && selected.includes(model.alias) ? "checked" : "";
                        return `<label class="admin-access-check"><input type="checkbox" class="admin-model-check" data-provider="${escapeHtml(providerId)}" value="${escapeHtml(model.alias)}" ${checked} /> ${escapeHtml(model.displayName || model.alias)} <span class="mono muted small">${escapeHtml(model.alias)}</span></label>`;
                      })
                      .join("")
                  : `<span class="muted small">No active models for this provider.</span>`
              }
            </div>
          </div>`);
        }
        modelsHost.innerHTML = parts.join("");
      };

      const syncAccessAttr = (userRow, panel) => {
        const restricted = Boolean(panel.querySelector(".admin-restrict")?.checked);
        userRow.setAttribute("data-restricted", restricted ? "1" : "0");
        if (!restricted) {
          userRow.setAttribute("data-allowed-providers", "[]");
          userRow.setAttribute("data-allowed-models", "{}");
          return;
        }
        const providersSelected = [...panel.querySelectorAll(".admin-provider-check:checked")].map(
          (input) => input.value,
        );
        const models = {};
        for (const providerId of providersSelected) {
          const all = panel.querySelector(`.admin-model-all[data-provider="${CSS.escape(providerId)}"]`);
          if (!all || all.checked) {
            models[providerId] = ["*"];
            continue;
          }
          const aliases = [...panel.querySelectorAll(`.admin-model-check[data-provider="${CSS.escape(providerId)}"]:checked`)].map(
            (input) => input.value,
          );
          models[providerId] = aliases;
        }
        userRow.setAttribute("data-allowed-providers", JSON.stringify(providersSelected));
        userRow.setAttribute("data-allowed-models", JSON.stringify(models));
      };

      root.querySelectorAll("tr.admin-user-row[data-id]").forEach((tr) => {
        const id = tr.getAttribute("data-id");
        const panel = root.querySelector(`tr.admin-access-panel[data-id="${CSS.escape(id)}"]`);
        if (!panel) return;

        const refreshAccessButton = () => {
          const btn = tr.querySelector(".admin-access-toggle");
          if (!btn) return;
          const restricted = tr.getAttribute("data-restricted") === "1";
          if (!restricted) {
            btn.textContent = "Plan default";
            return;
          }
          let providersSelected = [];
          try {
            providersSelected = JSON.parse(tr.getAttribute("data-allowed-providers") || "[]") || [];
          } catch {
            providersSelected = [];
          }
          const count = providersSelected.length;
          btn.textContent = count ? `${count} provider${count === 1 ? "" : "s"}` : "None allowed";
        };

        tr.querySelector(".admin-access-toggle")?.addEventListener("click", () => {
          panel.hidden = !panel.hidden;
          if (!panel.hidden) renderModelsForRow(tr, panel);
        });

        panel.querySelector(".admin-restrict")?.addEventListener("change", (event) => {
          const body = panel.querySelector(".admin-access-body");
          if (body) body.hidden = !event.target.checked;
          syncAccessAttr(tr, panel);
          renderModelsForRow(tr, panel);
          refreshAccessButton();
        });

        panel.querySelector(".admin-access-providers")?.addEventListener("change", (event) => {
          if (!event.target.classList.contains("admin-provider-check")) return;
          syncAccessAttr(tr, panel);
          renderModelsForRow(tr, panel);
          refreshAccessButton();
        });

        panel.querySelector(".admin-access-models")?.addEventListener("change", (event) => {
          const target = event.target;
          if (target.classList.contains("admin-model-all")) {
            const group = target.closest(".admin-access-model-group");
            const list = group?.querySelector(".admin-access-model-list");
            if (list) list.hidden = target.checked;
            if (target.checked) {
              group?.querySelectorAll(".admin-model-check").forEach((input) => {
                input.checked = false;
              });
            }
          }
          syncAccessAttr(tr, panel);
          refreshAccessButton();
        });

        renderModelsForRow(tr, panel);
        syncAccessAttr(tr, panel);

        tr.querySelector(".admin-save")?.addEventListener("click", async () => {
          const btn = tr.querySelector(".admin-save");
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            syncAccessAttr(tr, panel);
            const plan = tr.querySelector(".admin-plan").value;
            const restricted = tr.getAttribute("data-restricted") === "1";
            let allowedProviders = null;
            let allowedModels = null;
            if (restricted) {
              allowedProviders = JSON.parse(tr.getAttribute("data-allowed-providers") || "[]");
              allowedModels = JSON.parse(tr.getAttribute("data-allowed-models") || "{}");
            }
            await apiAdmin("/api/admin/users", {
              method: "PATCH",
              body: {
                id,
                plan,
                credits: Number(tr.querySelector(".admin-credits").value) || 0,
                tokenBudget: Number(tr.querySelector(".admin-budget").value) || 0,
                tokensUsed: Number(tr.querySelector(".admin-used").value) || 0,
                expiresAt: tr.querySelector(".admin-expires").value || undefined,
                licenseActive: tr.querySelector(".admin-lic-active").checked,
                allowedProviders,
                allowedModels,
              },
            });
            toast("User updated");
            btn.textContent = "Saved";
            refreshAccessButton();
            setTimeout(() => {
              btn.disabled = false;
              btn.textContent = "Save";
            }, 900);
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
            btn.textContent = "Save";
          }
        });
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  async function paintPayments() {
    root.innerHTML = `<p class="muted">Loading payment requests…</p>`;
    try {
      const data = await apiAdmin("/api/admin/payments");
      const payments = Array.isArray(data.payments) ? data.payments : [];
      root.innerHTML = `
        <section class="card admin-payment-intro">
          <div>
            <p class="admin-eyebrow">GCash proof review</p>
            <h2>Approve only after you review the evidence</h2>
            <p class="muted">Automatic approval runs only when the exact amount, new receipt fingerprint, new GCash reference, and clean high-confidence visual scan all pass. Every other request stays here and can also be decided from your private Telegram chat.</p>
          </div>
          <div class="admin-security-note"><span aria-hidden="true">◆</span><p><strong>Receipt files are private.</strong> “View proof” opens a short-lived signed link only for this authenticated admin session.</p></div>
        </section>
        <div class="admin-table-wrap" style="margin-top:16px">
          <table class="admin-table admin-payment-table">
            <thead>
              <tr>
                <th>Buyer / order</th>
                <th>Plan / amount</th>
                <th>Receipt scan</th>
                <th>Proof</th>
                <th>Status</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              ${
                payments.length
                  ? payments
                      .map((payment) => {
                        const final = ["approved", "rejected"].includes(String(payment.status || "").toLowerCase());
                        const flags = Array.isArray(payment.scanFlags) && payment.scanFlags.length
                          ? payment.scanFlags.map((flag) => escapeHtml(flag.replace(/_/g, " "))).join(", ")
                          : "No review flags";
                        return `<tr data-payment-id="${escapeHtml(payment.id)}">
                          <td>
                            <div class="admin-user"><strong>${escapeHtml(payment.customer?.name || "—")}</strong><span class="muted small mono">${escapeHtml(payment.customer?.email || "—")}</span><span class="mono small">${escapeHtml(String(payment.id || "").slice(0, 8))}</span></div>
                          </td>
                          <td><strong>${escapeHtml(payment.planName || payment.planId || "—")}</strong><span class="muted small">${formatPHP(payment.amountPhp)}</span></td>
                          <td>
                            <strong>${payment.scanConfidence == null ? "Not complete" : `${Math.round(Number(payment.scanConfidence) * 100)}% confidence`}</strong>
                            <span class="muted small">${escapeHtml(payment.referenceMasked || "No readable reference")}</span>
                            <span class="muted small">${escapeHtml(payment.scanSummary || "No scan summary yet.")}</span>
                            <span class="payment-flags">${flags}</span>
                          </td>
                          <td>${payment.proofUrl ? `<a class="btn btn-sm" href="${escapeHtml(payment.proofUrl)}" target="_blank" rel="noopener noreferrer">View proof</a>` : `<span class="muted small">Not uploaded</span>`}</td>
                          <td><span class="payment-status ${paymentStatusTone(payment.status)}">${escapeHtml(paymentStatusText(payment.status))}</span><span class="muted small">${escapeHtml(String(payment.createdAt || "").slice(0, 10))}</span></td>
                          <td class="admin-payment-actions">
                            <button type="button" class="btn btn-sm btn-primary admin-payment-approve" ${final ? "disabled" : ""}>Approve</button>
                            <button type="button" class="btn btn-sm danger admin-payment-reject" ${final ? "disabled" : ""}>Reject</button>
                          </td>
                        </tr>`;
                      })
                      .join("")
                  : `<tr><td colspan="6" class="muted">No payment requests yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>`;

      root.querySelectorAll("tr[data-payment-id]").forEach((row) => {
        const decide = async (action) => {
          const id = row.getAttribute("data-payment-id");
          const message = action === "approve"
            ? "Approve this payment and activate its plan?"
            : "Reject this payment request?";
          if (!confirm(message)) return;
          const buttons = row.querySelectorAll("button");
          buttons.forEach((button) => {
            button.disabled = true;
          });
          try {
            await apiAdmin("/api/admin/payments", { method: "PATCH", body: { orderId: id, action } });
            toast(action === "approve" ? "Payment approved and plan activated" : "Payment request rejected");
            await paintAdmin("payments");
          } catch (ex) {
            toast(String(ex.message || ex));
            buttons.forEach((button) => {
              button.disabled = false;
            });
          }
        };
        row.querySelector(".admin-payment-approve")?.addEventListener("click", () => decide("approve"));
        row.querySelector(".admin-payment-reject")?.addEventListener("click", () => decide("reject"));
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  async function paintModels() {
    root.innerHTML = `<p class="muted">Loading provider registry…</p>`;
    try {
      const data = await apiAdmin("/api/admin/providers");
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const configs = Array.isArray(data.configs) ? data.configs : [];
      const modelsByProvider = new Map();
      for (const config of configs) {
        const providerId = String(config.providerId || "").trim().toLowerCase();
        const items = modelsByProvider.get(providerId) || [];
        items.push(config);
        modelsByProvider.set(providerId, items);
      }

      const storageWarning = data.credentialStorageReady
        ? ""
        : `<div class="alert warn">Credential encryption is not configured on the server. Set <code>HORMACHUELOS_MODEL_CONFIG_KEY</code> before saving a provider or model API key.</div>`;

      const modelRow = (model, provider) => {
        const inheritedEndpoint = !String(model.baseUrl || "").trim();
        const isVirtual = Boolean(model.virtual || model.systemManaged);
        const keyStatus = isVirtual
          ? (model.note || "Uses the HORMACHUELOS NEW MODELS key")
          : model.keyConfigured
            ? "Route-specific key saved"
            : provider.keyConfigured
              ? "Uses the provider default key"
              : "No key configured";
        return `<div class="admin-model-row${isVirtual ? " is-virtual" : ""}" data-model-id="${escapeHtml(model.id)}" data-provider-id="${escapeHtml(provider.providerId)}" data-virtual="${isVirtual ? "1" : "0"}">
          <div class="admin-model-row-head">
            <strong>${escapeHtml(model.displayName || model.alias)}</strong>
            <span class="admin-state ${model.active ? "is-active" : "is-paused"}">${model.active ? "Active" : "Paused"}</span>
            ${isVirtual ? `<span class="admin-state is-virtual">Vision route</span>` : ""}
          </div>
          <div class="admin-model-grid">
            <div class="field"><label>Model alias shown in app</label><input class="field admin-model-alias mono" value="${escapeHtml(model.alias)}" maxlength="81" pattern="[a-z0-9][a-z0-9._-]*" required ${isVirtual ? "readonly" : ""} /></div>
            <div class="field"><label>Model display name</label><input class="field admin-model-name" value="${escapeHtml(model.displayName)}" maxlength="120" required ${isVirtual ? "readonly" : ""} /></div>
            <div class="field"><label>Upstream model ID</label><input class="field admin-model-upstream mono" value="${escapeHtml(model.upstreamModel)}" maxlength="200" required ${isVirtual ? "readonly" : ""} /></div>
            <div class="field"><label>Endpoint override <span class="muted">(optional)</span></label><input class="field admin-model-base mono" type="url" value="${escapeHtml(model.baseUrl || "")}" maxlength="400" placeholder="${inheritedEndpoint ? "Uses provider endpoint" : "https://provider.example/v1"}" ${isVirtual ? "readonly" : ""} /><p class="muted small">${isVirtual ? escapeHtml(model.note || "Managed Vision route") : inheritedEndpoint ? "Inherited from provider" : "This model overrides the provider endpoint"}</p></div>
            <div class="field admin-key-field"><label>Route API key override <span class="muted">(optional)</span></label><input class="field admin-model-key" type="password" autocomplete="new-password" ${isVirtual ? "disabled" : ""} placeholder="${isVirtual ? "Uses HORMACHUELOS NEW MODELS key" : model.keyConfigured ? "•••••••• (leave blank to keep)" : "Use provider key"}" /><p class="muted small">${escapeHtml(keyStatus)}</p></div>
            <label class="admin-active admin-toggle-field"><input type="checkbox" class="admin-model-active" ${model.active ? "checked" : ""} ${isVirtual ? "disabled" : ""} /> Model active</label>
          </div>
          <div class="admin-row-actions">
            ${isVirtual
              ? `<p class="muted small" style="margin:0">Managed automatically. Enable Vision by configuring the HORMACHUELOS NEW MODELS provider key.</p>`
              : `<button type="button" class="btn btn-sm btn-primary admin-model-save">Save alias</button>
            <button type="button" class="btn btn-sm admin-model-clear" ${model.keyConfigured ? "" : "disabled"}>Clear route key</button>
            <button type="button" class="btn btn-sm danger admin-model-delete">Delete alias</button>`}
          </div>
        </div>`;
      };

      const addModelForm = (provider) => `<details class="admin-add-model">
        <summary>Add a model alias to this provider</summary>
        <form class="admin-model-add-form" data-provider-id="${escapeHtml(provider.providerId)}">
          <div class="admin-model-grid">
            <div class="field"><label>Model alias shown in app</label><input class="field new-model-alias mono" required maxlength="81" placeholder="my-model-fast" pattern="[a-z0-9][a-z0-9._-]*" /></div>
            <div class="field"><label>Model display name</label><input class="field new-model-name" required maxlength="120" placeholder="My Model Fast" /></div>
            <div class="field"><label>Upstream model ID</label><input class="field new-model-upstream mono" required maxlength="200" placeholder="grok-4.5" /></div>
            <div class="field"><label>Endpoint override <span class="muted">(optional)</span></label><input class="field new-model-base mono" type="url" maxlength="400" placeholder="Uses provider endpoint" /></div>
            <div class="field admin-key-field"><label>Route API key override <span class="muted">(optional)</span></label><input class="field new-model-key" type="password" autocomplete="new-password" placeholder="Uses provider key" /></div>
            <label class="admin-active admin-toggle-field"><input type="checkbox" class="new-model-active" checked /> Model active</label>
          </div>
          <div class="admin-row-actions"><button type="submit" class="btn btn-sm btn-primary">Add model alias</button></div>
        </form>
      </details>`;

      const providerCards = providers.map((provider) => {
        const models = (modelsByProvider.get(provider.providerId) || [])
          .slice()
          .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
        const keyStatus = provider.keyConfigured ? "Default key configured" : "No default key";
        const modelSummary = `${models.length} model alias${models.length === 1 ? "" : "es"}`;
        return `<article class="admin-provider-card" data-provider-id="${escapeHtml(provider.providerId)}" data-profile-id="${escapeHtml(provider.id || "")}" data-profile-configured="${provider.profileConfigured ? "true" : "false"}" data-model-count="${String(models.length)}">
          <header class="admin-provider-head">
            <div>
              <p class="admin-eyebrow">Provider configuration</p>
              <h3>${escapeHtml(provider.displayName)}</h3>
              <p class="muted small mono">${escapeHtml(provider.providerId)}</p>
            </div>
            <div class="admin-provider-status"><span class="admin-state ${provider.active ? "is-active" : "is-paused"}">${provider.active ? "Active" : "Paused"}</span><span class="muted small">${escapeHtml(modelSummary)}</span></div>
          </header>
          <div class="admin-provider-grid">
            <div class="field"><label>Provider ID</label><input class="field mono admin-provider-id" value="${escapeHtml(provider.providerId)}" readonly aria-readonly="true" /><p class="muted small">Stable technical ID</p></div>
            <div class="field"><label>Provider alias shown in app</label><input class="field admin-provider-name" value="${escapeHtml(provider.displayName)}" maxlength="120" required /></div>
            <div class="field admin-provider-endpoint"><label>Default HTTPS endpoint</label><input class="field mono admin-provider-base" type="url" value="${escapeHtml(provider.baseUrl)}" maxlength="400" required /><p class="muted small">OpenAI-compatible chat-completions endpoint</p></div>
            <div class="field admin-key-field"><label>Default server API key</label><input class="field admin-provider-key" type="password" autocomplete="new-password" placeholder="${provider.keyConfigured ? "•••••••• (leave blank to keep)" : "Paste a provider key"}" /><p class="muted small">${keyStatus}. It applies to aliases without a route-specific override.</p></div>
            <label class="admin-active admin-toggle-field"><input type="checkbox" class="admin-provider-active" ${provider.active ? "checked" : ""} /> Provider active</label>
          </div>
          <div class="admin-provider-actions">
            <button type="button" class="btn btn-sm btn-primary admin-provider-save">${provider.profileConfigured ? "Save provider" : "Configure provider"}</button>
            <button type="button" class="btn btn-sm admin-provider-clear" ${provider.keyConfigured ? "" : "disabled"}>Clear default key</button>
            ${provider.profileConfigured && models.length === 0 ? `<button type="button" class="btn btn-sm danger admin-provider-delete">Remove provider</button>` : ""}
          </div>
          <section class="admin-model-section">
            <div class="admin-model-section-head"><div><p class="admin-eyebrow">Model aliases</p><h4>Models available under ${escapeHtml(provider.displayName)}</h4></div><span class="muted small">${escapeHtml(modelSummary)}</span></div>
            ${models.length ? `<div class="admin-model-list">${models.map((model) => modelRow(model, provider)).join("")}</div>` : `<div class="admin-empty-models">No model aliases yet. Configure the provider, then add the first alias below.</div>`}
            ${addModelForm(provider)}
          </section>
        </article>`;
      }).join("");

      root.innerHTML = `
        <section class="admin-provider-intro card">
          <div>
            <p class="admin-eyebrow">Secure provider registry</p>
            <h2>Provider keys, names, and model aliases</h2>
            <p class="muted">Every API key is write-only and encrypted before it reaches storage. Set a provider default once, override an individual model only when that model needs a different credential, and control the names clients see in the desktop picker.</p>
          </div>
          <div class="admin-security-note"><span aria-hidden="true">◆</span><p><strong>Keys never leave the server.</strong> The dashboard only reports whether a key is configured; it never displays the saved value.</p></div>
        </section>
        ${storageWarning}
        <section class="admin-add-provider-card card">
          <div class="admin-model-section-head"><div><p class="admin-eyebrow">Create provider</p><h3>Add a custom hosted provider</h3></div><span class="muted small">Use an OpenAI-compatible endpoint</span></div>
          <form id="admin-provider-new-form">
            <div class="admin-provider-grid">
              <div class="field"><label>Provider ID</label><input class="field mono" id="new-provider-id" required maxlength="49" placeholder="my-provider" pattern="[a-z][a-z0-9_-]*" /><p class="muted small">Lowercase letters, numbers, dashes, or underscores</p></div>
              <div class="field"><label>Provider alias shown in app</label><input class="field" id="new-provider-name" required maxlength="120" placeholder="My Provider" /></div>
              <div class="field admin-provider-endpoint"><label>Default HTTPS endpoint</label><input class="field mono" id="new-provider-base" required type="url" maxlength="400" placeholder="https://provider.example/v1" /></div>
              <div class="field admin-key-field"><label>Default server API key</label><input class="field" id="new-provider-key" type="password" autocomplete="new-password" placeholder="Paste a provider key" /><p class="muted small">You can add the provider first and save the key later.</p></div>
              <label class="admin-active admin-toggle-field"><input type="checkbox" id="new-provider-active" checked /> Provider active</label>
            </div>
            <div class="admin-row-actions"><button class="btn btn-primary" type="submit">Add provider</button></div>
          </form>
        </section>
        <div class="admin-provider-list">${providerCards}</div>`;

      const providerFields = (card) => ({
        id: card.getAttribute("data-profile-id") || undefined,
        providerId: card.getAttribute("data-provider-id"),
        displayName: card.querySelector(".admin-provider-name").value.trim(),
        baseUrl: card.querySelector(".admin-provider-base").value.trim(),
        active: card.querySelector(".admin-provider-active").checked,
      });

      root.querySelectorAll(".admin-provider-card").forEach((card) => {
        const save = card.querySelector(".admin-provider-save");
        const clear = card.querySelector(".admin-provider-clear");
        const remove = card.querySelector(".admin-provider-delete");
        save?.addEventListener("click", async () => {
          const key = card.querySelector(".admin-provider-key").value.trim();
          save.disabled = true;
          save.textContent = "Saving…";
          try {
            const body = providerFields(card);
            if (key) body.apiKey = key;
            await apiAdmin("/api/admin/providers", {
              method: card.getAttribute("data-profile-configured") === "true" ? "PATCH" : "POST",
              body,
            });
            toast("Provider saved securely");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            save.disabled = false;
            save.textContent = card.getAttribute("data-profile-configured") === "true" ? "Save provider" : "Configure provider";
          }
        });
        clear?.addEventListener("click", async () => {
          if (!confirm("Clear this provider's default API key? Aliases with a route-specific key will continue to work.")) return;
          clear.disabled = true;
          try {
            await apiAdmin("/api/admin/providers", {
              method: "PATCH",
              body: { ...providerFields(card), clearApiKey: true },
            });
            toast("Provider default key cleared");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            clear.disabled = false;
          }
        });
        remove?.addEventListener("click", async () => {
          const providerName = card.querySelector(".admin-provider-name").value.trim() || "this provider";
          if (!confirm(`Remove ${providerName}? It has no model aliases, so this only removes its saved provider configuration.`)) return;
          remove.disabled = true;
          try {
            await apiAdmin("/api/admin/providers", {
              method: "DELETE",
              body: { providerId: card.getAttribute("data-provider-id") },
            });
            toast("Provider removed");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            remove.disabled = false;
          }
        });
      });

      const modelFields = (row) => ({
        id: row.getAttribute("data-model-id"),
        providerId: row.getAttribute("data-provider-id"),
        alias: row.querySelector(".admin-model-alias").value.trim(),
        displayName: row.querySelector(".admin-model-name").value.trim(),
        upstreamModel: row.querySelector(".admin-model-upstream").value.trim(),
        baseUrl: row.querySelector(".admin-model-base").value.trim(),
        active: row.querySelector(".admin-model-active").checked,
      });

      root.querySelectorAll(".admin-model-row").forEach((row) => {
        if (row.getAttribute("data-virtual") === "1") return;
        const save = row.querySelector(".admin-model-save");
        const clear = row.querySelector(".admin-model-clear");
        const remove = row.querySelector(".admin-model-delete");
        save?.addEventListener("click", async () => {
          const key = row.querySelector(".admin-model-key").value.trim();
          save.disabled = true;
          save.textContent = "Saving…";
          try {
            const body = modelFields(row);
            if (key) body.apiKey = key;
            await apiAdmin("/api/admin/models", { method: "PATCH", body });
            toast("Model alias saved");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            save.disabled = false;
            save.textContent = "Save alias";
          }
        });
        clear?.addEventListener("click", async () => {
          if (!confirm("Clear this route-specific API key? The model will use the provider default key if one is configured.")) return;
          clear.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "PATCH",
              body: { ...modelFields(row), clearApiKey: true },
            });
            toast("Route key cleared");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            clear.disabled = false;
          }
        });
        remove?.addEventListener("click", async () => {
          const modelName = row.querySelector(".admin-model-name").value.trim() || "this model alias";
          if (!confirm(`Delete ${modelName}? It will no longer appear in the desktop app.`)) return;
          remove.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "DELETE",
              body: { id: row.getAttribute("data-model-id") },
            });
            toast("Model alias deleted");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            remove.disabled = false;
          }
        });
      });

      root.querySelectorAll(".admin-model-add-form").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const btn = form.querySelector('button[type="submit"]');
          btn.disabled = true;
          btn.textContent = "Adding…";
          try {
            const key = form.querySelector(".new-model-key").value.trim();
            const body = {
              providerId: form.getAttribute("data-provider-id"),
              alias: form.querySelector(".new-model-alias").value.trim(),
              displayName: form.querySelector(".new-model-name").value.trim(),
              upstreamModel: form.querySelector(".new-model-upstream").value.trim(),
              baseUrl: form.querySelector(".new-model-base").value.trim(),
              active: form.querySelector(".new-model-active").checked,
            };
            if (key) body.apiKey = key;
            await apiAdmin("/api/admin/models", { method: "POST", body });
            toast("Model alias added");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
            btn.textContent = "Add model alias";
          }
        });
      });

      root.querySelector("#admin-provider-new-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Adding…";
        try {
          const key = root.querySelector("#new-provider-key").value.trim();
          const body = {
            providerId: root.querySelector("#new-provider-id").value.trim(),
            displayName: root.querySelector("#new-provider-name").value.trim(),
            baseUrl: root.querySelector("#new-provider-base").value.trim(),
            active: root.querySelector("#new-provider-active").checked,
          };
          if (key) body.apiKey = key;
          await apiAdmin("/api/admin/providers", { method: "POST", body });
          toast("Custom provider added securely");
          await paintAdmin("models");
        } catch (ex) {
          toast(String(ex.message || ex));
          btn.disabled = false;
          btn.textContent = "Add provider";
        }
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  async function paintLegacyModels() {
    root.innerHTML = `<p class="muted">Loading hosted models…</p>`;
    try {
      const data = await apiAdmin("/api/admin/models");
      const configs = Array.isArray(data.configs) ? data.configs : [];
      const providerOptions = Array.isArray(data.providerOptions) ? data.providerOptions : [];
      const providerLabels = new Map(
        providerOptions.map((provider) => [provider.id, provider.label]),
      );
      const providerLabel = (id) => {
        const normalized = String(id || "").trim().toLowerCase();
        return providerLabels.get(normalized) || normalized
          .split(/[-_]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ") || "Hosted provider";
      };
      const knownProviderIds = new Set(providerOptions.map((provider) => provider.id));
      for (const config of configs) knownProviderIds.add(config.providerId);
      const formProviderOptions = [...knownProviderIds]
        .sort((left, right) => providerLabel(left).localeCompare(providerLabel(right)))
        .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(providerLabel(id))} · ${escapeHtml(id)}</option>`)
        .join("");
      const groupedConfigs = new Map();
      for (const config of configs) {
        const rows = groupedConfigs.get(config.providerId) || [];
        rows.push(config);
        groupedConfigs.set(config.providerId, rows);
      }
      const storageWarning = data.credentialStorageReady
        ? ""
        : `<div class="alert warn">Credential encryption is not configured on the server. Set <code>HORMACHUELOS_MODEL_CONFIG_KEY</code> before saving a model key.</div>`;
      const tables = [...groupedConfigs.entries()]
        .sort(([left], [right]) => providerLabel(left).localeCompare(providerLabel(right)))
        .map(([providerId, rows]) => `
          <section class="card" style="margin-bottom:16px">
            <div style="display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap">
              <div><h3 style="margin:0">${escapeHtml(providerLabel(providerId))}</h3><p class="muted small mono" style="margin:4px 0 0">provider alias: ${escapeHtml(providerId)}</p></div>
              <span class="muted small">${rows.length} model route${rows.length === 1 ? "" : "s"}</span>
            </div>
            <div class="admin-table-wrap" style="margin-top:12px">
              <table class="admin-table">
                <thead><tr><th>Provider alias</th><th>Model alias &amp; name</th><th>Upstream model</th><th>Base URL</th><th>Server key</th><th>Active</th><th></th></tr></thead>
                <tbody>
                  ${rows
                    .slice()
                    .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)))
                    .map((model) => `<tr data-model-id="${escapeHtml(model.id)}">
                      <td><input class="field admin-model-provider" value="${escapeHtml(model.providerId)}" aria-label="Provider alias" /></td>
                      <td><input class="field admin-model-alias mono" value="${escapeHtml(model.alias)}" aria-label="Model alias" /><input class="field admin-model-name" value="${escapeHtml(model.displayName)}" aria-label="Model display name" style="margin-top:6px" /></td>
                      <td><input class="field admin-model-upstream" value="${escapeHtml(model.upstreamModel)}" aria-label="Upstream model ID" /></td>
                      <td><input class="field admin-model-base" type="url" value="${escapeHtml(model.baseUrl)}" aria-label="HTTPS base URL" /></td>
                      <td><input class="field admin-model-key" type="password" autocomplete="new-password" placeholder="${model.keyConfigured ? "•••••••• (leave blank to keep)" : "No key saved"}" aria-label="Replacement server API key" /><span class="muted small">${model.keyConfigured ? "Key configured" : "No key configured"}</span></td>
                      <td><label class="admin-active"><input type="checkbox" class="admin-model-active" ${model.active ? "checked" : ""} /> Active</label></td>
                      <td><button type="button" class="btn btn-sm btn-primary admin-model-save">Save</button><button type="button" class="btn btn-sm admin-model-clear" ${model.keyConfigured ? "" : "disabled"}>Clear key</button><button type="button" class="btn btn-sm danger admin-model-delete">Delete</button></td>
                    </tr>`)
                    .join("")}
                </tbody>
              </table>
            </div>
          </section>`)
        .join("");
      root.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <h3 style="margin-top:0">Hosted provider and model aliases</h3>
          <p class="muted small">Create a provider alias, then add one or more model aliases beneath it. Each route keeps its upstream API key encrypted on the server; keys are never returned to the desktop app or ordinary users.</p>
          ${storageWarning}
          <form id="hosted-model-form" class="admin-release-form">
            <div class="field"><label>Provider alias</label><select id="model-provider" class="field">${formProviderOptions}<option value="__custom__">Create a custom provider alias…</option></select></div>
            <div class="field" id="model-provider-custom-wrap" hidden><label>New provider alias</label><input id="model-provider-custom" class="field mono" maxlength="49" placeholder="my-provider" pattern="[a-z][a-z0-9_-]*" /><p class="muted small" style="margin:6px 0 0">Use lowercase letters, numbers, dashes, or underscores. This identifier is the provider alias shown in the app.</p></div>
            <div class="field"><label>Model alias</label><input id="model-alias" class="field mono" required maxlength="81" placeholder="my-model-fast" pattern="[a-z0-9][a-z0-9._-]*" /></div>
            <div class="field"><label>Model display name</label><input id="model-name" class="field" required maxlength="120" placeholder="My Model Fast" /></div>
            <div class="field"><label>Upstream model ID</label><input id="model-upstream" class="field" required maxlength="200" placeholder="grok-4.5" /></div>
            <div class="field"><label>HTTPS base URL</label><input id="model-base" class="field" required type="url" maxlength="400" placeholder="https://provider.example/v1" /></div>
            <div class="field"><label>Server API key</label><input id="model-key" class="field" type="password" autocomplete="new-password" placeholder="Paste once — it will not be shown again" /><p class="muted small" style="margin:6px 0 0">Required for a route to become available. Leave blank only when you are creating the route first and will add its key afterward.</p></div>
            <p class="muted small" style="margin:0 0 12px">Example: select <code>xAI</code>, use model alias <code>gpt-5.6-sol</code> with upstream ID <code>grok-4.5</code>, and set the base URL to <code>https://api.x.ai/v1</code>.</p>
            <label class="admin-active" style="margin:8px 0 14px;display:inline-flex"><input type="checkbox" id="model-active" checked /> Active</label>
            <div class="field-error" id="model-error" hidden></div>
            <button class="btn btn-primary" type="submit">Add model alias</button>
          </form>
        </div>
        ${tables || `<div class="card muted">No hosted model aliases yet. Add the first provider route above.</div>`}`;

      const fieldsFor = (row) => ({
        id: row.getAttribute("data-model-id"),
        providerId: row.querySelector(".admin-model-provider").value.trim(),
        alias: row.querySelector(".admin-model-alias").value.trim(),
        displayName: row.querySelector(".admin-model-name").value.trim(),
        upstreamModel: row.querySelector(".admin-model-upstream").value.trim(),
        baseUrl: row.querySelector(".admin-model-base").value.trim(),
        active: row.querySelector(".admin-model-active").checked,
      });

      root.querySelectorAll("tr[data-model-id]").forEach((row) => {
        row.querySelector(".admin-model-save").addEventListener("click", async () => {
          const btn = row.querySelector(".admin-model-save");
          const keyInput = row.querySelector(".admin-model-key");
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            const body = fieldsFor(row);
            if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
            await apiAdmin("/api/admin/models", { method: "PATCH", body });
            toast("Hosted model saved");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
            btn.textContent = "Save";
          }
        });
        row.querySelector(".admin-model-clear").addEventListener("click", async () => {
          if (!confirm("Clear this server-side API key? The model will stop serving requests until a new key is saved.")) return;
          const btn = row.querySelector(".admin-model-clear");
          btn.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "PATCH",
              body: { ...fieldsFor(row), clearApiKey: true },
            });
            toast("Hosted model key cleared");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
          }
        });
        row.querySelector(".admin-model-delete").addEventListener("click", async () => {
          const modelName = row.querySelector(".admin-model-name").value.trim() || "this model alias";
          if (!confirm(`Delete ${modelName}? This removes its server-side route and stops it from appearing in the desktop app.`)) return;
          const btn = row.querySelector(".admin-model-delete");
          btn.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "DELETE",
              body: { id: row.getAttribute("data-model-id") },
            });
            toast("Hosted model alias deleted");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
          }
        });
      });

      const providerSelect = root.querySelector("#model-provider");
      const customProviderWrap = root.querySelector("#model-provider-custom-wrap");
      const customProviderInput = root.querySelector("#model-provider-custom");
      const syncCustomProvider = () => {
        const isCustom = providerSelect.value === "__custom__";
        customProviderWrap.hidden = !isCustom;
        customProviderInput.required = isCustom;
      };
      providerSelect.addEventListener("change", syncCustomProvider);
      syncCustomProvider();

      root.querySelector("#hosted-model-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = root.querySelector("#model-error");
        const btn = root.querySelector('#hosted-model-form button[type="submit"]');
        error.hidden = true;
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
          const providerId = providerSelect.value === "__custom__"
            ? customProviderInput.value.trim()
            : providerSelect.value;
          await apiAdmin("/api/admin/models", {
            method: "POST",
            body: {
              providerId,
              alias: root.querySelector("#model-alias").value.trim(),
              displayName: root.querySelector("#model-name").value.trim(),
              upstreamModel: root.querySelector("#model-upstream").value.trim(),
              baseUrl: root.querySelector("#model-base").value.trim(),
              apiKey: root.querySelector("#model-key").value.trim(),
              active: root.querySelector("#model-active").checked,
            },
          });
          toast("Hosted model added");
          await paintAdmin("models");
        } catch (ex) {
          error.hidden = false;
          error.textContent = String(ex.message || ex);
          btn.disabled = false;
          btn.textContent = "Add model alias";
        }
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  async function paintReleases() {
    root.innerHTML = `<p class="muted">Loading releases…</p>`;
    try {
      const data = await apiAdmin("/api/admin/releases");
      const releases = data.releases || [];
      root.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <h3 style="margin-top:0">Publish software update</h3>
          <p class="muted small">Users on older builds will see What's new and must update when Force update is on.</p>
          <form id="release-form" class="admin-release-form">
            <div class="field"><label>Version</label><input id="rel-version" class="field" required placeholder="0.1.1" /></div>
            <div class="field"><label>Title</label><input id="rel-title" class="field" placeholder="Hormachuelos 0.1.1" /></div>
            <div class="field"><label>What's new</label><textarea id="rel-notes" class="field" rows="5" required placeholder="• Bug fixes&#10;• New features"></textarea></div>
            <div class="field"><label>MSI download URL</label><input id="rel-msi" class="field" type="url" placeholder="https://…/Hormachuelos_x_x64_en-US.msi" /></div>
            <div class="field"><label>MSI SHA-256</label><input id="rel-msi-sha256" class="field mono" maxlength="64" pattern="[a-fA-F0-9]{64}" placeholder="64-character installer checksum" /></div>
            <div class="field"><label>EXE download URL</label><input id="rel-exe" class="field" type="url" placeholder="https://…/Hormachuelos_x_x64-setup.exe" /></div>
            <div class="field"><label>EXE SHA-256</label><input id="rel-exe-sha256" class="field mono" maxlength="64" pattern="[a-fA-F0-9]{64}" placeholder="64-character installer checksum" /></div>
            <label class="admin-active" style="margin:8px 0 14px;display:inline-flex">
              <input type="checkbox" id="rel-force" checked /> Force update (block old app until installed)
            </label>
            <div class="field-error" id="rel-error" hidden></div>
            <button class="btn btn-primary" type="submit">Publish update</button>
          </form>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Title</th>
                <th>Force</th>
                <th>Latest</th>
                <th>Published</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${
                releases.length
                  ? releases
                      .map(
                        (r) => `<tr data-id="${escapeHtml(r.id)}">
                  <td class="mono">${escapeHtml(r.version)}${r.isLatest ? " · latest" : ""}</td>
                  <td>${escapeHtml(r.title || "")}</td>
                  <td>${r.forceUpdate ? "Yes" : "No"}</td>
                  <td>${r.isLatest ? "Yes" : "—"}</td>
                  <td class="mono small">${escapeHtml(String(r.publishedAt || "").slice(0, 10))}</td>
                  <td><button type="button" class="btn btn-sm admin-toggle-force" data-force="${r.forceUpdate ? "0" : "1"}">${r.forceUpdate ? "Disable force" : "Enable force"}</button></td>
                </tr>`,
                      )
                      .join("")
                  : `<tr><td colspan="6" class="muted">No releases yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>`;

      root.querySelector("#release-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const err = root.querySelector("#rel-error");
        const btn = root.querySelector('#release-form button[type="submit"]');
        err.hidden = true;
        btn.disabled = true;
        btn.textContent = "Publishing…";
        try {
          await apiAdmin("/api/admin/releases", {
            method: "POST",
            body: {
              version: root.querySelector("#rel-version").value.trim(),
              title: root.querySelector("#rel-title").value.trim(),
              whatsNew: root.querySelector("#rel-notes").value.trim(),
              msiUrl: root.querySelector("#rel-msi").value.trim(),
              msiSha256: root.querySelector("#rel-msi-sha256").value.trim(),
              exeUrl: root.querySelector("#rel-exe").value.trim(),
              exeSha256: root.querySelector("#rel-exe-sha256").value.trim(),
              forceUpdate: root.querySelector("#rel-force").checked,
              isLatest: true,
            },
          });
          toast("Update published");
          await paintAdmin("releases");
        } catch (ex) {
          err.hidden = false;
          err.textContent = String(ex.message || ex);
          btn.disabled = false;
          btn.textContent = "Publish update";
        }
      });

      root.querySelectorAll(".admin-toggle-force").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tr = btn.closest("tr");
          try {
            await apiAdmin("/api/admin/releases", {
              method: "PATCH",
              body: { id: tr.getAttribute("data-id"), forceUpdate: btn.getAttribute("data-force") === "1" },
            });
            toast("Release updated");
            await paintAdmin("releases");
          } catch (ex) {
            toast(String(ex.message || ex));
          }
        });
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  paintAdmin("users");
  return wrap;
}

function renderCheckout() {
  const user = getSessionUser();
  const q = queryOf();
  const tier = q.get("tier") || "";
  const period = q.get("period") || "payg";
  const checkout = gcashCheckoutDetails(q.get("plan") || "pro", tier);
  const planId = checkout.planId;
  const amount = checkout.amountPhp;
  const planLabel = checkoutPlanLabel(planId, tier);
  const { plan } = findPlanByCheckoutId(planId, tier);
  const tierQ = tier ? `&tier=${encodeURIComponent(tier)}` : "";

  if (!user) {
    navigate(`/login?next=${encodeURIComponent(`/checkout?plan=${planId}&period=${period}${tierQ}`)}`);
    return page(`<div class="container" style="padding:48px 0"><p class="muted">Please log in…</p></div>`);
  }

  const wrap = page(`
    <div class="container checkout-layout">
      <div>
        <h1 style="margin:0 0 8px;font-size:1.6rem;letter-spacing:-0.03em">Checkout</h1>
        <p class="muted" style="margin:0 0 20px">Pay the exact plan amount with GCash, then submit one clear receipt image for secure review. Your paid plan activates only after approval.</p>
        <section class="card gcash-payment-card" aria-labelledby="gcash-payment-heading">
          <div class="payment-step-heading">
            <span class="payment-step-number" aria-hidden="true">1</span>
            <div><h3 id="gcash-payment-heading">Scan this GCash QR</h3><p class="muted small">This QR is locked to ${escapeHtml(planLabel)} · ${escapeHtml(formatPHP(amount))} only.</p></div>
          </div>
          <div class="payment-amount-lock"><span>Exact amount to pay</span><strong id="payment-amount-lock">${formatPHP(amount)}</strong></div>
          <div class="gcash-qr-panel">
            <div class="gcash-qr-frame"><img id="gcash-qr" class="gcash-qr-image" src="${escapeHtml(checkout.qrPath)}" alt="GCash QR code for ${escapeHtml(formatPHP(amount))}" /></div>
            <div class="gcash-qr-copy"><span class="pay-badge">GCash</span><strong id="gcash-receiver">Pay ${escapeHtml(formatPHP(amount))} to ${escapeHtml(checkout.receiverLabel)}</strong><p class="muted small">Pay exactly <span id="gcash-amount">${escapeHtml(formatPHP(amount))}</span>. A different amount cannot be auto-approved.</p></div>
          </div>
          <button type="button" class="btn btn-primary btn-block btn-lg" id="pay-btn">I've paid — upload receipt</button>
          <p class="muted small center" style="margin:12px 0 0">Do not send a GCash PIN, OTP, or account password to Hormachuelos.</p>
        </section>
        <section class="card gcash-proof-card" id="payment-proof-stage" hidden aria-labelledby="payment-proof-heading">
          <div class="payment-step-heading">
            <span class="payment-step-number" aria-hidden="true">2</span>
            <div><h3 id="payment-proof-heading">Upload your receipt</h3><p class="muted small">Use a clear JPG, PNG, or WebP proof (up to 6 MB) showing the ${escapeHtml(formatPHP(amount))} payment.</p></div>
          </div>
          <div class="receipt-upload-wrap">
            <input id="payment-proof-input" type="file" accept="image/jpeg,image/png,image/webp" hidden />
            <label class="receipt-upload" for="payment-proof-input">
              <span class="receipt-upload-icon" aria-hidden="true">↑</span>
              <span><strong>Choose payment proof</strong><small id="payment-proof-file">No file selected</small></span>
            </label>
            <img id="payment-proof-preview" class="receipt-proof-preview" alt="Selected receipt preview" hidden />
          </div>
          <div class="receipt-scan" id="payment-scan-progress" hidden aria-live="polite">
            <div class="receipt-scan-visual" aria-hidden="true"><span></span><i></i></div>
            <div><strong id="payment-scan-title">Preparing secure receipt scan…</strong><p class="muted small" id="payment-scan-detail">Your proof stays in private storage while it is checked.</p></div>
          </div>
          <div class="alert" id="payment-result" hidden role="status"></div>
          <button type="button" class="btn btn-primary btn-block" id="submit-payment-proof" disabled>Submit proof for secure review</button>
          <p class="muted small center" style="margin:12px 0 0">Automated checks compare the exact amount, receipt fingerprint, reference number, and visual consistency. Uncertain receipts are reviewed manually.</p>
        </section>
      </div>
      <aside class="checkout-summary">
        <h2>Order summary</h2>
        <div class="summary-row"><span>Plan</span><span>${escapeHtml(planLabel)}</span></div>
        <div class="summary-row"><span>Billing</span><span>Pay as you go</span></div>
        <div class="summary-row"><span>Account</span><span class="mono small">${escapeHtml(user.email)}</span></div>
        <div class="summary-row total"><span>Total</span><span class="mono">${formatPHP(amount)}</span></div>
        <ul class="feature-list" style="margin-top:12px">
          ${plan.features
            .slice(0, 4)
            .map((f) => `<li>${escapeHtml(typeof f === "string" ? f : f.title)}</li>`)
            .join("")}
        </ul>
      </aside>
    </div>
  `);

  const payBtn = wrap.querySelector("#pay-btn");

  const proofStage = wrap.querySelector("#payment-proof-stage");
  const paymentQr = wrap.querySelector("#gcash-qr");
  const paymentAmount = wrap.querySelector("#gcash-amount");
  const paymentReceiver = wrap.querySelector("#gcash-receiver");
  const proofInput = wrap.querySelector("#payment-proof-input");
  const proofFileName = wrap.querySelector("#payment-proof-file");
  const proofPreview = wrap.querySelector("#payment-proof-preview");
  const submitProofButton = wrap.querySelector("#submit-payment-proof");
  const scanProgress = wrap.querySelector("#payment-scan-progress");
  const scanTitle = wrap.querySelector("#payment-scan-title");
  const scanDetail = wrap.querySelector("#payment-scan-detail");
  const paymentResult = wrap.querySelector("#payment-result");
  let activePayment = null;
  let selectedProof = null;
  let previewUrl = "";
  let scanTimer = null;

  const scanPhases = [
    ["Uploading your private proof…", "The image is sent directly to protected receipt storage."],
    ["Checking the receipt fingerprint…", "The same image cannot be reused for another payment request."],
    ["Inspecting receipt details…", "The secure scanner compares visible GCash details with the exact plan amount."],
    ["Comparing the reference number…", "A repeated reference number always requires manual review."],
  ];

  function showPaymentResult(order, autoApproved) {
    if (!order) return;
    upsertPaymentRequest(order);
    paymentResult.hidden = false;
    paymentResult.className = "alert " + (order.status === "approved" ? "ok" : "warn");
    if (autoApproved || order.status === "approved") {
      paymentResult.textContent = "Payment approved. Your plan is active and will appear in the dashboard shortly.";
      void refreshSessionUser();
      submitProofButton.disabled = true;
      proofInput.disabled = true;
      return;
    }
    const reason = order.scanSummary ? " " + order.scanSummary : "";
    paymentResult.textContent =
      "Receipt submitted. Status: " + paymentStatusText(order.status) + "." + reason +
      " You can track the decision from your dashboard.";
    submitProofButton.disabled = true;
  }

  function showPaymentError(message) {
    paymentResult.hidden = false;
    paymentResult.className = "alert warn";
    paymentResult.textContent = String(message || "We could not process that receipt. Please try again.");
  }

  function setScanState(running) {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    scanProgress.hidden = !running;
    scanProgress.classList.toggle("is-scanning", running);
    if (!running) return;
    let index = 0;
    const paintPhase = () => {
      const phase = scanPhases[index % scanPhases.length];
      scanTitle.textContent = phase[0];
      scanDetail.textContent = phase[1];
      index += 1;
    };
    paintPhase();
    scanTimer = window.setInterval(paintPhase, 3200);
  }

  payBtn.textContent = "I've paid — upload receipt";
  payBtn.addEventListener("click", async () => {
    if (activePayment) {
      proofStage.hidden = false;
      proofStage.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    payBtn.disabled = true;
    payBtn.textContent = "Preparing secure payment…";
    paymentResult.hidden = true;
    try {
      const created = await apiAuth("/api/payments/create", {
        method: "POST",
        body: { planId, period },
      });
      activePayment = created.order;
      upsertPaymentRequest(activePayment);
      if (created.payment?.qrPath) paymentQr.src = created.payment.qrPath;
      if (created.payment?.amountPhp) {
        paymentAmount.textContent = formatPHP(created.payment.amountPhp);
        paymentReceiver.textContent =
          "Pay " + formatPHP(created.payment.amountPhp) + " to " + (created.payment.receiverLabel || GCASH_RECEIVER_LABEL);
      }
      proofStage.hidden = false;
      payBtn.textContent = "Receipt upload ready";
      proofStage.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      showPaymentError(error.message || error);
      payBtn.disabled = false;
      payBtn.textContent = "I've paid — upload receipt";
    }
  });

  proofInput.addEventListener("change", () => {
    const file = proofInput.files?.[0] || null;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }
    selectedProof = null;
    proofPreview.hidden = true;
    submitProofButton.disabled = true;
    paymentResult.hidden = true;
    if (!file) {
      proofFileName.textContent = "No file selected";
      return;
    }
    const accepted = ["image/jpeg", "image/png", "image/webp"];
    if (!accepted.includes(file.type) || file.size <= 0 || file.size > 6 * 1024 * 1024) {
      proofInput.value = "";
      proofFileName.textContent = "Choose a JPG, PNG, or WebP image up to 6 MB";
      showPaymentError("Choose a clear JPG, PNG, or WebP receipt image no larger than 6 MB.");
      return;
    }
    selectedProof = file;
    previewUrl = URL.createObjectURL(file);
    proofPreview.src = previewUrl;
    proofPreview.hidden = false;
    proofFileName.textContent = file.name + " · " + (file.size / 1024 / 1024).toFixed(1) + " MB";
    submitProofButton.disabled = false;
  });

  submitProofButton.addEventListener("click", async () => {
    if (!activePayment || !selectedProof) {
      showPaymentError("Open the GCash QR and choose a receipt image first.");
      return;
    }
    submitProofButton.disabled = true;
    proofInput.disabled = true;
    paymentResult.hidden = true;
    setScanState(true);
    try {
      const intent = await apiAuth("/api/payments/upload-intent", {
        method: "POST",
        body: {
          orderId: activePayment.id,
          mimeType: selectedProof.type,
          bytes: selectedProof.size,
        },
      });
      activePayment = intent.order;
      upsertPaymentRequest(activePayment);
      const uploadHeaders = {
        "Content-Type": selectedProof.type,
        "x-upsert": "false",
        "Cache-Control": "max-age=3600",
      };
      // The server returns a short-lived, one-object signed URL. Its scoped
      // Storage token stays in that URL; the browser never receives a service
      // role key or a general-purpose API credential.
      const uploaded = await fetch(intent.uploadUrl, {
        method: "PUT",
        headers: uploadHeaders,
        body: selectedProof,
      });
      if (!uploaded.ok) throw new Error("The receipt image could not be uploaded. Please try again.");
      const submitted = await apiAuth("/api/payments/submit", {
        method: "POST",
        body: { orderId: activePayment.id },
      });
      activePayment = submitted.order;
      showPaymentResult(submitted.order, submitted.autoApproved);
    } catch (error) {
      showPaymentError(error.message || error);
      submitProofButton.disabled = !selectedProof;
      proofInput.disabled = false;
    } finally {
      setScanState(false);
    }
  });

  return wrap;
}

function renderSuccess() {
  const paymentOrderId = queryOf().get("order");
  const wrap = page(
    '<div class="container payment-status-page">' +
      '<div class="eyebrow"><span class="dot"></span> Payment request</div>' +
      '<h1>Payment status</h1>' +
      '<p class="muted" id="payment-success-copy">Checking your payment request…</p>' +
      '<p class="mono small muted" id="payment-success-id"></p>' +
      '<div class="payment-status-actions"><a class="btn btn-primary" href="#/dashboard">Go to dashboard</a><a class="btn" href="#/pricing">View plans</a></div>' +
    '</div>',
  );
  const copy = wrap.querySelector("#payment-success-copy");
  const id = wrap.querySelector("#payment-success-id");
  if (!paymentOrderId || !getSessionToken()) {
    copy.textContent = "Open your dashboard to review payment requests and plan status.";
  } else {
    id.textContent = "Request " + paymentOrderId.slice(0, 8);
    void apiAuth("/api/payments/status?orderId=" + encodeURIComponent(paymentOrderId))
      .then((data) => {
        const request = data.order;
        upsertPaymentRequest(request);
        copy.textContent =
          paymentStatusText(request.status) +
          ". " +
          (request.scanSummary || "Your dashboard will show the latest decision.");
      })
      .catch(() => {
        copy.textContent = "Your payment request is recorded. Open the dashboard for the latest status.";
      });
  }
  return wrap;
}

function renderDownload() {
  const { version, windows } = DESKTOP_DOWNLOADS;
  const optimized = OPTIMIZED_DOWNLOADS;
  const wrap = page(`
    <div class="prose container">
      <h1>Download Hormachuelos</h1>
      <p>Choose the standard release or the independent FPS-focused Optimized edition.</p>
      <div class="card" id="optimized-download" style="margin:20px 0;border-color:var(--primary)">
        <div class="eyebrow" style="margin-bottom:10px"><span class="dot"></span> New optimized release</div>
        <h3 style="margin-top:0">Hormachuelos Optimized v${optimized.version}</h3>
        <p class="muted small">Adaptive Director, smarter automatic mode switching, maximized Ask / Plan / Research / Multi-Agent / Build behavior, and a cleaner AI reply layout. Installs independently from the standard edition.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-primary" id="optimized-exe" href="${optimized.windows.setup.href}">${escapeHtml(optimized.windows.setup.label)}</a>
          <a class="btn" id="optimized-msi" href="${optimized.windows.msi.href}">${escapeHtml(optimized.windows.msi.label)}</a>
          <a class="btn btn-ghost" href="${optimized.releaseNotes}" target="_blank" rel="noopener noreferrer">Release notes</a>
        </div>
      </div>
      <div class="card" style="margin:20px 0">
        <h3 style="margin-top:0">Standard edition</h3>
        <p id="dl-lead" class="muted small">Loading the latest standard build…</p>
        <p class="muted small">After install, open Hormachuelos — it opens this website so you can <strong>log in or sign up</strong>, then the app signs in automatically.</p>
        <div id="dl-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-primary" id="dl-msi" href="${windows.msi.href}">${escapeHtml(windows.msi.label)}</a>
          <a class="btn" id="dl-exe" href="${windows.setup.href}">${escapeHtml(windows.setup.label)}</a>
          <a class="btn btn-ghost" href="#/update">What's new / Update</a>
        </div>
        <ol class="muted small" style="margin:16px 0 0;padding-left:18px;line-height:1.55">
          <li>Download &amp; install</li>
          <li>Open the app → browser opens for login/signup</li>
          <li>Return to the app — you're signed in automatically</li>
        </ol>
      </div>
    </div>
  `);
  (async () => {
    try {
      const data = await fetch("/api/update").then((r) => r.json());
      const latest = data.latest;
      if (!latest) return;
      const lead = wrap.querySelector("#dl-lead");
      if (lead) {
        lead.textContent = `Latest: v${latest.version}${latest.title ? ` · ${latest.title}` : ""} · 64-bit Windows`;
      }
      const msi = wrap.querySelector("#dl-msi");
      const exe = wrap.querySelector("#dl-exe");
      if (msi && latest.msiUrl) {
        msi.href = latest.msiUrl;
        msi.textContent = `Windows installer (MSI) v${latest.version}`;
      }
      if (exe && latest.exeUrl) {
        exe.href = latest.exeUrl;
        exe.textContent = `Windows setup (EXE) v${latest.version}`;
      }
    } catch {
      const lead = wrap.querySelector("#dl-lead");
      if (lead) lead.textContent = `Install the desktop AI agent on Windows. v${version} · 64-bit.`;
    }
  })();
  return wrap;
}

function renderUpdate() {
  const wrap = page(`
    <div class="prose container">
      <h1>Update Hormachuelos</h1>
      <p class="muted" id="upd-lead">Checking for the latest desktop build…</p>
      <div class="card" id="upd-card" style="margin:20px 0">
        <p class="muted" style="margin:0">Loading…</p>
      </div>
    </div>
  `);
  (async () => {
    const card = wrap.querySelector("#upd-card");
    const lead = wrap.querySelector("#upd-lead");
    try {
      const data = await fetch("/api/update").then((r) => r.json());
      const latest = data.latest;
      if (!latest) {
        lead.textContent = "No published releases yet.";
        card.innerHTML = `<p class="muted" style="margin:0">Check back soon.</p>`;
        return;
      }
      lead.textContent = latest.forceUpdate
        ? "A required update is available. Install before using the desktop app."
        : "Install the latest build to get fixes and new features.";
      const notes = escapeHtml(latest.whatsNew || "Improvements and fixes.")
        .replace(/\n/g, "<br>");
      card.innerHTML = `
        <div class="eyebrow" style="margin-bottom:10px"><span class="dot"></span> Latest release</div>
        <h2 style="margin:0 0 8px;font-size:1.45rem">${escapeHtml(latest.title || `v${latest.version}`)}</h2>
        <p class="mono small muted" style="margin:0 0 16px">Version ${escapeHtml(latest.version)} · ${escapeHtml(String(latest.publishedAt || "").slice(0, 10))}${latest.forceUpdate ? " · required update" : ""}</p>
        <h3 style="margin:0 0 8px">What's new</h3>
        <div class="update-notes">${notes}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:20px">
          ${latest.msiUrl ? `<a class="btn btn-primary" href="${escapeHtml(latest.msiUrl)}">Update (MSI)</a>` : ""}
          ${latest.exeUrl ? `<a class="btn btn-primary" href="${escapeHtml(latest.exeUrl)}">Update (EXE)</a>` : ""}
          <a class="btn" href="#/download">Download page</a>
        </div>`;
    } catch (ex) {
      lead.textContent = "Could not load update info.";
      card.innerHTML = `<p class="muted" style="margin:0">${escapeHtml(String(ex.message || ex))}</p>`;
    }
  })();
  return wrap;
}

function renderFaq() {
  const wrap = page(`
    <section class="section" style="border-top:0;padding-top:48px">
      <div class="container">
        <div class="section-head center ix-reveal">
          <h2 data-ix-split>FAQ</h2>
          <p data-ix-hover-words>Straight answers — Taglish welcome in support. Open a question to type the answer.</p>
        </div>
        <div class="faq-list" id="faq-list"></div>
      </div>
    </section>
  `);
  const list = wrap.querySelector("#faq-list");
  FAQ.forEach((item, i) => {
    const row = el(`
      <div class="faq-item ${i === 0 ? "open" : ""}">
        <button type="button">${escapeHtml(item.q)} <span>${i === 0 ? "−" : "+"}</span></button>
        <div class="answer" data-full="${escapeHtml(item.a)}"></div>
      </div>
    `);
    const answer = row.querySelector(".answer");
    if (i === 0) {
      // first open: type on mount after interactions init — mark for type
      answer.setAttribute("data-type-on-show", "1");
      answer.textContent = prefersReducedMotion() ? item.a : "";
    }
    row.querySelector("button").addEventListener("click", () => {
      const open = row.classList.toggle("open");
      row.querySelector("span").textContent = open ? "−" : "+";
      if (open) {
        typeInto(answer, item.a, 12);
      }
    });
    list.appendChild(row);
  });
  // Type first answer shortly after paint
  const first = list.querySelector(".faq-item.open .answer");
  if (first && first.getAttribute("data-type-on-show")) {
    window.setTimeout(() => typeInto(first, FAQ[0].a, 12), 200);
  }
  return wrap;
}

function renderSupport() {
  const wrap = page(`
    <div class="prose container">
      <h1>Support</h1>
      <p>Prefer Messenger or Viber — we reply in Taglish. Demo form stores nothing on a server.</p>
      <form id="support-form" class="card" style="margin-top:20px">
        <div class="field">
          <label for="sup-name">Name</label>
          <input id="sup-name" required placeholder="Your name" />
        </div>
        <div class="field">
          <label for="sup-email">Email</label>
          <input id="sup-email" type="email" required placeholder="you@email.com" />
        </div>
        <div class="field">
          <label for="sup-msg">Message</label>
          <textarea id="sup-msg" required placeholder="Paano mag-upgrade via GCash?"></textarea>
        </div>
        <button class="btn btn-primary" type="submit">Send message</button>
      </form>
    </div>
  `);
  wrap.querySelector("#support-form").addEventListener("submit", (e) => {
    e.preventDefault();
    toast("Message queued (demo). We'll wire this to email/Messenger later.");
    e.target.reset();
  });
  return wrap;
}

const TERMS = `
  <p>By using Hormachuelos and this website you agree to use the product lawfully, keep your account credentials private, and not abuse rate limits or shared infrastructure.</p>
  <p>Subscriptions and credit packs are sold in Philippine Pesos at the prices shown at checkout (temporary promo pricing may change).</p>
  <p>GCash payment proofs are reviewed against the selected plan amount, receipt fingerprint, reference number, and visual evidence. A receipt scan is a fraud-control measure, not a bank confirmation; Hormachuelos may request a manual review before activating a plan.</p>
`;

const PRIVACY = `
  <p>We collect account email, name, plan metadata, and the minimum payment-proof information needed to operate billing and support.</p>
  <p>Payment-proof images are stored privately for review. We do not ask for or store your GCash PIN, OTP, or account password.</p>
  <p>Project files stay on your machine when using the desktop agent unless you explicitly connect cloud features.</p>
`;

const REFUNDS = `
  <p>First-time purchases may be refunded within 7 days if token usage is minimal and the license has not been widely redistributed.</p>
  <p>Contact support with your order id. Abuse, chargebacks without contact, or heavy token consumption may void eligibility.</p>
  <p>Promotional and demo orders on this site are not real charges.</p>
`;

function renderLegal(title, bodyHtml) {
  return page(`
    <div class="prose container">
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
  `);
}

function renderNotFound() {
  return page(`
    <div class="container center" style="padding:80px 0">
      <h1>404</h1>
      <p class="muted">Page not found.</p>
      <a class="btn" href="#/">Home</a>
    </div>
  `);
}

// ——— boot ———

// ——— Interactive text engine ———

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

/** Split element text into hoverable words. */
function splitWords(el) {
  if (!el || el.dataset.ixSplitDone === "1") return;
  // Don't destroy nested interactive nodes
  if (el.querySelector(".ix-type, #hero-type, input, button, a")) return;
  const text = el.textContent || "";
  if (!text.trim()) return;
  el.dataset.ixSplitDone = "1";
  if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", text.trim());
  const parts = text.split(/(\s+)/);
  el.textContent = "";
  el.classList.add("ix-split");
  for (const part of parts) {
    if (/^\s+$/.test(part) || part === "") {
      el.appendChild(document.createTextNode(part));
      continue;
    }
    const span = document.createElement("span");
    span.className = "ix-word";
    span.textContent = part;
    el.appendChild(span);
  }
}

function splitWordsIn(root) {
  root.querySelectorAll("[data-ix-split]").forEach((el) => splitWords(el));
}

/** Wrap each word so hover highlights it. */
function hoverWordsIn(root) {
  root.querySelectorAll("[data-ix-hover-words]").forEach((el) => {
    if (el.dataset.ixHoverDone === "1") return;
    const text = el.textContent || "";
    if (!text.trim()) return;
    el.dataset.ixHoverDone = "1";
    el.classList.add("ix-hover-words");
    const words = text.split(/(\s+)/);
    el.textContent = "";
    for (const w of words) {
      if (/^\s+$/.test(w)) {
        el.appendChild(document.createTextNode(w));
        continue;
      }
      const span = document.createElement("span");
      span.className = "ix-hword";
      span.textContent = w;
      el.appendChild(span);
    }
  });
}

/** Typewriter into element; returns cancel fn. */
function typeInto(el, text, msPerChar = 28) {
  if (!el) return () => {};
  let i = 0;
  let cancelled = false;
  el.textContent = "";
  el.classList.add("ix-typing");
  if (prefersReducedMotion()) {
    el.textContent = text;
    el.classList.remove("ix-typing");
    return () => {};
  }
  const tick = () => {
    if (cancelled) return;
    i += 1;
    el.textContent = text.slice(0, i);
    if (i < text.length) {
      timer = window.setTimeout(tick, msPerChar);
    } else {
      el.classList.remove("ix-typing");
    }
  };
  let timer = window.setTimeout(tick, msPerChar);
  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    el.classList.remove("ix-typing");
  };
  onPageCleanup(cancel);
  return cancel;
}

/** Rotating phrase typewriter. */
function rotateType(el, phrases, { typeMs = 55, holdMs = 1600, deleteMs = 32 } = {}) {
  if (!el || !phrases.length) return;
  if (prefersReducedMotion()) {
    el.textContent = phrases[0];
    return;
  }
  let pi = 0;
  let cancelled = false;
  let timer = 0;

  const set = (t) => {
    el.textContent = t;
  };

  const loop = async () => {
    while (!cancelled) {
      const phrase = phrases[pi % phrases.length];
      for (let i = 1; i <= phrase.length && !cancelled; i++) {
        set(phrase.slice(0, i));
        await wait(typeMs);
      }
      await wait(holdMs);
      for (let i = phrase.length; i >= 0 && !cancelled; i--) {
        set(phrase.slice(0, i));
        await wait(deleteMs);
      }
      await wait(200);
      pi += 1;
    }
  };

  function wait(ms) {
    return new Promise((resolve) => {
      timer = window.setTimeout(resolve, ms);
    });
  }

  loop();
  onPageCleanup(() => {
    cancelled = true;
    clearTimeout(timer);
  });
}

function animateCount(el, to, duration = 480) {
  if (!el) return;
  if (prefersReducedMotion()) {
    el.textContent = to.toLocaleString("en-PH");
    return;
  }
  const from = Number(String(el.textContent).replace(/[^\d]/g, "")) || 0;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(from + (to - from) * eased);
    el.textContent = val.toLocaleString("en-PH");
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Scroll / mount reveal. */
function revealIn(root) {
  const nodes = root.querySelectorAll(".ix-reveal");
  if (prefersReducedMotion()) {
    nodes.forEach((n) => n.classList.add("ix-in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const delay = Number(e.target.getAttribute("data-delay") || 0);
          window.setTimeout(() => e.target.classList.add("ix-in"), delay * 70);
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );
  nodes.forEach((n) => io.observe(n));
  // Hero items above fold
  nodes.forEach((n) => {
    if (n.closest(".hero")) {
      const delay = Number(n.getAttribute("data-delay") || 0);
      window.setTimeout(() => n.classList.add("ix-in"), 40 + delay * 80);
    }
  });
  onPageCleanup(() => io.disconnect());
}

function wireDemoVideo(root) {
  const video = root.querySelector(".demo-video");
  if (!video) return;

  const tryPlay = () => {
    video.muted = true;
    const playPromise = video.play();
    if (playPromise?.catch) playPromise.catch(() => {});
  };

  tryPlay();

  const wrap = video.closest(".demo-video-wrap");
  if (!wrap || prefersReducedMotion()) return;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          tryPlay();
          io.unobserve(wrap);
        }
      }
    },
    { threshold: 0.25 },
  );
  io.observe(wrap);
  onPageCleanup(() => io.disconnect());
}

function wireCompare(root) {
  const table = root.querySelector("#compare-table");
  const live = root.querySelector("#compare-live");
  if (!table || !live) return;
  table.querySelectorAll("tbody tr").forEach((tr) => {
    const activate = () => {
      table.querySelectorAll("tr.active").forEach((r) => r.classList.remove("active"));
      tr.classList.add("active");
      typeInto(live, tr.getAttribute("data-line") || "", 16);
    };
    tr.addEventListener("click", activate);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });
}

function wireTrustChips(root) {
  root.querySelectorAll(".trust-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tip = btn.getAttribute("data-tip") || btn.textContent;
      toast(tip);
      btn.classList.add("pulse");
      window.setTimeout(() => btn.classList.remove("pulse"), 400);
    });
  });
}

/** Hero provider chips: stagger in, cycle highlight, pause on hover/focus. */
function wireHeroHeadline(root) {
  const headline = root.querySelector(".ix-hero-headline");
  if (!headline) return;
  const chips = [...headline.querySelectorAll(".ix-model-chip")];
  if (!chips.length) return;

  let activeIndex = 0;
  let paused = false;
  let timer = 0;

  const setActive = (index) => {
    activeIndex = index;
    chips.forEach((chip, i) => chip.classList.toggle("ix-model-active", i === index));
  };

  const schedule = (delay = 2200) => {
    clearTimeout(timer);
    if (paused || prefersReducedMotion()) return;
    timer = window.setTimeout(() => {
      setActive((activeIndex + 1) % chips.length);
      schedule(2200);
    }, delay);
  };

  if (prefersReducedMotion()) {
    setActive(0);
    chips.forEach((chip) => {
      chip.classList.add("ix-model-ready");
    });
    return;
  }

  setActive(0);
  chips.forEach((chip, i) => {
    chip.classList.add("ix-model-ready");
    chip.addEventListener("mouseenter", () => {
      paused = true;
      clearTimeout(timer);
      setActive(i);
    });
    chip.addEventListener("mouseleave", () => {
      paused = false;
      schedule(900);
    });
    chip.addEventListener("focus", () => {
      paused = true;
      clearTimeout(timer);
      setActive(i);
    });
    chip.addEventListener("blur", () => {
      if (!headline.contains(document.activeElement)) {
        paused = false;
        schedule(900);
      }
    });
  });
  schedule(2400);
  onPageCleanup(() => clearTimeout(timer));
}

function wireTypeOnce(root) {
  root.querySelectorAll(".ix-type-once").forEach((el) => {
    const text = el.getAttribute("data-text") || el.textContent || "";
    typeInto(el, text, 20);
  });
}

function initTextInteractions(root) {
  if (!root) return;
  splitWordsIn(root);
  hoverWordsIn(root);
  revealIn(root);
  wireDemoVideo(root);
  wireCompare(root);
  wireTrustChips(root);
  wireHeroHeadline(root);
  wireTypeOnce(root);

  const heroType = root.querySelector("#hero-type");
  if (heroType) {
    const phrases = (heroType.getAttribute("data-phrases") || "GCash")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    rotateType(heroType, phrases);
  }

  // Feature cards: type body on first focus/hover once
  root.querySelectorAll(".ix-card").forEach((card) => {
    const body = card.querySelector(".ix-body, .plan-desc");
    if (!body) return;
    let done = false;
    const kick = () => {
      if (done) return;
      done = true;
      card.classList.add("ix-active");
    };
    card.addEventListener("mouseenter", kick);
    card.addEventListener("focus", kick);
  });
}

async function boot() {
  const y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());

  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    const nav = document.getElementById("nav");
    const open = nav.classList.toggle("open");
    document.getElementById("nav-toggle").setAttribute("aria-expanded", String(open));
  });

  window.addEventListener("hashchange", render);
  rememberDesktopLinkFromUrl();
  if (getSessionToken()) {
    await refreshSessionUser();
  }
  // Already signed in + desktop pairing code in URL/session → jump straight to link flow.
  if (getSessionToken() && pendingDesktopCode() && pathOf() !== "/desktop-linked") {
    const target = `#/login?desktop=1&dcode=${encodeURIComponent(pendingDesktopCode())}`;
    if (location.hash !== target) {
      location.hash = target;
      return; // hashchange → render
    }
  }
  if (!location.hash) location.hash = "#/";
  else render();
}

boot();
