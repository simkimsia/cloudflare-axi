# Changelog

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
