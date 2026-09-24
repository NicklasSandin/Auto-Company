// Composite 0-100 score + letter grade across the three v1 dimensions.
//
// Deliberately NOT a dollar-loss (FAIR) estimate — that needs business-
// context inputs (record counts, industry, asset criticality) a one-command
// self-scan cannot infer without turning this into a questionnaire. See
// docs/ceo/cycle-github-only-decision.md §3 for why that's cut from v1
// rather than promised for a later version.

const WEIGHTS = { email: 0.4, tls: 0.3, subdomains: 0.3 };
const GRADE_BANDS = [
  [90, "A"],
  [80, "B"],
  [70, "C"],
  [60, "D"],
  [0, "F"],
];

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function scoreEmail(email) {
  let s = 100;
  const v = email.verdict;
  if (v.exactDomainSpoofable) s -= 50;
  else if (v.subdomainSpoofable) s -= 20;
  if (v.envelopeSpoofable) s -= 15;
  if (v.partialEnforcement) s -= 10;
  if (!email.dkimSelectorFound || email.dkimRevoked) s -= 5;
  return clamp(s, 0, 100);
}

function scoreTls(tls) {
  if (!tls.ok) return null; // unverifiable (e.g. no HTTPS on 443) — excluded, not penalized
  let s = 100;
  if (tls.expired) s -= 60;
  else if (tls.expiringSoon) s -= 25;
  if (!tls.trusted) s -= 30;
  if (tls.outdatedProtocol) s -= 20;
  return clamp(s, 0, 100);
}

function scoreSubdomains(sub) {
  if (!sub.ok) return null; // crt.sh unreachable — excluded, not penalized
  const hits = sub.suspicious.length;
  return clamp(100 - Math.min(hits * 15, 70), 0, 100);
}

function gradeFor(score) {
  for (const [threshold, letter] of GRADE_BANDS) {
    if (score >= threshold) return letter;
  }
  return "F";
}

/**
 * @param {{email: object, tls: object, subdomains: object}} results
 */
export function computeScore({ email, tls, subdomains }) {
  const subs = {
    email: scoreEmail(email),
    tls: scoreTls(tls),
    subdomains: scoreSubdomains(subdomains),
  };

  let weightedSum = 0;
  let weightTotal = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const s = subs[key];
    if (s === null) continue; // renormalize over available checks only
    weightedSum += s * weight;
    weightTotal += weight;
  }

  const composite = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;

  return {
    subscores: subs,
    composite,
    grade: composite === null ? "N/A" : gradeFor(composite),
    checksIncluded: Object.entries(subs).filter(([, v]) => v !== null).map(([k]) => k),
  };
}
