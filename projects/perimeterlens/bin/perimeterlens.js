#!/usr/bin/env node
// perimeterlens — a free, open-source, zero-dependency CLI that gives you a
// single passive exposure read on your own domain.
//
// Usage:
//   perimeterlens <domain> [--json] [--out <file>]
//
// Scope (v1): certificate-transparency subdomain baseline, email
// spoofability (SPF/DMARC/DKIM/BIMI/MTA-STS), TLS certificate health.
// Does NOT check HTTP security headers — use Mozilla HTTP Observatory or
// SecurityHeaders.com for that; this tool covers what those don't.
//
// This tool only performs passive, read-only lookups (a DNS query, a
// certificate-transparency log search, a single TLS handshake) against the
// domain you pass it. Only ever run it against a domain you own or are
// already authorized to test — the same discipline as `nmap`/`subfinder`.

import { writeFile } from "node:fs/promises";
import { checkSubdomainExposure } from "../src/checks/subdomains.js";
import { checkEmailSpoofability } from "../src/checks/email.js";
import { checkTlsHealth } from "../src/checks/tls.js";
import { computeScore } from "../src/score.js";
import { renderReport, renderJson } from "../src/report.js";

const HELP = `perimeterlens <domain> [options]

A free, open-source, zero-dependency CLI: one passive exposure read on your
own domain — forgotten subdomains (certificate-transparency), email
spoofability (SPF/DMARC/DKIM/BIMI/MTA-STS), and TLS certificate health.

Does NOT check HTTP security headers. Use Mozilla HTTP Observatory
(https://developer.mozilla.org/en-US/observatory) or SecurityHeaders.com
for that — this tool deliberately covers what those don't.

Only ever run this against a domain you own or are already authorized to
test. This tool performs passive, read-only lookups only: no port scanning,
no directory brute-forcing, no active probing beyond a DNS query, a public
certificate-transparency log search, and a single TLS handshake on 443.

Options:
  --json          Output raw JSON instead of a markdown report
  --out <file>    Write the report to a file instead of stdout
  -h, --help      Show this help
  -v, --version   Show version
`;

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

function parseArgs(argv) {
  const args = { domain: null, json: false, out: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (!args.domain && !a.startsWith("-")) args.domain = a;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.version) {
    const pkg = await import("../package.json", { with: { type: "json" } });
    console.log(pkg.default.version);
    process.exit(0);
  }

  if (!args.domain) {
    console.error("Missing required argument: <domain>\n");
    console.error(HELP);
    process.exit(1);
  }

  const domain = args.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (!DOMAIN_RE.test(domain)) {
    console.error(`"${args.domain}" doesn't look like a valid domain (expected e.g. "example.com").`);
    process.exit(1);
  }

  console.error(`perimeterlens: scanning ${domain}`);
  console.error("Passive, read-only checks only. Only run this against a domain you own or are already authorized to test.\n");

  const [subdomains, email, tls] = await Promise.all([
    checkSubdomainExposure(domain).catch((err) => ({ ok: false, error: err.message })),
    checkEmailSpoofability(domain).catch((err) => ({
      spf: { present: false }, dmarc: { present: false }, bimiPresent: false, mtaStsPresent: false,
      dkimSelectorFound: null,
      verdict: { exactDomainSpoofable: true, subdomainSpoofable: true, envelopeSpoofable: true, partialEnforcement: false, dnssec: `check failed: ${err.message}` },
    })),
    checkTlsHealth(domain).catch((err) => ({ ok: false, error: err.message })),
  ]);

  const score = computeScore({ email, tls, subdomains });
  const results = { subdomains, email, tls, score };

  const output = args.json ? renderJson(domain, results) : renderReport(domain, results);

  if (args.out) {
    await writeFile(args.out, output, "utf8");
    console.error(`Report written to ${args.out}`);
  } else {
    process.stdout.write(output);
  }
}

main().catch((err) => {
  console.error(`perimeterlens: fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
