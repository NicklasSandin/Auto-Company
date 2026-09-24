// TLS certificate health check.
//
// What this answers: "is my certificate about to silently expire, is the
// chain actually trusted, and is this endpoint still negotiating an old TLS
// version?" This is lifecycle/health monitoring, not cipher-suite config
// grading (that's what Observatory/SecurityHeaders-style tools do for
// headers — this tool deliberately does not re-do that for TLS either;
// scope is expiry + trust + protocol version only).
//
// Passive: a single TLS handshake to the target's own port 443, the same
// interaction that happens every time a browser loads the page.

import { connect } from "node:tls";

const TLS_TIMEOUT_MS = 10_000;
const WARN_DAYS = 30;

/**
 * @param {string} domain
 * @returns {Promise<{ok: true, ...} | {ok: false, error: string}>}
 */
export function checkTlsHealth(domain) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(result);
    };

    const socket = connect(
      {
        host: domain,
        port: 443,
        servername: domain,
        // We intentionally connect without rejecting on chain errors so we
        // can *report* trust status ourselves (self-signed, expired, etc.)
        // instead of just throwing.
        rejectUnauthorized: false,
        timeout: TLS_TIMEOUT_MS,
      },
      () => {
        const cert = socket.getPeerCertificate(false);
        if (!cert || Object.keys(cert).length === 0) {
          finish({ ok: false, error: "no certificate returned by peer" });
          return;
        }

        const now = Date.now();
        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const daysRemaining = Math.floor((validTo.getTime() - now) / (1000 * 60 * 60 * 24));

        finish({
          ok: true,
          subject: cert.subject?.CN ?? null,
          issuer: cert.issuer?.CN ?? null,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysRemaining,
          expiringSoon: daysRemaining <= WARN_DAYS,
          expired: daysRemaining < 0,
          trusted: socket.authorized === true,
          trustError: socket.authorized ? null : (socket.authorizationError || "unknown"),
          protocol: socket.getProtocol(),
          outdatedProtocol: ["TLSv1", "TLSv1.1", "SSLv3"].includes(socket.getProtocol()),
        });
      }
    );

    const timer = setTimeout(() => {
      finish({ ok: false, error: "TLS handshake timed out" });
    }, TLS_TIMEOUT_MS);

    socket.on("error", (err) => {
      finish({ ok: false, error: `TLS connection failed: ${err.message}` });
    });
  });
}
