# Contributing

Thanks for taking a look. This is a small, focused personal-utility project; PRs
that keep it that way are very welcome.

## Dev setup

Requires Node ≥ 20.

```sh
npm install
cp .env.example .env      # optional — add only the keys you have
AUTH_MODE=open npm start  # http://127.0.0.1:8787
```

## Checks (all must pass)

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run secret-scan # no committed key material
```

CI runs the same three on every PR.

## Adding a provider

The whole point of the design: a new provider is **one file plus one registry
entry** (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)).

1. Add `src/providers/<name>.ts` (official) or `src/providers/local/<name>.ts`
   (unofficial local reader) exporting a `UsageProvider`. Map the raw response into
   `ProviderSnapshot` / `Meter` — keep the mapper pure so it's easy to test.
2. Register it in `src/providers/registry.ts` (`optIn` with a `keyId` for official
   APIs, or `alwaysOn` for a self-discovering local reader).
3. If it needs a credential, thread it through `credentialMap()` in
   `src/config.ts` and document the env var in `.env.example`.
4. Add a fixture under `fixtures/<name>/` and a test under `tests/`. **Fixtures
   must be synthetic** — never paste a real API response with real balances,
   account IDs, or request IDs.
5. Set `confidence: 'official'` only for documented APIs. Undocumented or
   local-token readers are `'unofficial'` and must fail soft.

## Conventions

- TypeScript, ES modules, no runtime deps beyond Hono. Match the surrounding style.
- Never commit secrets. Keep `/api/snapshot` key-free.
- Conventional Commit messages are appreciated (`feat:`, `fix:`, `docs:`…).
