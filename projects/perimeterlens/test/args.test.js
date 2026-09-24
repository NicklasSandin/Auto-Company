import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, normalizeDomain } from "../src/args.js";

// parseArgs is the pure flag-parsing logic extracted from bin/perimeterlens.js
// so it's testable without spawning a subprocess. It throws a plain Error on
// an unknown argument instead of calling process.exit itself — the CLI
// entrypoint owns turning that into an exit code.

test("parseArgs: bare domain sets domain, everything else defaults", () => {
  const args = parseArgs(["example.com"]);
  assert.deepEqual(args, { domain: "example.com", json: false, out: null, help: false, version: false });
});

test("parseArgs: no arguments at all leaves domain null (caller decides that's an error)", () => {
  const args = parseArgs([]);
  assert.equal(args.domain, null);
});

test("parseArgs: --json flag", () => {
  const args = parseArgs(["example.com", "--json"]);
  assert.equal(args.json, true);
});

test("parseArgs: --out <file> consumes the following argument as its value", () => {
  const args = parseArgs(["example.com", "--out", "report.md"]);
  assert.equal(args.out, "report.md");
});

test("parseArgs: -h and --help both set help", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs: -v and --version both set version", () => {
  assert.equal(parseArgs(["-v"]).version, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("parseArgs: flags can come before or after the domain", () => {
  const args = parseArgs(["--json", "example.com"]);
  assert.equal(args.domain, "example.com");
  assert.equal(args.json, true);
});

test("parseArgs: unknown flag throws with the offending argument in the message", () => {
  assert.throws(() => parseArgs(["--bogus"]), /^Error: Unknown argument: --bogus$/);
});

test("parseArgs: a second positional argument is rejected as unknown (only one domain allowed)", () => {
  assert.throws(() => parseArgs(["example.com", "extra.com"]), /Unknown argument: extra\.com/);
});

test("normalizeDomain: plain valid domain passes through unchanged", () => {
  assert.equal(normalizeDomain("example.com"), "example.com");
});

test("normalizeDomain: strips a leading https:// scheme", () => {
  assert.equal(normalizeDomain("https://example.com"), "example.com");
});

test("normalizeDomain: strips a leading http:// scheme", () => {
  assert.equal(normalizeDomain("http://example.com"), "example.com");
});

test("normalizeDomain: strips a trailing path", () => {
  assert.equal(normalizeDomain("example.com/some/path"), "example.com");
});

test("normalizeDomain: lowercases the domain", () => {
  assert.equal(normalizeDomain("EXAMPLE.COM"), "example.com");
});

test("normalizeDomain: trims surrounding whitespace", () => {
  assert.equal(normalizeDomain("  example.com  "), "example.com");
});

test("normalizeDomain: combines scheme-stripping, path-stripping, and lowercasing together", () => {
  assert.equal(normalizeDomain("HTTPS://Example.COM/Path?x=1"), "example.com");
});

test("normalizeDomain: subdomains are valid", () => {
  assert.equal(normalizeDomain("mail.example.com"), "mail.example.com");
});

test("normalizeDomain: empty string is invalid", () => {
  assert.equal(normalizeDomain(""), null);
});

test("normalizeDomain: no TLD (no dot at all) is invalid", () => {
  assert.equal(normalizeDomain("localhost"), null);
});

test("normalizeDomain: leading hyphen in a label is invalid", () => {
  assert.equal(normalizeDomain("-example.com"), null);
});

test("normalizeDomain: trailing hyphen in a label is invalid", () => {
  assert.equal(normalizeDomain("example-.com"), null);
});
