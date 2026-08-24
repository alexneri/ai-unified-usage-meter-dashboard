# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). From 0.1.0
onward this file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) — see `RELEASING.md`.

## [0.2.0](https://github.com/alexneri/ai-unified-usage-meter-dashboard/compare/v0.1.0...v0.2.0) (2026-08-24)


### Features

* **ui:** usage & cost history view with cumulative toggle (ports [#13](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/13)+[#14](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/14)) ([#18](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/18)) ([296879f](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/296879f9cd6df88e48b140b89d7cbd16bae8e6c3))


### Build System & Dependencies

* **deps-dev:** Bump @types/node from 22.20.1 to 26.1.2 ([#15](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/15)) ([c0e3e39](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/c0e3e39fffc46f9d3b2e530eb4f3d8070c7c0db4))
* **deps-dev:** Bump typescript from 5.9.3 to 7.0.2 ([#14](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/14)) ([40b9b9d](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/40b9b9d64d32f7349424c5b09cc27d5f81c34d27))
* **deps:** Bump @hono/node-server in the minor-and-patch group ([#13](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/13)) ([e3e4bc7](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/e3e4bc7312847daa1212f99c8a7c1831ae2e2957))
* **deps:** Bump actions/checkout from 4 to 7 ([#11](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/11)) ([4e48c05](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/4e48c058485ca14ff823b290947101edb97895ed))
* **deps:** Bump actions/setup-node from 4 to 7 ([#10](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/10)) ([627e85b](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/627e85be609778df3a9363dfbabeeceacb655338))
* **deps:** Bump googleapis/release-please-action from 4 to 5 ([#12](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/12)) ([d5ef0c6](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/d5ef0c65bd823f84a1daad0efbab4b0dfc2362f5))
* **deps:** Bump hono from 4.12.31 to 4.13.0 ([#6](https://github.com/alexneri/ai-unified-usage-meter-dashboard/issues/6)) ([c3e5be1](https://github.com/alexneri/ai-unified-usage-meter-dashboard/commit/c3e5be172f90b8c24625e6a3cb858252f8f7666c))

## [0.1.0] - 2026-08-05

Initial release — the unified AI usage & spend dashboard: a trusted local collector
(Hono + TypeScript) with official and unofficial provider readers, and a key-free web UI
(near-cap gauges, balance and spend cards, sparklines, honest official/unofficial confidence
chips, drag-to-reorder tiles, and an offline last-known board).
