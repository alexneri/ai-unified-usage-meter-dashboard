// Provider registry — Architecture §5. A new provider is one new file plus one
// entry here; no core change. Registration is credential-aware (Story 2.3 / task
// requirement):
//
//   - LOCAL readers (claude-code, codex, ccusage, grok) are ALWAYS
//     registered: they self-discover local OAuth/session tokens at fetch time, so
//     an empty vault still yields useful cards for the services on this machine.
//     When a source is missing they render an honest fail-soft error card, not a crash.
//   - openrouter is always registered (the Epic 1 anchor; a not-configured card
//     invites adding a key).
//   - OPT-IN official APIs (openai, anthropic, deepseek, xai) are registered ONLY
//     when their credential is present — an absent key means the provider is simply
//     omitted, so the board shows no error card for a service the owner doesn't use.

import type { UsageProvider } from '../core/types.js';
import { anthropic } from './anthropic.js';
import { byteplus } from './byteplus.js';
import { deepseek } from './deepseek.js';
import { claudeCode } from './local/claude-code.js';
import { ccusage } from './local/ccusage.js';
import { codex } from './local/codex.js';
import { grok } from './local/grok.js';
import { openAI } from './openai.js';
import { openRouter } from './openrouter.js';
import { xai } from './xai.js';

/** Always-on adapters: the MVP anchor plus the self-discovering local readers. */
export const alwaysOn: UsageProvider[] = [openRouter, claudeCode, codex, ccusage, grok];

/** Opt-in official adapters: registered only when their credential is present. */
export const optIn: Array<{ provider: UsageProvider; keyId: string }> = [
  { provider: openAI, keyId: 'openai' },
  { provider: anthropic, keyId: 'anthropic' },
  { provider: deepseek, keyId: 'deepseek' },
  { provider: xai, keyId: 'xai' },
  { provider: byteplus, keyId: 'byteplus' },
];

/**
 * The full display-ordered list for a given credential state. `hasCredentials` is
 * config.hasCredentials — opt-in adapters are included only when it returns true.
 */
export function buildProviders(hasCredentials: (providerId: string) => boolean): UsageProvider[] {
  return [...alwaysOn, ...optIn.filter(({ keyId }) => hasCredentials(keyId)).map(({ provider }) => provider)];
}

/** Register every applicable provider with the scheduler (credential-aware). */
export function registerAll(register: (p: UsageProvider) => void, hasCredentials: (providerId: string) => boolean): void {
  for (const p of buildProviders(hasCredentials)) register(p);
}
