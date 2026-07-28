// CacheStore — last-good snapshot storage. Architecture §4 (shape), §10 (caching).
// MVP ships MemoryCache + JsonFileCache; KvCache is a drop-in for the hybrid
// deploy (Epic 4) with no interface change.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProviderSnapshot } from './types.js';

/** Binding contract — Architecture §4. */
export interface CacheStore {
  get(id: string): Promise<ProviderSnapshot | null>;
  set(id: string, snap: ProviderSnapshot, ttlSeconds: number): Promise<void>;
}

interface Entry {
  snap: ProviderSnapshot;
  ttlSeconds: number;
  storedAt: number; // epoch ms
}

/** In-memory cache (default). Fastest; lost on restart. */
export class MemoryCache implements CacheStore {
  protected store = new Map<string, Entry>();

  async get(id: string): Promise<ProviderSnapshot | null> {
    return this.store.get(id)?.snap ?? null;
  }

  async set(id: string, snap: ProviderSnapshot, ttlSeconds: number): Promise<void> {
    this.store.set(id, { snap, ttlSeconds, storedAt: Date.now() });
  }
}

/**
 * JSON-file backed cache that survives a collector restart. Serves last-good data
 * across reboots (fail-soft, NFR4). Writes are atomic (temp file + rename). The
 * default path (.data/cache.json) is gitignored.
 *
 * The serialized file is ProviderSnapshot[] only — it holds NO credentials, since
 * the snapshot type has no credential field (§4 key-isolation invariant).
 */
export class JsonFileCache implements CacheStore {
  private mem = new Map<string, Entry>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, Entry>;
      for (const [id, entry] of Object.entries(parsed)) {
        if (entry && entry.snap) this.mem.set(id, entry);
      }
    } catch {
      // No file yet (first run) or unreadable — start empty. Not fatal.
    }
  }

  async get(id: string): Promise<ProviderSnapshot | null> {
    await this.ensureLoaded();
    return this.mem.get(id)?.snap ?? null;
  }

  async set(id: string, snap: ProviderSnapshot, ttlSeconds: number): Promise<void> {
    await this.ensureLoaded();
    this.mem.set(id, { snap, ttlSeconds, storedAt: Date.now() });
    await this.persist();
  }

  private persist(): Promise<void> {
    // Serialize writes so concurrent set()s don't corrupt the file.
    this.writeChain = this.writeChain.then(() => this.writeNow());
    return this.writeChain;
  }

  private async writeNow(): Promise<void> {
    const obj: Record<string, Entry> = {};
    for (const [id, entry] of this.mem) obj[id] = entry;
    const json = JSON.stringify(obj, null, 2);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, this.path);
  }
}
