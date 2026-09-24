import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpf, parseDmarc, computeSpoofabilityVerdict } from "../src/checks/email.js";

test("parseSpf: absent record", () => {
  assert.deepEqual(parseSpf(["some other txt record"]), { present: false });
});

test("parseSpf: hardfail -all", () => {
  const r = parseSpf(["v=spf1 include:_spf.example.com -all"]);
  assert.equal(r.present, true);
  assert.equal(r.allQualifier, "-");
  assert.equal(r.envelopePermissive, false);
});

test("parseSpf: softfail ~all is not permissive (fails closed enough to not count as wide open)", () => {
  const r = parseSpf(["v=spf1 include:_spf.example.com ~all"]);
  assert.equal(r.allQualifier, "~");
  assert.equal(r.envelopePermissive, false);
});

test("parseSpf: permissive +all", () => {
  const r = parseSpf(["v=spf1 +all"]);
  assert.equal(r.envelopePermissive, true);
});

test("parseSpf: bare 'all' with no qualifier defaults to pass (permissive)", () => {
  const r = parseSpf(["v=spf1 all"]);
  assert.equal(r.allQualifier, "+");
  assert.equal(r.envelopePermissive, true);
});

test("parseDmarc: absent record", () => {
  assert.deepEqual(parseDmarc([]), { present: false });
});

test("parseDmarc: p=reject, sp defaults to p", () => {
  const r = parseDmarc(["v=DMARC1; p=reject; pct=100"]);
  assert.equal(r.p, "reject");
  assert.equal(r.sp, "reject");
  assert.equal(r.pct, 100);
});

test("parseDmarc: explicit sp overrides default", () => {
  const r = parseDmarc(["v=DMARC1; p=reject; sp=none; pct=100"]);
  assert.equal(r.p, "reject");
  assert.equal(r.sp, "none");
});

test("parseDmarc: p=none, pct missing defaults to 100", () => {
  const r = parseDmarc(["v=DMARC1; p=none"]);
  assert.equal(r.p, "none");
  assert.equal(r.pct, 100);
});

test("verdict: no SPF, no DMARC -> fully spoofable everywhere", () => {
  const v = computeSpoofabilityVerdict({ spf: { present: false }, dmarc: { present: false } });
  assert.equal(v.exactDomainSpoofable, true);
  assert.equal(v.subdomainSpoofable, true);
  assert.equal(v.envelopeSpoofable, true);
});

test("verdict: SPF -all but no DMARC -> header-From still spoofable (the load-bearing case)", () => {
  // This is the specific misconception the email-domain-security skill calls
  // out: a hard SPF fail alone does NOT stop header-From spoofing.
  const v = computeSpoofabilityVerdict({
    spf: { present: true, envelopePermissive: false },
    dmarc: { present: false },
  });
  assert.equal(v.envelopeSpoofable, false);
  assert.equal(v.exactDomainSpoofable, true);
  assert.equal(v.subdomainSpoofable, true);
});

test("verdict: SPF -all + DMARC p=reject sp=reject -> fully protected", () => {
  const v = computeSpoofabilityVerdict({
    spf: { present: true, envelopePermissive: false },
    dmarc: { present: true, p: "reject", sp: "reject", pct: 100 },
  });
  assert.equal(v.envelopeSpoofable, false);
  assert.equal(v.exactDomainSpoofable, false);
  assert.equal(v.subdomainSpoofable, false);
  assert.equal(v.partialEnforcement, false);
});

test("verdict: DMARC p=reject but sp=none -> exact domain protected, subdomains not", () => {
  const v = computeSpoofabilityVerdict({
    spf: { present: true, envelopePermissive: false },
    dmarc: { present: true, p: "reject", sp: "none", pct: 100 },
  });
  assert.equal(v.exactDomainSpoofable, false);
  assert.equal(v.subdomainSpoofable, true);
});

test("verdict: DMARC pct < 100 flagged as partial enforcement", () => {
  const v = computeSpoofabilityVerdict({
    spf: { present: true, envelopePermissive: false },
    dmarc: { present: true, p: "reject", sp: "reject", pct: 50 },
  });
  assert.equal(v.exactDomainSpoofable, false);
  assert.equal(v.partialEnforcement, true);
});

test("verdict: DMARC p=none -> spoofable even though SPF is strict (SPF+all bypasses DMARC misconception guarded against)", () => {
  const v = computeSpoofabilityVerdict({
    spf: { present: true, envelopePermissive: false },
    dmarc: { present: true, p: "none", sp: "none", pct: 100 },
  });
  assert.equal(v.exactDomainSpoofable, true);
});
