# n8n-nodes-elasticsearch-vector-store

[![npm version](https://img.shields.io/npm/v/n8n-nodes-elasticsearch-vector-store.svg)](https://www.npmjs.com/package/n8n-nodes-elasticsearch-vector-store)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-elasticsearch-vector-store.svg)](https://www.npmjs.com/package/n8n-nodes-elasticsearch-vector-store)
[![license](https://img.shields.io/npm/l/n8n-nodes-elasticsearch-vector-store.svg)](./LICENSE.md)

An [n8n](https://n8n.io) community node that turns **Elasticsearch** into a first-class **LangChain vector store** — the Elasticsearch equivalent of the official `Postgres PGVector Store` node. Use it for RAG ingestion, similarity search, retrieval chains, and AI agent tools, all backed by Elasticsearch's native kNN/HNSW search.

> Maintained by **[Hurence](https://www.hurence.com)** — open-sourced for the n8n community.

---

## Features

- Four operation modes, identical to n8n's official vector store nodes:
  - **Get Many** — embed a prompt and return ranked similar documents
  - **Insert Documents** — embed and store documents from a Document Loader sub-node
  - **Retrieve Documents (As Vector Store for Chain/Tool)** — wire into a `Vector Store Retriever` or `Question and Answer Chain`
  - **Retrieve Documents (As Tool for AI Agent)** — expose the store as a tool the agent can call
- Native Elasticsearch kNN search on `dense_vector` fields (HNSW, cosine similarity)
- Auto-creates the index with the correct mapping on first insert, with embedding dimension auto-detected from your embeddings sub-node
- **Custom top-level fields** for multi-tenant filtering (e.g. `account_id`, `pipeline_id`) — evaluated as n8n expressions per item
- **Metadata allowlist** to drop noisy auto-generated keys (e.g. `pdf.*`, `loc.*`) from document loaders
- **`chunk_index`** — automatically number chunks per input item
- Works with any n8n embeddings sub-node (OpenAI, Gemini, Cohere, Ollama, etc.)
- Auth: Basic, API Key, or none — with optional SSL bypass for dev clusters

---

## Installation

### Option A — From the n8n UI (recommended)

1. In your self-hosted n8n: **Settings → Community Nodes → Install**
2. Enter `n8n-nodes-elasticsearch-vector-store`
3. Click **Install**

> Community nodes are disabled by default on Docker. Set the following env vars on your n8n container:
>
> ```
> N8N_COMMUNITY_PACKAGES_ENABLED=true
> N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true
> ```

After install, the node appears as **"Elasticsearch Vector Store"** under **AI → Vector Stores**.

### Option B — Manual (custom directory)

```bash
mkdir -p ~/.n8n/custom
cd ~/.n8n/custom
npm init -y                                       # if not already initialized
npm install n8n-nodes-elasticsearch-vector-store
```

Restart n8n.

### Option C — Build from source

```bash
git clone https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store.git
cd n8n-nodes-elasticsearch-vector-store
npm install
npm run build

# then link into your custom directory
npm link
cd ~/.n8n/custom
npm link n8n-nodes-elasticsearch-vector-store
```

---

## Configuration

Create a credential of type **Elasticsearch Vector Store API** in n8n:

| Field | Description |
|---|---|
| **Base URL** | Your Elasticsearch endpoint, e.g. `http://elasticsearch:9200` |
| **Authentication** | `Basic Auth`, `API Key`, or `None` |
| **Username / Password** | For Basic Auth |
| **API Key** | The base64-encoded `id:api_key` value from `POST /_security/api_key` — **not** the `ApiKey <encoded>` wrapper |
| **Ignore SSL Issues** | Toggle on for self-signed certificates in dev |

The same credential is used by both the underlying Elasticsearch client (index management, bulk insert) and the LangChain wrapper (kNN search).

---

## Operation modes

### 1. Insert Documents

Embed and write documents from a Document Loader sub-node into an Elasticsearch index.

**Required inputs:** a Document Loader sub-node and an Embeddings sub-node.

**Options:**

| Option | Default | What it does |
|---|---|---|
| `Clear Index Before Insert` | `false` | Drops and recreates the index before writing — useful when switching embedding models (and so changing the vector dimension) |
| `Metadata Keys to Keep` | *(empty = keep all)* | Comma-separated allowlist of metadata keys to store. Everything else is dropped. Great for stripping `pdf.*`, `loc.*`, and similar loader noise |
| `Add Chunk Index` | `false` | Stores a top-level `chunk_index` field (0, 1, 2, …) per input item, useful for re-ordering chunks at retrieval time |
| `Custom Top-Level Fields` | *(empty)* | Name/value pairs added to every document. Values support n8n expressions, so you can pipe per-item context (`{{$json.account_id}}`, `{{$json.pipeline_id}}`, …). Lets you filter at search time and supports multi-tenant indexes |

### 2. Get Many

Embed a prompt and return the top-k ranked documents with their similarity scores on the Main output. Handy for debugging or building custom flows that don't need a full retriever chain.

### 3. Retrieve Documents (As Vector Store for Chain/Tool)

Provides the vector store on the `ai_vectorStore` output, so you can plug it into a `Vector Store Retriever`, `Question and Answer Chain`, or other LangChain-style nodes.

### 4. Retrieve Documents (As Tool for AI Agent)

Wraps the vector store in a LangChain `DynamicTool` so an AI Agent can call it. Set the tool **Name** and **Description** carefully — the agent uses the description to decide when to invoke it.

---

## Usage patterns

### RAG ingestion

```
Trigger → Source (HTTP / Drive / DB / …)
              ↓
       Default Data Loader  ──┐
                              ├──→  Elasticsearch Vector Store [Insert Documents]
       Embeddings  ───────────┘
```

### Q&A chain

```
Chat Trigger
     ↓
Question and Answer Chain
     │ (Retriever)
     ↓
Vector Store Retriever
     │ (Vector Store)
     ↓
Elasticsearch Vector Store [Retrieve as Vector Store]
     ↑
Embeddings
```

### AI Agent with vector store as a tool

```
AI Agent
   │ (Tools)
   ↓
Elasticsearch Vector Store [Retrieve as Tool]
   ↑
Embeddings

Name:        company_kb
Description: Useful for answering questions about <your data>.
             Always use this when the user asks about <topic>.
```

---

## Notes & gotchas

- **Embedding dimension is fixed at index creation.** Switching embedding models later (e.g. 1536-dim → 768-dim) will trigger a mismatch error. Either use a fresh index name or enable **Clear Index Before Insert**.
- **Index names** must be lowercase, no spaces — this is enforced by Elasticsearch itself.
- **API Key**: paste the `encoded` value from the `POST /_security/api_key` response, not the `ApiKey <encoded>` HTTP header form.
- **Hybrid search & ELSER**: the underlying `ElasticVectorSearch` class supports hybrid (BM25 + kNN) and ELSER sparse vectors, but those config knobs aren't exposed in the UI yet — PRs welcome.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  VectorStoreElasticsearch.node.ts                    │
│                                                      │
│  description.inputs/outputs   ←  dynamic by mode     │
│                                                      │
│  execute()        →  insert / load                   │
│  supplyData()     →  retrieve / retrieve-as-tool     │
│        │                                             │
│        ▼                                             │
│  buildVectorStore()                                  │
│    ├─ getCredentials → @elastic/elasticsearch Client │
│    ├─ getInputConnectionData(AiEmbedding)            │
│    └─ new ElasticVectorSearch(embeddings, {client})  │
└──────────────────────────────────────────────────────┘
```

A fresh Elasticsearch client is created per workflow execution — no long-lived connections are held between runs. This matches the lifecycle pattern of n8n's official PGVector node.

---

## Development

```bash
npm install
npm run dev        # TypeScript watch mode
npm run lint       # ESLint (n8n-nodes-base rules)
npm run build      # rimraf dist && tsc && gulp build:icons
```

The compiled output goes to `dist/`. The `n8n` block in `package.json` points n8n at the built node and credential files.

---

## Compatibility

- **n8n**: `>= 1.0` (any version exposing `n8n-workflow` and the LangChain integration nodes)
- **Elasticsearch**: 8.x (uses the `@elastic/elasticsearch` v8 client and `dense_vector` HNSW indexing)
- **Node.js**: 20.x or newer (matches n8n's runtime)

---

## Issues & contributions

Bug reports and feature requests: <https://github.com/FeizNouri/n8n-nodes-elasticsearch-vector-store/issues>

Pull requests are welcome — please run `npm run lint` and `npm run build` before submitting.

---

## Maintained by

<p>
  <a href="https://www.hurence.com">
    <strong>Hurence</strong>
  </a>
  — a data engineering and AI company building production-grade data platforms.
</p>

This package is developed and maintained by **[Hurence](https://www.hurence.com)** and authored by [Feiz Nouri](https://feiznouri.ovh).

If your team is using this node in production and needs custom features, hybrid search, ELSER support, or commercial support around Elasticsearch + n8n + LLM pipelines, get in touch via [hurence.com](https://www.hurence.com).

---

## License

[MIT](./LICENSE.md)
