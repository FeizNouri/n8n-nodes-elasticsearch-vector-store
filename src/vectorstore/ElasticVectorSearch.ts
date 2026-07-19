import { randomUUID } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import { Document } from '@langchain/core/documents';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';

/**
 * Drop-in replacement for `@langchain/community`'s ElasticVectorSearch
 * (behavior replicated from v0.3.59), maintained here so the package's only
 * runtime dependencies are `@langchain/core` and `@elastic/elasticsearch`.
 * `@langchain/community` declares ~200 optional peer dependencies which make
 * `npm install` fail with ERESOLVE under n8n's community-node installer.
 *
 * Behavioral parity notes (do not change without a major-version bump):
 * - Scores returned by searches are Elasticsearch's raw kNN `_score`,
 *   completely unconverted. ES 8 computes:
 *     cosine:      (1 + cosine(query, vector)) / 2         -> (0, 1]
 *     l2_norm:     1 / (1 + l2_norm(query, vector)^2)      -> (0, 1]
 *     dot_product: (1 + dot_product(query, vector)) / 2    (unit-length vectors)
 *   Higher is always more similar. User workflows have relevance thresholds
 *   tuned against these raw values.
 * - Auto-created indices default to `l2_norm` similarity with HNSW options
 *   (m 16, ef_construction 100) and a dynamic template mapping `metadata.*`
 *   to `keyword` (except `metadata.loc`), exactly like the community class.
 * - Documents are stored as `{ embedding, metadata, text }` in `_source`;
 *   searches rebuild results from `_source.text` + `_source.metadata` only,
 *   so any extra top-level fields are stored but not returned.
 *
 * Deliberate deviations (invisible to workflows):
 * - Bulk errors are aggregated per failed item instead of joining every
 *   item's (mostly undefined) reason.
 * - Index creation tolerates `resource_already_exists_exception` so
 *   concurrent inserts cannot race the exists/create check.
 * - IDs come from node:crypto randomUUID() instead of the uuid package.
 * - The injected client is used as-is (no `.child()` user-agent wrapper).
 *
 * Additive extensions (not in the community class):
 * - Filter conditions accept `topLevel: true` to target top-level document
 *   fields (e.g. the node's Custom Top-Level Fields) instead of `metadata.*`.
 * - `defaultFilter` in the constructor config applies to any search that
 *   does not pass its own filter — used by the node's Search Filters option
 *   so filters also apply when n8n drives the store through a retriever.
 */

type ElasticKnnEngine = 'hnsw';
export type ElasticSimilarity = 'l2_norm' | 'dot_product' | 'cosine';

interface VectorSearchOptions {
	readonly engine?: ElasticKnnEngine;
	readonly similarity?: ElasticSimilarity;
	readonly m?: number;
	readonly efConstruction?: number;
	readonly candidates?: number;
}

export interface ElasticClientArgs {
	readonly client: Client;
	readonly indexName?: string;
	readonly vectorSearchOptions?: VectorSearchOptions;
	readonly defaultFilter?: ElasticFilter;
}

export interface ElasticFilterCondition {
	field: string;
	operator: string;
	value?: unknown;
	/** Match against the field at the top level of `_source` instead of under `metadata.` */
	topLevel?: boolean;
}

export type ElasticFilter = Record<string, unknown> | ElasticFilterCondition[];

interface ElasticDocSource {
	text: string;
	metadata: Record<string, unknown>;
}

interface BoolClauses {
	must: object[];
	must_not: object[];
	should?: object[];
	minimum_should_match?: number;
}

export class ElasticVectorSearch extends VectorStore {
	declare FilterType: ElasticFilter;

	private readonly client: Client;

	private readonly indexName: string;

	private readonly engine: ElasticKnnEngine;

	private readonly similarity: ElasticSimilarity;

	private readonly efConstruction: number;

	private readonly m: number;

	private readonly candidates: number;

	private readonly defaultFilter?: ElasticFilter;

	_vectorstoreType(): string {
		return 'elasticsearch';
	}

	constructor(embeddings: EmbeddingsInterface, args: ElasticClientArgs) {
		super(embeddings, args);
		this.engine = args.vectorSearchOptions?.engine ?? 'hnsw';
		this.similarity = args.vectorSearchOptions?.similarity ?? 'l2_norm';
		this.m = args.vectorSearchOptions?.m ?? 16;
		this.efConstruction = args.vectorSearchOptions?.efConstruction ?? 100;
		this.candidates = args.vectorSearchOptions?.candidates ?? 200;
		this.client = args.client;
		this.indexName = args.indexName ?? 'documents';
		this.defaultFilter = args.defaultFilter;
	}

	async addDocuments(documents: Document[], options?: { ids?: string[] }): Promise<string[]> {
		const texts = documents.map(({ pageContent }) => pageContent);
		return await this.addVectors(await this.embeddings.embedDocuments(texts), documents, options);
	}

	async addVectors(
		vectors: number[][],
		documents: Document[],
		options?: { ids?: string[] },
	): Promise<string[]> {
		if (vectors.length === 0) return [];
		await this.ensureIndexExists(vectors[0].length);

		const documentIds = options?.ids ?? Array.from({ length: vectors.length }, () => randomUUID());
		const operations = vectors.flatMap((embedding, idx) => [
			{ index: { _id: documentIds[idx], _index: this.indexName } },
			{
				embedding,
				metadata: documents[idx].metadata,
				text: documents[idx].pageContent,
			},
		]);

		const results = await this.client.bulk({ refresh: true, operations });
		if (results.errors) {
			const failures = results.items.flatMap((item, position) => {
				const error = item.index?.error;
				return error ? [{ position, id: item.index?._id, error }] : [];
			});
			const details = failures
				.map((f) => `  - document ${f.position} (_id: ${f.id}): [${f.error.type}] ${f.error.reason}`)
				.join('\n');
			throw new Error(
				`Elasticsearch bulk insert failed for ${failures.length} of ${results.items.length} document(s):\n${details}`,
			);
		}
		return documentIds;
	}

	async similaritySearchVectorWithScore(
		query: number[],
		k: number,
		filter?: ElasticFilter,
	): Promise<[Document, number][]> {
		const result = await this.client.search<ElasticDocSource>({
			index: this.indexName,
			size: k,
			knn: {
				field: 'embedding',
				query_vector: query,
				filter: { bool: this.buildFilterClauses(filter ?? this.defaultFilter) },
				k,
				num_candidates: this.candidates,
			},
		});

		// hit._score is returned untouched — see the parity notes at the top.
		return result.hits.hits.map((hit) => [
			new Document({
				pageContent: hit._source?.text ?? '',
				metadata: hit._source?.metadata ?? {},
			}),
			hit._score as number,
		]);
	}

	async delete(params: { ids: string[] }): Promise<void> {
		const operations = params.ids.map((id) => ({
			delete: { _id: id, _index: this.indexName },
		}));
		if (operations.length > 0) await this.client.bulk({ refresh: true, operations });
	}

	static async fromTexts(
		texts: string[],
		metadatas: object[] | object,
		embeddings: EmbeddingsInterface,
		args: ElasticClientArgs,
	): Promise<ElasticVectorSearch> {
		const documents = texts.map((text, idx) => {
			const metadata = Array.isArray(metadatas) ? metadatas[idx] : metadatas;
			return new Document({ pageContent: text, metadata });
		});
		return await ElasticVectorSearch.fromDocuments(documents, embeddings, args);
	}

	static async fromDocuments(
		docs: Document[],
		embeddings: EmbeddingsInterface,
		dbConfig: ElasticClientArgs,
	): Promise<ElasticVectorSearch> {
		const store = new ElasticVectorSearch(embeddings, dbConfig);
		await store.addDocuments(docs);
		return store;
	}

	static async fromExistingIndex(
		embeddings: EmbeddingsInterface,
		dbConfig: ElasticClientArgs,
	): Promise<ElasticVectorSearch> {
		const store = new ElasticVectorSearch(embeddings, dbConfig);
		const exists = await store.doesIndexExist();
		if (exists) {
			return store;
		}
		throw new Error(`The index ${store.indexName} does not exist.`);
	}

	async doesIndexExist(): Promise<boolean> {
		return await this.client.indices.exists({ index: this.indexName });
	}

	async deleteIfExists(): Promise<void> {
		const indexExists = await this.doesIndexExist();
		if (!indexExists) return;
		await this.client.indices.delete({ index: this.indexName });
	}

	private async ensureIndexExists(dimension: number): Promise<void> {
		const indexExists = await this.doesIndexExist();
		if (indexExists) return;

		try {
			await this.client.indices.create({
				index: this.indexName,
				mappings: {
					dynamic_templates: [
						{
							// map all metadata properties to be keyword except loc
							metadata_except_loc: {
								match_mapping_type: '*',
								match: 'metadata.*',
								unmatch: 'metadata.loc',
								mapping: { type: 'keyword' },
							},
						},
					],
					properties: {
						text: { type: 'text' },
						metadata: {
							type: 'object',
							properties: {
								loc: { type: 'object' },
							},
						},
						embedding: {
							type: 'dense_vector',
							dims: dimension,
							index: true,
							similarity: this.similarity,
							index_options: {
								type: this.engine,
								m: this.m,
								ef_construction: this.efConstruction,
							},
						},
					},
				},
			});
		} catch (err) {
			// A concurrent insert may have created the index between the exists
			// check and the create call — that outcome is exactly what we wanted.
			const error = err as { meta?: { body?: { error?: { type?: string } } } };
			if (error?.meta?.body?.error?.type === 'resource_already_exists_exception') return;
			throw err;
		}
	}

	private buildFilterClauses(filter?: ElasticFilter): BoolClauses {
		if (filter == null) return { must: [], must_not: [] };

		const conditions: ElasticFilterCondition[] = Array.isArray(filter)
			? filter
			: Object.entries(filter).map(([field, value]) => ({ operator: 'term', field, value }));

		const must: object[] = [];
		const must_not: object[] = [];
		const should: object[] = [];

		for (const condition of conditions) {
			const fieldPath = condition.topLevel ? condition.field : `metadata.${condition.field}`;
			if (condition.operator === 'exists') {
				must.push({ exists: { field: fieldPath } });
			} else if (condition.operator === 'not_exists') {
				must_not.push({ exists: { field: fieldPath } });
			} else if (condition.operator === 'exclude') {
				const toExclude = { [fieldPath]: condition.value };
				must_not.push(Array.isArray(condition.value) ? { terms: toExclude } : { term: toExclude });
			} else if (condition.operator === 'or') {
				should.push({ term: { [fieldPath]: condition.value } });
			} else {
				must.push({ [condition.operator]: { [fieldPath]: condition.value } });
			}
		}

		const result: BoolClauses = { must, must_not };
		if (should.length > 0) {
			result.should = should;
			result.minimum_should_match = 1;
		}
		return result;
	}
}
