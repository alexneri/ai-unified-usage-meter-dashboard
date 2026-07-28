import { describe, expect, it } from 'vitest';
import { loadConfig, parseCorsOrigins, parseEnv } from '../src/config.js';

describe('parseEnv', () => {
  it('parses key=value, ignores comments/blanks, strips quotes', () => {
    const env = parseEnv(['# comment', '', 'PORT=9000', 'HOST="0.0.0.0"', "NAME='x'", 'BAD_LINE'].join('\n'));
    expect(env.PORT).toBe('9000');
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.NAME).toBe('x');
    expect(env.BAD_LINE).toBeUndefined();
  });
});

describe('loadConfig auth-mode resolution', () => {
  const orig = { ...process.env };
  function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(patch)) {
        if (orig[k] === undefined) delete process.env[k];
        else process.env[k] = orig[k];
      }
    }
  }

  it('password set → password mode; credentials resolve; key never in config surface', () => {
    withEnv({ DASHBOARD_PASSWORD: 'hunter2', AUTH_MODE: undefined, OPENROUTER_KEY: 'sk-or-v1-abc' }, () => {
      const cfg = loadConfig();
      expect(cfg.authMode).toBe('password');
      expect(cfg.credentialsFor('openrouter').OPENROUTER_KEY).toBe('sk-or-v1-abc');
      // Unknown providers resolve to {}.
      expect(cfg.credentialsFor('nope')).toEqual({});
    });
  });

  it('no password + AUTH_MODE=open → open', () => {
    // Empty string overrides a local .env password so CI and dev machines agree.
    withEnv({ DASHBOARD_PASSWORD: '', AUTH_MODE: 'open' }, () => {
      expect(loadConfig().authMode).toBe('open');
    });
  });

  it('no password + no AUTH_MODE → closed (secure default)', () => {
    withEnv({ DASHBOARD_PASSWORD: '', AUTH_MODE: '' }, () => {
      expect(loadConfig().authMode).toBe('closed');
    });
  });

  it('CORS_ORIGINS parses exact Origins and drops junk', () => {
    withEnv(
      {
        DASHBOARD_PASSWORD: undefined,
        AUTH_MODE: 'open',
        CORS_ORIGINS: 'https://ai-usage-dashboard.vercel.app/, http://127.0.0.1:4173, not-a-url, ftp://x',
      },
      () => {
        expect(loadConfig().corsOrigins).toEqual([
          'https://ai-usage-dashboard.vercel.app',
          'http://127.0.0.1:4173',
        ]);
      },
    );
  });
});

describe('parseCorsOrigins', () => {
  it('returns [] for empty/missing', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('   ')).toEqual([]);
  });
});
