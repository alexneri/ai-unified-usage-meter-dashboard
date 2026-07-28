import { describe, expect, it } from 'vitest';
import { AuthGate, SESSION_TTL_SECONDS } from '../src/auth.js';

describe('AuthGate durable sessions', () => {
  it('mints a signed session that validates and survives a new AuthGate instance', () => {
    const a = new AuthGate('password', 'hunter2');
    const token = a.login('hunter2');
    expect(token).toBeTruthy();
    expect(a.isValidSession(token!)).toBe(true);

    // Collector restart: new process, same password → still valid.
    const b = new AuthGate('password', 'hunter2');
    expect(b.isValidSession(token!)).toBe(true);
  });

  it('rejects wrong password, wrong signature, and expired tokens', () => {
    const gate = new AuthGate('password', 'hunter2');
    expect(gate.login('nope')).toBeNull();

    const token = gate.mintSession();
    const parts = token.split('.');
    parts[3] = 'deadbeef';
    expect(gate.isValidSession(parts.join('.'))).toBe(false);

    const expired = gate.mintSession(Date.now() - (SESSION_TTL_SECONDS + 60) * 1000);
    expect(gate.isValidSession(expired)).toBe(false);
  });

  it('rejects sessions signed with a different password', () => {
    const a = new AuthGate('password', 'hunter2');
    const token = a.mintSession();
    const b = new AuthGate('password', 'other-password');
    expect(b.isValidSession(token)).toBe(false);
  });

  it('open mode always auths; closed never', () => {
    expect(new AuthGate('open', undefined).isOpen).toBe(true);
    expect(new AuthGate('closed', undefined).requiresLogin).toBe(false);
  });
});
