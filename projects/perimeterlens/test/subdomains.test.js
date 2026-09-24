import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSubdomainExposure } from "../src/checks/subdomains.js";

// checkSubdomainExposure does its own fetch() against crt.sh, so every test
// here mocks global fetch (t.mock.method — no new dependency, still zero-dep).
// node:test auto-restores mocks created via t.mock after each test.

function mockResponse({ ok = true, status = 200, body = "" } = {}) {
  return { ok, status, text: async () => body };
}

function crtRow(nameValue) {
  return { name_value: nameValue };
}

// The retry/backoff tests would otherwise take up to 7 real seconds (2s + 5s
// delays). Rather than reach for mock.timers (not available on Node 18, which
// this package's CI matrix still tests), replace the global setTimeout with
// a version that fires on the next tick regardless of requested delay. The
// mocked fetch calls resolve/reject as microtasks, which run before any
// setTimeout callback (even a 0ms one), so this doesn't change which branch
// of the retry loop executes — it just removes the wait.
function useFastTimers(t) {
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args));
}

test("dedupes + lowercases + strips wildcard prefix, keeping only the root domain and its real subdomains", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({
      body: JSON.stringify([
        crtRow("*.example.com\nWWW.Example.com"),
        crtRow("api.example.com"),
        crtRow("api.example.com"), // duplicate
        crtRow("evilexample.com"), // NOT a subdomain (no dot before "example.com")
        crtRow("example.com.attacker.net"), // shares a SAN but is a different domain
      ]),
    })
  );

  const r = await checkSubdomainExposure("example.com");
  assert.equal(r.ok, true);
  assert.deepEqual(r.hostnames, ["api.example.com", "example.com", "www.example.com"]);
});

test("suspicious-pattern matching: staging.example.com is flagged, www.example.com is not", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({ body: JSON.stringify([crtRow("staging.example.com\nwww.example.com")]) })
  );

  const r = await checkSubdomainExposure("example.com");
  assert.equal(r.ok, true);
  assert.deepEqual(r.suspicious, ["staging.example.com"]);
  assert.ok(r.hostnames.includes("www.example.com"));
});

test("empty response body (no certs found) resolves to an empty result, not a crash", async (t) => {
  t.mock.method(globalThis, "fetch", async () => mockResponse({ body: "" }));

  const r = await checkSubdomainExposure("example.com");
  assert.deepEqual(r, { ok: true, hostnames: [], suspicious: [] });
});

test("non-JSON / HTML response body (crt.sh under load) returns ok:false with an informative message, not a throw", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    mockResponse({ body: "<html><body>Service Unavailable</body></html>" })
  );

  const r = await checkSubdomainExposure("example.com");
  assert.equal(r.ok, false);
  assert.match(r.error, /non-JSON/);
});

test("non-OK HTTP status (e.g. 500) returns ok:false without retrying", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => mockResponse({ ok: false, status: 500 }));

  const r = await checkSubdomainExposure("example.com");
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
  assert.equal(fetchMock.mock.calls.length, 1); // non-OK status is not a network failure, so no retry
});

test("retry path: fetch rejects twice then succeeds on the 3rd attempt still returns ok:true", async (t) => {
  useFastTimers(t);
  let calls = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls < 3) throw new Error("network blip");
    return mockResponse({ body: JSON.stringify([crtRow("www.example.com")]) });
  });

  const r = await checkSubdomainExposure("example.com");
  assert.equal(r.ok, true);
  assert.deepEqual(r.hostnames, ["www.example.com"]);
  assert.equal(fetchMock.mock.calls.length, 3);
});

test("all attempts exhausted returns ok:false with an error mentioning it tried multiple times", async (t) => {
  useFastTimers(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network blip");
  });

  const r = await checkSubdomainExposure("example.com");
  assert.equal(r.ok, false);
  assert.match(r.error, /3 attempts/);
  assert.equal(fetchMock.mock.calls.length, 3);
});
