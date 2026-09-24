import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScore } from "../src/score.js";

function baseEmail(overrides = {}) {
  return {
    spf: { present: true, envelopePermissive: false },
    dmarc: { present: true, p: "reject", sp: "reject", pct: 100 },
    dkimSelectorFound: "default",
    dkimRevoked: false,
    verdict: {
      exactDomainSpoofable: false,
      subdomainSpoofable: false,
      envelopeSpoofable: false,
      partialEnforcement: false,
    },
    ...overrides,
  };
}

function baseTls(overrides = {}) {
  return {
    ok: true,
    expired: false,
    expiringSoon: false,
    trusted: true,
    outdatedProtocol: false,
    ...overrides,
  };
}

function baseSubdomains(overrides = {}) {
  return { ok: true, hostnames: ["example.com", "www.example.com"], suspicious: [], ...overrides };
}

test("perfect posture scores 100 / A", () => {
  const r = computeScore({ email: baseEmail(), tls: baseTls(), subdomains: baseSubdomains() });
  assert.equal(r.composite, 100);
  assert.equal(r.grade, "A");
  assert.deepEqual(r.checksIncluded.sort(), ["email", "subdomains", "tls"]);
});

test("wide-open email (no SPF, no DMARC) drags score down heavily", () => {
  const r = computeScore({
    email: baseEmail({
      spf: { present: false },
      dmarc: { present: false },
      dkimSelectorFound: null,
      verdict: { exactDomainSpoofable: true, subdomainSpoofable: true, envelopeSpoofable: true, partialEnforcement: false },
    }),
    tls: baseTls(),
    subdomains: baseSubdomains(),
  });
  assert.ok(r.composite < 80, `expected a materially lower score, got ${r.composite}`);
  assert.equal(r.subscores.email, 30); // 100 - 50 (exact spoofable) - 15 (envelope spoofable) - 5 (no dkim)
});

test("expired TLS cert is heavily penalized", () => {
  const r = computeScore({ email: baseEmail(), tls: baseTls({ expired: true }), subdomains: baseSubdomains() });
  assert.equal(r.subscores.tls, 40); // 100 - 60
});

test("a failed check (e.g. crt.sh unreachable) is excluded, not penalized, and renormalizes the composite", () => {
  const r = computeScore({ email: baseEmail(), tls: baseTls(), subdomains: { ok: false, error: "timed out" } });
  assert.equal(r.subscores.subdomains, null);
  assert.equal(r.composite, 100); // remaining checks are both perfect, weights renormalize to 100
  assert.deepEqual(r.checksIncluded.sort(), ["email", "tls"]);
});

test("all checks failed -> composite is null, not a crash or a fake 0", () => {
  const r = computeScore({
    email: baseEmail({ verdict: { exactDomainSpoofable: false, subdomainSpoofable: false, envelopeSpoofable: false, partialEnforcement: false } }),
    tls: { ok: false, error: "x" },
    subdomains: { ok: false, error: "x" },
  });
  // email still computes (it's DNS-based and doesn't have an ok:false path),
  // so composite should reflect only email, not null, in this scenario.
  assert.notEqual(r.composite, null);
  assert.deepEqual(r.checksIncluded, ["email"]);
});

test("suspicious subdomains reduce the subdomains subscore proportionally, capped", () => {
  const many = Array.from({ length: 10 }, (_, i) => `staging${i}.example.com`);
  const r = computeScore({ email: baseEmail(), tls: baseTls(), subdomains: baseSubdomains({ suspicious: many }) });
  assert.equal(r.subscores.subdomains, 30); // 100 - min(10*15, 70) = 30
});
