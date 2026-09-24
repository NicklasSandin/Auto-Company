import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTlsResult } from "../src/checks/tls.js";

// computeTlsResult is the pure post-handshake evaluator extracted from
// checkTlsHealth specifically so this logic is testable without spinning up
// a real (or fake) node:tls socket. See src/checks/tls.js for the seam.

function baseCert(overrides = {}) {
  const now = Date.now();
  return {
    subject: { CN: "example.com" },
    issuer: { CN: "Example CA" },
    valid_from: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    valid_to: new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

test("valid, trusted cert with plenty of days left reports healthy status", () => {
  const r = computeTlsResult(baseCert(), "TLSv1.3", true, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.expiringSoon, false);
  assert.equal(r.expired, false);
  assert.equal(r.trusted, true);
  assert.equal(r.trustError, null);
});

test("cert expiring within 30 days is flagged expiringSoon (but not expired)", () => {
  const now = Date.now();
  const cert = baseCert({ valid_to: new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString() });
  const r = computeTlsResult(cert, "TLSv1.3", true, undefined);
  assert.equal(r.expiringSoon, true);
  assert.equal(r.expired, false);
});

test("expired cert (negative daysRemaining) is flagged expired", () => {
  const now = Date.now();
  const cert = baseCert({ valid_to: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString() });
  const r = computeTlsResult(cert, "TLSv1.3", true, undefined);
  assert.equal(r.expired, true);
  assert.ok(r.daysRemaining < 0, `expected negative daysRemaining, got ${r.daysRemaining}`);
});

test("untrusted/self-signed chain reports trusted:false with the socket's trustError", () => {
  const r = computeTlsResult(baseCert(), "TLSv1.3", false, "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.equal(r.trusted, false);
  assert.equal(r.trustError, "DEPTH_ZERO_SELF_SIGNED_CERT");
});

test("untrusted chain with no authorizationError still reports a fallback trustError instead of null", () => {
  const r = computeTlsResult(baseCert(), "TLSv1.3", false, undefined);
  assert.equal(r.trusted, false);
  assert.equal(r.trustError, "unknown");
});

test("outdated protocol (TLSv1.1) is flagged outdatedProtocol", () => {
  const r = computeTlsResult(baseCert(), "TLSv1.1", true, undefined);
  assert.equal(r.outdatedProtocol, true);
});

test("modern protocol (TLSv1.3) is not flagged outdatedProtocol", () => {
  const r = computeTlsResult(baseCert(), "TLSv1.3", true, undefined);
  assert.equal(r.outdatedProtocol, false);
});

test("no certificate returned by peer -> ok:false, not a crash", () => {
  assert.deepEqual(computeTlsResult(null, "TLSv1.3", true, undefined), {
    ok: false,
    error: "no certificate returned by peer",
  });
  assert.deepEqual(computeTlsResult({}, "TLSv1.3", true, undefined), {
    ok: false,
    error: "no certificate returned by peer",
  });
});
