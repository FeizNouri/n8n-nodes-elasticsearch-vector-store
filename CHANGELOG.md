# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-07-19

### Fixed

- Installing the node from the n8n UI (**Settings → Community Nodes**) no longer fails to resolve LangChain. `@langchain/core` and `@langchain/community` moved from `peerDependencies` to `dependencies` so the n8n community-node installer pulls them in automatically. Previously they were declared as `peerDependencies` with a `*` range, which the UI installer does not install, leaving the node unable to load `ElasticVectorSearch` at runtime.

## [0.3.1] - 2026-05-20

### Fixed

- Credential test no longer errors with `Cannot create property '0' on boolean 'true'` when **Ignore SSL Issues** is enabled. The v0.3.0 SSL fix duplicated `skipSslCertificateValidation` in both `authenticate.properties` and `test.request`, which n8n's credential-test merger cannot handle. The option now lives only on `test.request`. Runtime SSL behavior is unchanged — the `@elastic/elasticsearch` Client applies `tls.rejectUnauthorized` directly in `getElasticsearchClient`, independent of any n8n HTTP credential property.

## [0.3.0] - 2026-05-20

### Added

- **Batch Size** option in Insert mode — chunks the `_bulk` request into N-document batches. Default `100`. Lower this to work around `413 Request Entity Too Large` from reverse proxies (e.g. nginx default `client_max_body_size` is 1 MB). Applies to both the raw-mode and default `addDocuments` insert paths.

### Fixed

- Credential test ("Save / Test" in the credential dialog) now honors the **Ignore SSL Issues** toggle. Previously the test request always ran with strict TLS verification, so self-signed Elasticsearch clusters reported `self-signed certificate in certificate chain` even though the option was on. Runtime requests were already unaffected.

## [0.2.1] - 2026-05-11

### Changed

- Rebranded as maintained by **[Hurence](https://www.hurence.com)** — added a "Maintained by" section to the README and listed Hurence in `package.json` `contributors`.
- Rewrote the README for npm display: added shields.io badges, restructured into npm-friendly sections (Features, Installation, Configuration, Operation modes, Insert options table, Usage patterns, Notes, Architecture, Development, Compatibility), and made the n8n UI install path the primary one.

## [0.2.0] - 2026-05-03

### Added

- **Custom Top-Level Fields** option in Insert mode — add arbitrary fields (e.g. `account_id`, `pipeline_id`) at the top level of stored ES documents, with values evaluated as n8n expressions per input item.
- **Metadata Keys to Keep** option — comma-separated allowlist that drops noisy auto-generated metadata (e.g. `pdf.info`, `loc.lines`, `source: blob`) injected by document loaders.
- **Add Chunk Index** option — auto-numbers chunks per input item and stores as a top-level `chunk_index` field.

### Changed

- When any of the new shape-control options are active, the node switches from `ElasticVectorSearch.addDocuments()` to direct `client.bulk()` writes for full document shape control.
- The node now manages index creation in raw mode (`text` / `embedding` (dense_vector, cosine) / `metadata` mapping).

### Notes

- Default behavior (no new options set) is identical to v0.1.0 — fully backward compatible.
- For best multi-tenant filtering performance, pre-create your ES index with explicit `keyword` mappings for ID fields before first insert.

## [0.1.0] - 2026-04-29

### Added

- Initial release.
- `Elasticsearch Vector Store` node with four operation modes: **Get Many**, **Insert Documents**, **Retrieve Documents (As Vector Store for Chain/Tool)**, **Retrieve Documents (As Tool for AI Agent)**.
- `Elasticsearch Vector Store API` credential supporting Basic Auth, API Key, and "Ignore SSL Issues" toggle for self-signed certs.
- Built on `@langchain/community`'s `ElasticVectorSearch`, with `@langchain/core` and `@langchain/community` declared as `peerDependencies` to share n8n's bundled instance.

[Unreleased]: https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/releases/tag/v0.1.0
