// Subdomain / asset exposure baseline via certificate-transparency logs (crt.sh).
//
// What this answers: "what hostnames are publicly attached to my domain that
// I might have forgotten about?" This is asset discovery, not header grading —
// Mozilla HTTP Observatory and SecurityHeaders.com do not do this at all.
//
// Passive, read-only, keyless: a single HTTPS GET against a public log-search
// service. No scanning of the discovered hosts themselves happens here or
// anywhere else in this tool.

// crt.sh is a free public service with no SLA and is frequently slow under
// load (observed 15-20s+ response times) — timeout is generous on purpose
// so a slow-but-working response isn't mistaken for a failure.
const CRTSH_TIMEOUT_MS = 30_000;

// Hostname fragments that suggest an internal/administrative/non-production
// asset was accidentally left publicly resolvable. Not proof of anything —
// just worth a human's attention.
const SUSPICIOUS_PATTERNS = [
  "dev", "staging", "stage", "test", "qa", "uat",
  "admin", "internal", "intranet", "vpn", "backup", "bak",
  "old", "legacy", "tmp", "temp", "debug", "beta",
  "db", "database", "sql", "redis", "mongo",
  "jenkins", "gitlab", "jira", "confluence", "grafana", "kibana",
];

// crt.sh is known to be flaky under real-world conditions (connection
// timeouts, slow responses, occasional HTML-error-page-instead-of-JSON
// under load) independent of anything on our end. A couple of retries with
// backoff turns a transient hiccup into a working scan instead of a false
// "check failed".
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [2_000, 5_000];

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer, promise: promise(controller.signal).finally(() => clearTimeout(timer)) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCrtSh(url) {
  const { promise } = withTimeout(
    (signal) => fetch(url, { signal, headers: { "User-Agent": "perimeterlens (self-scan CLI; https://github.com/NicklasSandin/perimeterlens)" } }),
    CRTSH_TIMEOUT_MS
  );
  return promise;
}

/**
 * Query crt.sh for all certificates ever logged for `%.<domain>` and `<domain>`,
 * and return the deduped set of hostnames observed.
 *
 * @param {string} domain
 * @returns {Promise<{ok: true, hostnames: string[], suspicious: string[]} | {ok: false, error: string}>}
 */
export async function checkSubdomainExposure(domain) {
  const url = `https://crt.sh/?q=${encodeURIComponent("%." + domain)}&output=json`;

  let res;
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetchCrtSh(url);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err.name === "AbortError" ? "timed out" : err.message;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS[attempt]);
    }
  }
  if (lastError) {
    return { ok: false, error: `crt.sh request failed after ${MAX_ATTEMPTS} attempts: ${lastError} (crt.sh is a free service with no uptime guarantee — this may just mean it's temporarily unavailable, not a problem with your domain)` };
  }

  if (!res.ok) {
    return { ok: false, error: `crt.sh returned HTTP ${res.status}` };
  }

  let rows;
  try {
    const text = await res.text();
    // crt.sh occasionally returns an empty body (no certs found) or, under
    // load, an HTML error page instead of JSON — treat both as "no data",
    // not a crash.
    rows = text.trim() ? JSON.parse(text) : [];
  } catch {
    return { ok: false, error: "crt.sh returned a non-JSON response (likely rate-limited or under load) — try again later" };
  }

  const rootLower = domain.toLowerCase();
  const hostnames = new Set();

  for (const row of rows) {
    const raw = row.name_value || "";
    for (const name of raw.split("\n")) {
      const h = name.trim().toLowerCase().replace(/^\*\./, "");
      if (!h) continue;
      if (h === rootLower || h.endsWith("." + rootLower)) {
        hostnames.add(h);
      }
    }
  }

  const sorted = [...hostnames].sort();
  const suspicious = sorted.filter((h) => {
    const label = h.slice(0, h.length - rootLower.length); // the part before the root domain
    return SUSPICIOUS_PATTERNS.some((pat) => label.includes(pat));
  });

  return { ok: true, hostnames: sorted, suspicious };
}
