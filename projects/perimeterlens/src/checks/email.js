// Email spoofability composite verdict.
//
// What this answers, in plain English: "can someone send email that looks
// like it's from me, and land it in an inbox?" — not a raw SPF/DMARC record
// dump. Neither Mozilla HTTP Observatory nor SecurityHeaders.com touch DNS
// or email authentication at all; this is genuinely new ground for a free,
// zero-signup tool.
//
// The load-bearing distinction (see .claude/skills/email-domain-security):
// SPF authenticates the *envelope* MAIL FROM (the invisible bounce address).
// DMARC is what governs the *visible* header From: that a human actually
// reads. SPF alone, even with "-all" (hardfail), does NOT make a domain
// spoof-proof — an attacker can pass SPF on a completely different envelope
// domain while forging the visible From, and nothing stops that unless
// DMARC is present *and* enforcing (p=quarantine or p=reject).
//
// DNSSEC is intentionally NOT claimed as "checked" here: Node's built-in
// `dns` module wraps a non-validating stub resolver and cannot verify DS/
// RRSIG chains. Claiming a DNSSEC check without real validation would be
// exactly the kind of overclaim this project committed not to make, so it's
// reported as "not checked" rather than faked.

import { resolveTxt } from "node:dns/promises";

const COMMON_DKIM_SELECTORS = ["default", "google", "selector1", "selector2", "k1", "mail", "dkim", "s1", "s2"];

async function txtRecords(name) {
  try {
    const rows = await resolveTxt(name);
    return rows.map((parts) => parts.join(""));
  } catch (err) {
    if (err.code === "ENODATA" || err.code === "ENOTFOUND") return [];
    throw err;
  }
}

export function parseSpf(records) {
  const spf = records.find((r) => r.toLowerCase().startsWith("v=spf1"));
  if (!spf) return { present: false };

  // Find the qualifier on the "all" mechanism, which governs the fallback
  // for the envelope-From. Default qualifier (no symbol) is "+" (pass).
  const match = spf.match(/([+\-~?]?)all\b/i);
  const qualifier = match ? (match[1] || "+") : null;
  const envelopePermissive = qualifier === "+" || qualifier === "?" || qualifier === null;

  return { present: true, record: spf, allQualifier: qualifier, envelopePermissive };
}

export function parseDmarc(records) {
  const dmarc = records.find((r) => r.toLowerCase().startsWith("v=dmarc1"));
  if (!dmarc) return { present: false };

  const tags = Object.fromEntries(
    dmarc.split(";").map((t) => t.trim()).filter(Boolean).map((t) => {
      const idx = t.indexOf("=");
      return idx === -1 ? [t, ""] : [t.slice(0, idx).trim().toLowerCase(), t.slice(idx + 1).trim()];
    })
  );

  const p = (tags.p || "none").toLowerCase();
  const sp = (tags.sp || p).toLowerCase(); // subdomain policy defaults to p per RFC 7489
  const pct = tags.pct !== undefined ? Number(tags.pct) : 100;

  return { present: true, record: dmarc, p, sp, pct: Number.isFinite(pct) ? pct : 100 };
}

/**
 * @param {string} domain
 * @returns {Promise<object>} composite email-spoofability report
 */
export async function checkEmailSpoofability(domain) {
  const [rootTxt, dmarcTxt, bimiTxt, mtaStsTxt] = await Promise.all([
    txtRecords(domain),
    txtRecords(`_dmarc.${domain}`),
    txtRecords(`default._bimi.${domain}`),
    txtRecords(`_mta-sts.${domain}`),
  ]);

  const spf = parseSpf(rootTxt);
  const dmarc = parseDmarc(dmarcTxt);
  const bimiPresent = bimiTxt.some((r) => r.toLowerCase().startsWith("v=bimi1"));
  const mtaStsPresent = mtaStsTxt.some((r) => r.toLowerCase().startsWith("v=stsv1"));

  // Best-effort DKIM: try a short, common selector list. Absence of a hit
  // does NOT mean DKIM isn't configured — most selectors are org-specific
  // and unguessable. This is a weak positive-only signal, reported as such.
  let dkimSelectorFound = null;
  let dkimRevoked = false;
  for (const selector of COMMON_DKIM_SELECTORS) {
    const rows = await txtRecords(`${selector}._domainkey.${domain}`);
    const hit = rows.find((r) => /v=dkim1/i.test(r) || /(^|;)\s*p=/i.test(r));
    if (hit) {
      dkimSelectorFound = selector;
      // An explicit empty p= tag is how a DKIM key is intentionally
      // revoked per RFC 6376 §3.6.1 — worth surfacing, not just "found".
      dkimRevoked = /p=\s*(;|$)/i.test(hit);
      break;
    }
  }

  return {
    spf,
    dmarc,
    bimiPresent,
    mtaStsPresent,
    dkimSelectorFound,
    dkimRevoked,
    verdict: computeSpoofabilityVerdict({ spf, dmarc }),
  };
}

/**
 * Pure composite-verdict logic, factored out of the DNS-fetching orchestrator
 * above so it's directly unit-testable without a network call.
 *
 * @param {{spf: ReturnType<typeof parseSpf>, dmarc: ReturnType<typeof parseDmarc>}} parsed
 */
export function computeSpoofabilityVerdict({ spf, dmarc }) {
  // Exact-domain header-From spoofing succeeds unless DMARC exists AND enforces.
  const exactDomainSpoofable = !dmarc.present || dmarc.p === "none";
  // Subdomains inherit `p` unless `sp` overrides — so subdomain spoofing
  // succeeds under the same condition, evaluated against `sp`.
  const subdomainSpoofable = !dmarc.present || dmarc.sp === "none";
  const partialEnforcement = dmarc.present && dmarc.pct < 100 && !exactDomainSpoofable;
  const envelopeSpoofable = !spf.present || spf.envelopePermissive;

  return {
    exactDomainSpoofable,
    subdomainSpoofable,
    envelopeSpoofable,
    partialEnforcement,
    dnssec: "not checked — requires a DNSSEC-validating resolver, out of scope for a zero-dependency Node built-in client",
  };
}
