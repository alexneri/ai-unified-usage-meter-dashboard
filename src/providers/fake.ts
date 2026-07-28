// Fake adapter — test/dev only. Proves the core treats any UsageProvider
// identically and exercises the fail-soft contract (Story 1.1). NOT registered in
// production; used by tests and, optionally, a dev fixtures mode.

import { errorSnapshot } from '../core/normalize.js';
import type { ProviderSnapshot, UsageProvider } from '../core/types.js';

export interface FakeOptions {
  id?: string;
  displayName?: string;
  /** When set, fetch() returns an errorSnapshot built from this (fail-soft). */
  failWith?: unknown;
  /** Meters to return on success. */
  meters?: ProviderSnapshot['meters'];
  /** If true, fetch() *throws* — used to prove the scheduler survives a misbehaving adapter. */
  throwInstead?: boolean;
}

export function makeFakeProvider(opts: FakeOptions = {}): UsageProvider {
  const id = opts.id ?? 'fake';
  const displayName = opts.displayName ?? 'Fake Provider';
  return {
    id,
    displayName,
    confidence: 'official',
    cacheTtlSeconds: 300,
    async fetch() {
      if (opts.throwInstead) {
        // A well-behaved adapter would NOT do this; the test asserts the core copes.
        throw new Error('fake adapter exploded');
      }
      if (opts.failWith !== undefined) {
        return errorSnapshot(id, displayName, opts.failWith);
      }
      return {
        providerId: id,
        displayName,
        meters: opts.meters ?? [
          { kind: 'balance', label: 'Credits remaining', value: 4.2, unit: 'usd', limit: 10, remaining: 4.2 },
        ],
        confidence: 'official',
        freshness: 'live',
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}
