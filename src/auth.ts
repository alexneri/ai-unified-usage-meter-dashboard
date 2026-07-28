// Auth gate. Architecture §8, Story 1.5.
//
// The MVP default deployment is Tailscale Topology A: the collector binds to the
// tailnet (or loopback) and the NETWORK is the gate. This module adds an optional
// application-level password/session gate as belt-and-suspenders, and a dev-only
// open mode.
//
// Modes (resolved in config.ts):
//   password → require `Authorization: Bearer <password>` OR a valid session cookie
//              (set by POST /api/login). Protects the UI + /api/snapshot.
//   open     → dev only: allow everything, but log a warning at boot.
//   closed   → no password and not explicitly open: reject the UI + /api/snapshot
//              (a stray open port must never serve usage data).
//
// Session cookies are HMAC-signed with the dashboard password so they survive
// collector restarts (no in-memory session table). TTL is at least one full day.
//
// /api/health stays open in every mode (liveness only, no usage values).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AuthMode } from './config.js';

export const SESSION_COOKIE = 'dash_session';
/** Session lifetime: 24h minimum so a morning login lasts the working day. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export class AuthGate {
  constructor(
    private readonly mode: AuthMode,
    private readonly password: string | undefined,
  ) {}

  /** True if this request may access the UI and /api/snapshot. */
  isAuthed(c: Context): boolean {
    if (this.mode === 'open') return true;
    if (this.mode === 'closed') return false;
    // password mode
    const header = c.req.header('authorization');
    if (header && this.matchesBearer(header)) return true;
    const cookie = getCookie(c, SESSION_COOKIE);
    return cookie !== undefined && this.isValidSession(cookie);
  }

  private matchesBearer(header: string): boolean {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m || !this.password) return false;
    return safeEqual(m[1]!, this.password);
  }

  /**
   * Validate a login attempt; on success create + return a durable signed
   * session token (survives process restart).
   */
  login(candidate: string): string | null {
    if (this.mode !== 'password' || !this.password) return null;
    if (!safeEqual(candidate, this.password)) return null;
    return this.mintSession();
  }

  /** HMAC-signed token: v1.<expMs>.<nonce>.<sig> */
  mintSession(now = Date.now()): string {
    if (!this.password) throw new Error('cannot mint session without password');
    const exp = now + SESSION_TTL_MS;
    const nonce = randomBytes(16).toString('base64url');
    const body = `v1.${exp}.${nonce}`;
    const sig = createHmac('sha256', this.password).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  isValidSession(token: string, now = Date.now()): boolean {
    if (!this.password) return false;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const exp = Number(parts[1]);
    if (!Number.isFinite(exp) || now > exp) return false;
    const nonce = parts[2]!;
    const sig = parts[3]!;
    if (!nonce || !sig) return false;
    const body = `v1.${exp}.${nonce}`;
    const expected = createHmac('sha256', this.password).update(body).digest('base64url');
    return safeEqual(sig, expected);
  }

  setSessionCookie(c: Context, token: string): void {
    const url = c.req.url;
    const secure = url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https';
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure,
      maxAge: SESSION_TTL_SECONDS,
    });
  }

  get requiresLogin(): boolean {
    return this.mode === 'password';
  }

  get isOpen(): boolean {
    return this.mode === 'open';
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
