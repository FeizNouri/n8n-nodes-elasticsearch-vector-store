# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-XX-XX

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

[Unreleased]: https://github.com/your-username/n8n-nodes-elasticsearch-vector-store/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/your-username/n8n-nodes-elasticsearch-vector-store/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/your-username/n8n-nodes-elasticsearch-vector-store/releases/tag/v0.1.0
