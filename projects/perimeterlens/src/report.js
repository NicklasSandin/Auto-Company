// Renders the scan results as a markdown report (stdout by default, or a
// file via --out). No HTML, no external template engine — plain string
// building, consistent with the zero-dependency posture of the whole tool.

function yn(b) {
  return b ? "YES" : "no";
}

function fmtList(items, empty = "(none observed)") {
  if (!items || items.length === 0) return empty;
  return items.map((i) => `- \`${i}\``).join("\n");
}

export function renderReport(domain, { subdomains, email, tls, score }) {
  const lines = [];

  lines.push(`# perimeterlens report: ${domain}`);
  lines.push("");
  lines.push(`**Composite score:** ${score.composite === null ? "N/A" : score.composite}/100 (**${score.grade}**)`);
  lines.push(`_Based on: ${score.checksIncluded.join(", ") || "no checks completed"}. Passive, self-target checks only — see README for full scope and non-goals._`);
  lines.push("");

  // --- Subdomain exposure ---
  lines.push("## 1. Subdomain / asset exposure (certificate-transparency log baseline)");
  if (!subdomains.ok) {
    lines.push(`Could not complete: ${subdomains.error}`);
  } else {
    lines.push(`Observed **${subdomains.hostnames.length}** distinct hostname(s) in public CT logs for this domain.`);
    lines.push("");
    if (subdomains.suspicious.length > 0) {
      lines.push(`**${subdomains.suspicious.length} hostname(s) matched internal/non-production naming patterns** — worth checking these are meant to be public:`);
      lines.push(fmtList(subdomains.suspicious));
    } else {
      lines.push("No hostnames matched internal/non-production naming patterns.");
    }
    lines.push("");
    lines.push(`<details><summary>All ${subdomains.hostnames.length} observed hostname(s)</summary>\n\n${fmtList(subdomains.hostnames)}\n\n</details>`);
  }
  lines.push("");

  // --- Email spoofability ---
  lines.push("## 2. Email spoofability");
  const v = email.verdict;
  lines.push(`- **Exact-domain header-From spoofable:** ${yn(v.exactDomainSpoofable)}${v.exactDomainSpoofable ? " — an attacker can plausibly forge \"From: you@" + domain + "\" and have it delivered without your DMARC policy stopping it." : " — DMARC is present and enforcing (p=" + email.dmarc.p + ")."}`);
  lines.push(`- **Subdomain header-From spoofable:** ${yn(v.subdomainSpoofable)}`);
  lines.push(`- **Envelope (bounce address) spoofable:** ${yn(v.envelopeSpoofable)}${email.spf.present ? "" : " — no SPF record found."}`);
  if (v.partialEnforcement) lines.push(`- **Note:** DMARC enforcement is partial (pct=${email.dmarc.pct}) — only a fraction of failing mail is acted on.`);
  lines.push(`- SPF record: ${email.spf.present ? "present" : "**missing**"}`);
  lines.push(`- DMARC record: ${email.dmarc.present ? `present (p=${email.dmarc.p}, sp=${email.dmarc.sp}, pct=${email.dmarc.pct})` : "**missing**"}`);
  lines.push(`- DKIM: ${
    email.dkimSelectorFound
      ? email.dkimRevoked
        ? `selector \`${email.dkimSelectorFound}\` found but its key is **revoked/empty** (\`p=\` is blank, per RFC 6376) — treated as not effectively configured`
        : `selector \`${email.dkimSelectorFound}\` found (best-effort probe — absence elsewhere does not mean DKIM is unconfigured)`
      : "no record found under common selector names (best-effort probe only — not conclusive)"
  }`);
  lines.push(`- BIMI: ${email.bimiPresent ? "present" : "not found"}`);
  lines.push(`- MTA-STS: ${email.mtaStsPresent ? "present" : "not found"}`);
  lines.push(`- DNSSEC: ${v.dnssec}`);
  lines.push("");

  // --- TLS ---
  lines.push("## 3. TLS certificate health");
  if (!tls.ok) {
    lines.push(`Could not complete: ${tls.error} (this may simply mean the domain doesn't serve HTTPS on port 443 — not necessarily a problem.)`);
  } else {
    lines.push(`- Subject: \`${tls.subject ?? "unknown"}\`, Issuer: \`${tls.issuer ?? "unknown"}\``);
    lines.push(`- Valid: ${tls.validFrom} → ${tls.validTo}`);
    lines.push(`- Days remaining: **${tls.daysRemaining}**${tls.expired ? " — **EXPIRED**" : tls.expiringSoon ? " — expiring soon" : ""}`);
    lines.push(`- Chain trusted (system CA store): ${yn(tls.trusted)}${tls.trusted ? "" : ` (${tls.trustError})`}`);
    lines.push(`- Protocol negotiated: ${tls.protocol}${tls.outdatedProtocol ? " — **outdated, should be retired**" : ""}`);
  }
  lines.push("");

  lines.push("---");
  lines.push("_perimeterlens does not check HTTP security headers — use [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory) or [SecurityHeaders.com](https://securityheaders.com) for that. This tool covers what those don't: subdomain exposure, email spoofability, and TLS certificate health._");
  lines.push("_Only ever run this against a domain you own or are already authorized to test._");

  return lines.join("\n") + "\n";
}

export function renderJson(domain, results) {
  return JSON.stringify({ domain, ...results }, null, 2) + "\n";
}
