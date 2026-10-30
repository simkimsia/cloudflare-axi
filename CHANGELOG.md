# Changelog

## [0.2.5](https://github.com/simkimsia/cloudflare-axi/compare/cloudflare-axi-v0.2.4...cloudflare-axi-v0.2.5) (2026-10-30)


### Bug Fixes

* show custom domains in workers list ([e869fba](https://github.com/simkimsia/cloudflare-axi/commit/e869fba1c311f418d12acdcc56ad9ca4093e92a1)), closes [#62](https://github.com/simkimsia/cloudflare-axi/issues/62)
* time out the dashboard's and whoami's wrangler spawns ([#76](https://github.com/simkimsia/cloudflare-axi/issues/76)) ([b3e3832](https://github.com/simkimsia/cloudflare-axi/commit/b3e3832422509df2dcfebc59181952dbe4ab8ef6))
* **update:** count only this package's package.json as a PATH copy's root ([351cb30](https://github.com/simkimsia/cloudflare-axi/commit/351cb305bcd71816a0ad68aa06e3f477ef808a9e))
* **update:** detect a linked checkout and copies shadowed on PATH ([ca2b835](https://github.com/simkimsia/cloudflare-axi/commit/ca2b8358f7176ff7cc8f7c842d8510cffbad50c3)), closes [#56](https://github.com/simkimsia/cloudflare-axi/issues/56)
* **update:** flag a shadowed copy even with one other copy on PATH ([148fdf3](https://github.com/simkimsia/cloudflare-axi/commit/148fdf3a7e58ab1e997c88605e0596548be6cce6))
* **workers:** SIGKILL the wrangler group on a second Ctrl-C in workers tail ([#77](https://github.com/simkimsia/cloudflare-axi/issues/77)) ([24fa6ba](https://github.com/simkimsia/cloudflare-axi/commit/24fa6ba7c8e890b7efdcd9e3150f9b316d8563e8)), closes [#68](https://github.com/simkimsia/cloudflare-axi/issues/68)

## [0.2.4](https://github.com/simkimsia/cloudflare-axi/compare/cloudflare-axi-v0.2.3...cloudflare-axi-v0.2.4) (2026-10-23)


### Features

* **workers:** add bounded workers tail with cron events ([e6a489c](https://github.com/simkimsia/cloudflare-axi/commit/e6a489ce38e201fa38f7d182fd93243eff1e484d)), closes [#37](https://github.com/simkimsia/cloudflare-axi/issues/37)
* **workers:** add workers delete and workers secret delete ([834bf54](https://github.com/simkimsia/cloudflare-axi/commit/834bf54bdd79229885bb576b43e764f11f1159db)), closes [#47](https://github.com/simkimsia/cloudflare-axi/issues/47)
* **workers:** add workers list with the account's workers.dev subdomain ([cde55cf](https://github.com/simkimsia/cloudflare-axi/commit/cde55cfd258f2c8f9aaf709d8db88434f7f6b2d0)), closes [#39](https://github.com/simkimsia/cloudflare-axi/issues/39)


### Bug Fixes

* **api:** time out REST calls so a hung API cannot stall the dashboard ([1c4726b](https://github.com/simkimsia/cloudflare-axi/commit/1c4726ba450afd30d2b8610576349d0c46628a6f)), closes [#58](https://github.com/simkimsia/cloudflare-axi/issues/58)
* **workers:** make workers tail stop wrangler's whole process group ([2e0450d](https://github.com/simkimsia/cloudflare-axi/commit/2e0450d6dd5270188886839631afecf7ebf28479)), closes [#37](https://github.com/simkimsia/cloudflare-axi/issues/37)
* **workers:** read the config's account_id with a TOML parser ([e47a92e](https://github.com/simkimsia/cloudflare-axi/commit/e47a92e1b3d688aaf6c84964745b531b2f8f8021)), closes [#47](https://github.com/simkimsia/cloudflare-axi/issues/47)

## [0.2.3](https://github.com/simkimsia/cloudflare-axi/compare/cloudflare-axi-v0.2.2...cloudflare-axi-v0.2.3) (2026-10-15)


### Features

* AXI_DEBUG=1 prints forwarded wrangler argv and REST calls to stderr ([75ff20c](https://github.com/simkimsia/cloudflare-axi/commit/75ff20ca623798da2839a85268dc11bfb8f5d8a4)), closes [#31](https://github.com/simkimsia/cloudflare-axi/issues/31)
* global --config for directory-scoped commands ([d8d158a](https://github.com/simkimsia/cloudflare-axi/commit/d8d158ab64081331809c758fb3e93df79b56123e)), closes [#38](https://github.com/simkimsia/cloudflare-axi/issues/38)
* kv create, keys, get, put and delete ([c14657a](https://github.com/simkimsia/cloudflare-axi/commit/c14657a7787949b6d5390c2cd7f74e868b3f51c1)), closes [#35](https://github.com/simkimsia/cloudflare-axi/issues/35) [#36](https://github.com/simkimsia/cloudflare-axi/issues/36)
* **kv:** add kv drop to delete a KV namespace ([efaf0ae](https://github.com/simkimsia/cloudflare-axi/commit/efaf0aee3c7ac4c4d86bfab5b5c71d37c503e691)), closes [#46](https://github.com/simkimsia/cloudflare-axi/issues/46)
* workers deploy and secret put/list ([#34](https://github.com/simkimsia/cloudflare-axi/issues/34)) ([64d363f](https://github.com/simkimsia/cloudflare-axi/commit/64d363fd357b51c59de3e2b46e3af2efb4ebc027))


### Bug Fixes

* address workers review findings ([e54193a](https://github.com/simkimsia/cloudflare-axi/commit/e54193ab3776e1b57deace4c0084eb9565a426b3)), closes [#34](https://github.com/simkimsia/cloudflare-axi/issues/34)
* **kv:** bounded listings, byte-exact reads, --key, binding 404 hints ([aef9de3](https://github.com/simkimsia/cloudflare-axi/commit/aef9de33036884546315c595309b330322f63618)), closes [#36](https://github.com/simkimsia/cloudflare-axi/issues/36)
* **kv:** count drop's keys with exactly one REST request ([de9c1d4](https://github.com/simkimsia/cloudflare-axi/commit/de9c1d47d668379179518c9373aed6add9c7bb4b)), closes [#46](https://github.com/simkimsia/cloudflare-axi/issues/46)
* run raw wrangler hints from the config's directory ([5934d8c](https://github.com/simkimsia/cloudflare-axi/commit/5934d8c6ee8dd41cbe0682ad32271fb48ae6c9b1)), closes [#38](https://github.com/simkimsia/cloudflare-axi/issues/38)
* **workers:** map a missing [assets] directory to VALIDATION_ERROR ([0e57091](https://github.com/simkimsia/cloudflare-axi/commit/0e570917d24a2d91926fd09ac6b3d33648779099)), closes [#44](https://github.com/simkimsia/cloudflare-axi/issues/44)
* **workers:** map a missing main entry-point file to VALIDATION_ERROR ([d7cab4a](https://github.com/simkimsia/cloudflare-axi/commit/d7cab4adea7485ef5693d34c53773a141d44495d)), closes [#43](https://github.com/simkimsia/cloudflare-axi/issues/43)
* **workers:** report unknown deploy targets, carry --config into hints, name missing entry point ([2b2d65a](https://github.com/simkimsia/cloudflare-axi/commit/2b2d65a73532ab676988aa80e46ba95b8fc951b8)), closes [#34](https://github.com/simkimsia/cloudflare-axi/issues/34)

## [0.2.2](https://github.com/simkimsia/cloudflare-axi/compare/cloudflare-axi-v0.2.1...cloudflare-axi-v0.2.2) (2026-10-04)


### Bug Fixes

* give the remaining flag validation errors a next step ([ee02201](https://github.com/simkimsia/cloudflare-axi/commit/ee02201f5df674c7929debd7528ae55478468ef0))

## [0.2.1](https://github.com/simkimsia/cloudflare-axi/compare/cloudflare-axi-v0.2.0...cloudflare-axi-v0.2.1) (2026-10-04)


### Features

* **email:** add unforward to delete a routing rule ([32a1859](https://github.com/simkimsia/cloudflare-axi/commit/32a185992f328376d07a04d75818fa0c51b6e582)), closes [#20](https://github.com/simkimsia/cloudflare-axi/issues/20)

## [0.2.0](https://github.com/simkimsia/cloudflare-axi/compare/cloudflare-axi-v0.1.0...cloudflare-axi-v0.2.0) (2026-10-04)


### ⚠ BREAKING CHANGES

* the error code NOT_CONFIGURED is now NOT_LINKED. Agents or scripts matching on the string NOT_CONFIGURED must match NOT_LINKED.

### Features

* add VISION.md and a dry-run repo-triage crewmate on GitHub Actions ([db6e06c](https://github.com/simkimsia/cloudflare-axi/commit/db6e06c8d5b3e87c59924936c45b13c7dda8f23f))
* **email:** add enable, add-destination, and forward write commands ([e3305a3](https://github.com/simkimsia/cloudflare-axi/commit/e3305a34058bc3810ebb6f92ad6cd9b7bebc6a71)), closes [#2](https://github.com/simkimsia/cloudflare-axi/issues/2)
* **email:** add read-only Email Routing commands via the REST API ([cc73ead](https://github.com/simkimsia/cloudflare-axi/commit/cc73ead474fbd4e12bc3a73ae3c4179d162337a3)), closes [#1](https://github.com/simkimsia/cloudflare-axi/issues/1)
* **pages:** add create, deploy, and deployments subcommands ([018badf](https://github.com/simkimsia/cloudflare-axi/commit/018badf0993cab9f2f7a9c6d14a76e594731ee5a)), closes [#3](https://github.com/simkimsia/cloudflare-axi/issues/3)
* scaffold cloudflare-axi v0 with read-only commands ([a2c94e7](https://github.com/simkimsia/cloudflare-axi/commit/a2c94e7576131fb1136de28d50f989fac001c54c))
* ship installable agent skill with vendor-cli fallback protocol ([f0d7000](https://github.com/simkimsia/cloudflare-axi/commit/f0d7000738f644063d7c4b11d802354976728b6d))
* **triage:** enable live mode (issues: write, comment + label tools) ([c9b77cc](https://github.com/simkimsia/cloudflare-axi/commit/c9b77cc640adbda1237e81fd34dc6aa235284075))
* **triage:** stamp model, harness, and run id into every verdict ([c363591](https://github.com/simkimsia/cloudflare-axi/commit/c363591a09bbd5c19e583031d62efb26eacb4474))


### Bug Fixes

* keep SDK error codes in formatError and give UNKNOWN errors a next step ([a49e2c5](https://github.com/simkimsia/cloudflare-axi/commit/a49e2c5ef83b8e277b8c64c9d3035a9f983da6d2)), closes [#21](https://github.com/simkimsia/cloudflare-axi/issues/21)
* rename NOT_CONFIGURED error code to NOT_LINKED ([332e639](https://github.com/simkimsia/cloudflare-axi/commit/332e6398746c4110441fdfe7396ea66cadf1823b)), closes [#15](https://github.com/simkimsia/cloudflare-axi/issues/15)
