// CLI argument parsing and domain normalization/validation.
//
// Pure, zero-I/O logic extracted from bin/perimeterlens.js so it's unit
// testable without spawning a subprocess. parseArgs throws a plain Error on
// an unknown argument rather than calling process.exit itself — the CLI
// entrypoint is responsible for turning that into an exit code, exactly as
// it already does for every other error path in main().

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/**
 * @param {string[]} argv
 * @returns {{domain: string|null, json: boolean, out: string|null, help: boolean, version: boolean}}
 */
export function parseArgs(argv) {
  const args = { domain: null, json: false, out: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (!args.domain && !a.startsWith("-")) args.domain = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/**
 * Lowercases, strips a leading http(s):// scheme and any trailing path, and
 * validates the result as a domain name.
 *
 * @param {string} input
 * @returns {string|null} the normalized domain, or null if it's not a valid domain
 */
export function normalizeDomain(input) {
  if (!input) return null;
  const domain = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return DOMAIN_RE.test(domain) ? domain : null;
}
