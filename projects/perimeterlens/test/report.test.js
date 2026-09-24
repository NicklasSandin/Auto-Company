import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, renderJson } from "../src/report.js";

// renderReport/renderJson are pure string-builders over the result shape
// produced by src/checks/*.js + src/score.js — no I/O, fully deterministic.
// Fixtures follow the same base-object-with-overrides convention as
// test/score.test.js and test/tls.test.js.

function baseSubdomains(overrides = {}) {
  return {
    ok: true,
    hostnames: ["example.com", "www.example.com"],
    suspicious: [],
    ...overrides,
  };
}

function baseEmail(overrides = {}) {
  return {
    spf: { present: true, envelopePermissive: false },
    dmarc: { present: true, p: "reject", sp: "reject", pct: 100 },
    dkimSelectorFound: "default",
    dkimRevoked: false,
    bimiPresent: true,
    mtaStsPresent: true,
    verdict: {
      exactDomainSpoofable: false,
      subdomainSpoofable: false,
      envelopeSpoofable: false,
      partialEnforcement: false,
      dnssec: "not checked",
    },
    ...overrides,
  };
}

function baseTls(overrides = {}) {
  return {
    ok: true,
    subject: "example.com",
    issuer: "Example CA",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-12-01T00:00:00.000Z",
    daysRemaining: 90,
    expired: false,
    expiringSoon: false,
    trusted: true,
    trustError: null,
    protocol: "TLSv1.3",
    outdatedProtocol: false,
    ...overrides,
  };
}

function baseScore(overrides = {}) {
  return {
    composite: 100,
    grade: "A",
    checksIncluded: ["email", "tls", "subdomains"],
    ...overrides,
  };
}

function baseResults(overrides = {}) {
  return {
    subdomains: baseSubdomains(),
    email: baseEmail(),
    tls: baseTls(),
    score: baseScore(),
    ...overrides,
  };
}

test("everything present and healthy renders all three sections with no error paths", () => {
  const out = renderReport("example.com", baseResults());
  assert.match(out, /# perimeterlens report: example\.com/);
  assert.match(out, /\*\*Composite score:\*\* 100\/100 \(\*\*A\*\*\)/);
  assert.match(out, /Based on: email, tls, subdomains\./);
  assert.match(out, /## 1\. Subdomain \/ asset exposure/);
  assert.match(out, /Observed \*\*2\*\* distinct hostname\(s\)/);
  assert.match(out, /No hostnames matched internal\/non-production naming patterns\./);
  assert.match(out, /## 2\. Email spoofability/);
  assert.match(out, /## 3\. TLS certificate health/);
  assert.doesNotMatch(out, /Could not complete/);
});

test("suspicious subdomains are called out and listed", () => {
  const out = renderReport("example.com", baseResults({
    subdomains: baseSubdomains({
      hostnames: ["example.com", "staging.example.com", "old-vpn.example.com"],
      suspicious: ["staging.example.com", "old-vpn.example.com"],
    }),
  }));
  assert.match(out, /\*\*2 hostname\(s\) matched internal\/non-production naming patterns\*\*/);
  assert.match(out, /- `staging\.example\.com`/);
  assert.match(out, /- `old-vpn\.example\.com`/);
});

test("subdomains.ok false renders the error path and skips hostname listing entirely", () => {
  const out = renderReport("example.com", baseResults({
    subdomains: { ok: false, error: "crt.sh request timed out" },
  }));
  assert.match(out, /Could not complete: crt\.sh request timed out/);
  assert.doesNotMatch(out, /Observed \*\*/);
  assert.doesNotMatch(out, /All \d+ observed hostname/);
});

test("tls.ok false renders the error path and skips certificate details entirely", () => {
  const out = renderReport("example.com", baseResults({
    tls: { ok: false, error: "TLS handshake timed out" },
  }));
  assert.match(out, /Could not complete: TLS handshake timed out \(this may simply mean/);
  assert.doesNotMatch(out, /Days remaining/);
  assert.doesNotMatch(out, /Chain trusted/);
});

test("expired TLS cert is flagged EXPIRED", () => {
  const out = renderReport("example.com", baseResults({
    tls: baseTls({ expired: true, daysRemaining: -5 }),
  }));
  assert.match(out, /\*\*-5\*\* — \*\*EXPIRED\*\*/);
});

test("cert expiring soon (but not expired) is flagged separately from EXPIRED", () => {
  const out = renderReport("example.com", baseResults({
    tls: baseTls({ expiringSoon: true, daysRemaining: 10 }),
  }));
  assert.match(out, /\*\*10\*\* — expiring soon/);
  assert.doesNotMatch(out, /EXPIRED/);
});

test("untrusted TLS chain surfaces the trust error instead of a bare 'no'", () => {
  const out = renderReport("example.com", baseResults({
    tls: baseTls({ trusted: false, trustError: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
  }));
  assert.match(out, /Chain trusted \(system CA store\): no \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
});

test("outdated TLS protocol is flagged", () => {
  const out = renderReport("example.com", baseResults({
    tls: baseTls({ protocol: "TLSv1.1", outdatedProtocol: true }),
  }));
  assert.match(out, /TLSv1\.1 — \*\*outdated, should be retired\*\*/);
});

test("exact-domain spoofable email verdict warns that header-From can be forged", () => {
  const out = renderReport("example.com", baseResults({
    email: baseEmail({
      spf: { present: false },
      dmarc: { present: false },
      verdict: {
        exactDomainSpoofable: true,
        subdomainSpoofable: true,
        envelopeSpoofable: true,
        partialEnforcement: false,
        dnssec: "not checked",
      },
    }),
  }));
  assert.match(out, /\*\*Exact-domain header-From spoofable:\*\* YES/);
  assert.match(out, /an attacker can plausibly forge "From: you@example\.com"/);
  assert.match(out, /SPF record: \*\*missing\*\*/);
  assert.match(out, /DMARC record: \*\*missing\*\*/);
});

test("non-spoofable email verdict (DMARC enforcing) shows the enforcing message, not the forgery warning", () => {
  const out = renderReport("example.com", baseResults());
  assert.match(out, /\*\*Exact-domain header-From spoofable:\*\* no — DMARC is present and enforcing \(p=reject\)\./);
  assert.doesNotMatch(out, /can plausibly forge/);
});

test("partial DMARC enforcement is called out with its pct value", () => {
  const out = renderReport("example.com", baseResults({
    email: baseEmail({
      dmarc: { present: true, p: "reject", sp: "reject", pct: 50 },
      verdict: {
        exactDomainSpoofable: false,
        subdomainSpoofable: false,
        envelopeSpoofable: false,
        partialEnforcement: true,
        dnssec: "not checked",
      },
    }),
  }));
  assert.match(out, /DMARC enforcement is partial \(pct=50\)/);
});

test("DKIM revoked selector is flagged distinctly from a found, valid selector", () => {
  const out = renderReport("example.com", baseResults({
    email: baseEmail({ dkimSelectorFound: "google", dkimRevoked: true }),
  }));
  assert.match(out, /selector `google` found but its key is \*\*revoked\/empty\*\*/);
});

test("DKIM found and not revoked renders the best-effort-probe note, not the revoked message", () => {
  const out = renderReport("example.com", baseResults({
    email: baseEmail({ dkimSelectorFound: "google", dkimRevoked: false }),
  }));
  assert.match(out, /selector `google` found \(best-effort probe/);
  assert.doesNotMatch(out, /revoked\/empty/);
});

test("DKIM not found at all renders the best-effort disclaimer, not a selector name", () => {
  const out = renderReport("example.com", baseResults({
    email: baseEmail({ dkimSelectorFound: null, dkimRevoked: false }),
  }));
  assert.match(out, /no record found under common selector names \(best-effort probe only — not conclusive\)/);
});

test("composite score of null renders as N/A instead of a numeric score or a crash", () => {
  const out = renderReport("example.com", baseResults({
    score: { composite: null, grade: "N/A", checksIncluded: [] },
  }));
  assert.match(out, /\*\*Composite score:\*\* N\/A\/100 \(\*\*N\/A\*\*\)/);
  assert.match(out, /Based on: no checks completed\./);
});

test("renderJson faithfully round-trips the domain and full results structure", () => {
  const results = baseResults();
  const out = renderJson("example.com", results);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, { domain: "example.com", ...results });
});
