# perimeterlens

A free, open-source, **zero-dependency** command-line tool that gives you a
single passive exposure read on your own domain:

- **Forgotten subdomains** — what hostnames are publicly attached to your
  domain according to certificate-transparency logs, flagged for anything
  that looks internal/non-production and probably shouldn't be public.
- **Email spoofability** — a plain-English verdict on whether someone can
  send mail that looks like it's from you (SPF, DMARC, DKIM, BIMI, MTA-STS).
- **TLS certificate health** — expiry, chain trust, and protocol version for
  your HTTPS endpoint.

One composite 0–100 score and letter grade, computed locally, printed to
your terminal. No signup, no account, no data sent anywhere except the two
lookups the tool exists to make (a certificate-transparency log search, and
a DNS/TLS query against the domain you give it).

## What this is *not*

- **Not a header grader.** [Mozilla HTTP
  Observatory](https://developer.mozilla.org/en-US/observatory) and
  [SecurityHeaders.com](https://securityheaders.com) already do free,
  instant, zero-install HTTP security-header grading, and do it well. This
  tool deliberately does not duplicate that — it covers the three things
  those tools don't touch at all (subdomain discovery, email
  authentication, certificate lifecycle). Use both together.
- **Not a dollar-loss / risk-quantification tool.** A one-command self-scan
  can't responsibly infer business context (record counts, industry,
  asset criticality) needed for that. Out of scope by design, not a
  "coming soon."
- **Not an active scanner.** No port scanning, no directory brute-forcing,
  no exploitation, nothing beyond passive DNS/CT-log/TLS-handshake lookups
  — the same category of interaction that happens automatically every time
  a browser loads the page.
- **Not a monitoring service (yet).** This is a one-shot CLI you run
  yourself. See [Continuous
  monitoring](#continuous-monitoring-interest) below if you'd want that.

## Only scan domains you own or are already authorized to test

Same discipline as `nmap`, `subfinder`, or `testssl.sh`. This tool only ever
looks at the one domain you pass it, and only performs passive, read-only
lookups. That's what makes running it against your own domain not require
anyone's permission but yours — don't point it at someone else's.

## Install & run

No `npm install` step needed for the checks themselves — this tool has
**zero runtime dependencies**. Clone and run directly with Node.js 18+:

```bash
git clone https://github.com/NicklasSandin/perimeterlens.git
cd perimeterlens
node bin/perimeterlens.js yourdomain.com
```

Or via the npm script:

```bash
npm run scan -- yourdomain.com
```

### Options

```
perimeterlens <domain> [options]

  --json          Output raw JSON instead of a markdown report
  --out <file>    Write the report to a file instead of stdout
  -h, --help      Show help
  -v, --version   Show version
```

### Example

```bash
$ node bin/perimeterlens.js example.com
perimeterlens: scanning example.com
Passive, read-only checks only. Only run this against a domain you own or are already authorized to test.

# perimeterlens report: example.com

**Composite score:** 78/100 (**C**)
...
```

## Why this exists, honestly

This is a new, small project from a small team. We're not asking you to
trust it on reputation — we don't have one yet. We're asking you to read
it: the entire tool is plain Node.js built-ins (`https`/`fetch`,
`dns/promises`, `tls`), no dependencies, no build step, no `postinstall`
script, nothing hidden. You can read the whole thing in one sitting in
`src/`. It never phones home beyond the crt.sh lookup and the DNS/TLS
queries against the domain you give it — no telemetry, no analytics, no
tracking.

This project reuses (and is a smaller, free sibling of) scoring methodology
originally developed for ExposureIQ, a separate, paid product for a
different buyer. **It does not replace ExposureIQ** and is not a lead funnel
dressed up as an OSS release — see
[`docs/ceo/cycle-github-only-decision.md`](../../docs/ceo/cycle-github-only-decision.md)
in the parent repo for the full reasoning, including what was deliberately
cut from v1 and why.

## Continuous monitoring interest

There's no scheduled/monitoring product today. If you'd want a periodic
re-scan of your domain with alerting on changes, [open an
issue](../../issues/new?template=monitoring-interest.md) using the
`monitor: yourdomain.com` template. This is a genuine, zero-backend way for
us to gauge real interest before building anything — opening the issue
provisions nothing and implies no charge.

## Roadmap (not committed, not this release)

- Precompiled cross-platform binaries via GitHub Releases (no Node install
  required).
- A GitHub Action wrapper so a repo can re-run its own exposure check on a
  schedule, using GitHub's free Actions compute.

## Kill criterion

This project has a hard 2-cycle-post-launch checkpoint: if there's near-zero
organic signal (stars/issues/mentions from people who aren't the team), the
honest call is to say so and stop investing further, not to quietly keep
polishing it.

## License

MIT — see [LICENSE](LICENSE).
