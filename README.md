# n8n-nodes-elasticsearch-vector-store

An n8n community node that turns Elasticsearch into a first-class **LangChain vector store** — equivalent to the official `Postgres PGVector Store` node, but for Elasticsearch.

Supports the same four operation modes as the official vector store nodes:

- **Get Many** — embed a prompt and return ranked similar documents
- **Insert Documents** — embed and store documents (typically from a Document Loader sub-node)
- **Retrieve Documents (As Vector Store for Chain/Tool)** — provide the vector store to a `Vector Store Retriever` or `Question and Answer Chain`
- **Retrieve Documents (As Tool for AI Agent)** — expose the vector store as a tool an AI Agent can call

Built on `@langchain/community`'s `ElasticVectorSearch` (the same class `langchain-elasticsearch` wraps), so it speaks Elasticsearch's native kNN/HNSW search.

---

## 1. Build the package

```bash
git clone <this-repo> n8n-nodes-elasticsearch-vector-store
cd n8n-nodes-elasticsearch-vector-store
npm install
npm run build
```

This produces a `dist/` folder that n8n can load.

## 2. Install into your self-hosted n8n

You have two options.

### Option A — Install from your local checkout (fastest for testing)

```bash
# Inside the package directory
npm link

# Then in your n8n custom nodes directory (default: ~/.n8n/custom)
mkdir -p ~/.n8n/custom
cd ~/.n8n/custom
npm init -y       # if not already initialized
npm link n8n-nodes-elasticsearch-vector-store
```

Restart n8n. The node will appear as **"Elasticsearch Vector Store"** in the AI > Vector Stores section.

### Option B — Install via the n8n UI (after publishing to npm)

1. Publish the package to npm: `npm publish` (after updating `name`, `repository`, and `author` in `package.json`)
2. In n8n: **Settings → Community Nodes → Install** → enter `n8n-nodes-elasticsearch-vector-store` → Install

> ⚠️ Installing community nodes via the UI is disabled by default on Docker. Set `N8N_COMMUNITY_PACKAGES_ENABLED=true` and `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` in your environment.

### Option C — Self-hosted Docker

Mount the built `dist/` folder into the container's custom directory:

```yaml
# docker-compose.yml fragment
services:
  n8n:
    volumes:
      - ./n8n-nodes-elasticsearch-vector-store:/home/node/.n8n/custom/n8n-nodes-elasticsearch-vector-store
```

Then `cd /home/node/.n8n/custom && npm install ./n8n-nodes-elasticsearch-vector-store` inside the container, and restart.

---

## 3. Configure credentials

In n8n: **Credentials → New → Elasticsearch Vector Store API**.

- **Base URL** — `http://elasticsearch:9200` (or your real URL)
- **Authentication** — Basic Auth, API Key, or None
- **Ignore SSL Issues** — toggle on for self-signed certs in dev

The credential is used by both the ES client (for index management and bulk insert) and by the LangChain wrapper (for kNN search).

---

## 4. Usage patterns

### A. Indexing a document (RAG ingestion)

```
Manual Trigger → HTTP Request (or any source)
                       ↓
              Default Data Loader  ──┐
                                      ├──→  Elasticsearch Vector Store [mode: Insert Documents]
              Embeddings (OpenAI/Gemini/etc.)  ──┘
```

Set the Vector Store node to **Insert Documents** mode and give it an index name like `my-knowledge`. The index is auto-created on first insert with the right `dense_vector` mapping.

### B. RAG question-answering chain

```
Chat Trigger
     ↓
Question and Answer Chain
     │ (Retriever)
     ↓
Vector Store Retriever
     │ (Vector Store)
     ↓
Elasticsearch Vector Store [mode: Retrieve Documents (As Vector Store for Chain/Tool)]
                            ↑
                      Embeddings
```

### C. AI Agent with vector store as a tool

```
AI Agent
   │ (Tools)
   ↓
Elasticsearch Vector Store [mode: Retrieve Documents (As Tool for AI Agent)]
                            ↑
                      Embeddings

Set:
  Name:        company_kb
  Description: Useful for answering questions about <your data>.
                Always use this when the user asks about <topic>.
```

### D. Direct similarity search (no agent)

Use **Get Many** mode and feed a prompt — the node returns ranked documents with similarity scores in normal Main output. Handy for debugging your embeddings or building custom flows.

---

## 5. Notes & gotchas

- **Embedding dimension**: Elasticsearch's `dense_vector` field is created on the first insert based on the embeddings sub-node's output dimension. If you switch embedding models later (e.g. 1536-dim → 768-dim), you'll get a dimension mismatch error. Use a fresh index name, or enable **Clear Index Before Insert** in the options.
- **Index naming**: Use lowercase, no spaces. Elasticsearch enforces this.
- **API Key auth**: Paste the base64-encoded `id:api_key` value (the `encoded` field from the `POST /_security/api_key` response), not `ApiKey <encoded>`.
- **Hybrid search and ELSER**: `ElasticVectorSearch` from `@langchain/community` uses straightforward kNN. If you need hybrid (BM25 + kNN) or ELSER sparse vectors, the underlying class supports it but the n8n UI fields here don't expose it yet — extend `buildVectorStore` to pass extra config.

---

## 6. Architecture (for the curious)

```
┌──────────────────────────────────────────────────────┐
│  VectorStoreElasticsearch.node.ts                    │
│                                                      │
│  description.inputs/outputs   ←  dynamic by mode     │
│                                                      │
│  execute()        →  insert / load                   │
│  supplyData()     →  retrieve / retrieve-as-tool     │
│                                                      │
│        │                                             │
│        ▼                                             │
│  buildVectorStore()                                  │
│    ├─ getCredentials → @elastic/elasticsearch Client │
│    ├─ getInputConnectionData(AiEmbedding)            │
│    └─ new ElasticVectorSearch(embeddings, {client})  │
└──────────────────────────────────────────────────────┘
```

The node never holds connections between executions — a fresh ES client is created per run, matching how n8n's official PGVector node handles connection lifecycle.

## License

MIT
