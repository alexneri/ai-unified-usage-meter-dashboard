# OpenRouter fixtures

Recorded response bodies for the two endpoints the `openrouter` adapter reads.
They drive the offline mapping tests (`tests/openrouter.test.ts`) so the adapter
is proven **without a live key or network**.

- `key.json` — `GET https://openrouter.ai/api/v1/key`
- `credits.json` — `GET https://openrouter.ai/api/v1/credits`

Values are illustrative placeholders (no secret material — the `label` is a
display name, not the key). Re-record against the live API to verify field names
empirically; the adapter treats `/credits` field drift as a non-retriable
"unexpected response" (see `src/providers/openrouter.ts` empirical notes).
