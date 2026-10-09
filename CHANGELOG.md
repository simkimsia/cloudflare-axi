# Changelog

## [0.2.3](https://github.com/simkimsia/cloudflare-axi/compare/cloudflare-axi-v0.2.2...cloudflare-axi-v0.2.3) (2026-10-09)


### Features

* AXI_DEBUG=1 prints forwarded wrangler argv and REST calls to stderr ([75ff20c](https://github.com/simkimsia/cloudflare-axi/commit/75ff20ca623798da2839a85268dc11bfb8f5d8a4)), closes [#31](https://github.com/simkimsia/cloudflare-axi/issues/31)
* kv create, keys, get, put and delete ([c14657a](https://github.com/simkimsia/cloudflare-axi/commit/c14657a7787949b6d5390c2cd7f74e868b3f51c1)), closes [#35](https://github.com/simkimsia/cloudflare-axi/issues/35) [#36](https://github.com/simkimsia/cloudflare-axi/issues/36)
* workers deploy and secret put/list ([#34](https://github.com/simkimsia/cloudflare-axi/issues/34)) ([64d363f](https://github.com/simkimsia/cloudflare-axi/commit/64d363fd357b51c59de3e2b46e3af2efb4ebc027))


### Bug Fixes

* address workers review findings ([e54193a](https://github.com/simkimsia/cloudflare-axi/commit/e54193ab3776e1b57deace4c0084eb9565a426b3)), closes [#34](https://github.com/simkimsia/cloudflare-axi/issues/34)
* **kv:** bounded listings, byte-exact reads, --key, binding 404 hints ([aef9de3](https://github.com/simkimsia/cloudflare-axi/commit/aef9de33036884546315c595309b330322f63618)), closes [#36](https://github.com/simkimsia/cloudflare-axi/issues/36)
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
