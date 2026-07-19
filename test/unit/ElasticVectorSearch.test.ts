import { Document } from '@langchain/core/documents';
import { ElasticVectorSearch } from '../../src/vectorstore/ElasticVectorSearch';
import { createMockClient, FakeEmbeddings, searchHit } from './helpers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const communityMapping = (dims: number, similarity = 'l2_norm') => ({
	index: 'test-index',
	mappings: {
		dynamic_templates: [
			{
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
			metadata: { type: 'object', properties: { loc: { type: 'object' } } },
			embedding: {
				type: 'dense_vector',
				dims,
				index: true,
				similarity,
				index_options: { type: 'hnsw', m: 16, ef_construction: 100 },
			},
		},
	},
});

function makeStore(
	client = createMockClient(),
	config: Record<string, unknown> = {},
	embeddings = new FakeEmbeddings(),
) {
	return {
		client,
		embeddings,
		store: new ElasticVectorSearch(embeddings, { client, indexName: 'test-index', ...config }),
	};
}

describe('ElasticVectorSearch', () => {
	describe('addDocuments / addVectors', () => {
		const docs = [
			new Document({ pageContent: 'hello', metadata: { source: 'a' } }),
			new Document({ pageContent: 'world!!', metadata: { source: 'b' } }),
		];

		it('embeds documents and bulk-indexes them with generated UUIDs', async () => {
			const { client, store, embeddings } = makeStore();
			const ids = await store.addDocuments(docs);

			expect(ids).toHaveLength(2);
			for (const id of ids) expect(id).toMatch(UUID_RE);

			expect(client.bulk).toHaveBeenCalledTimes(1);
			const { refresh, operations } = client.bulk.mock.calls[0][0];
			expect(refresh).toBe(true);
			expect(operations).toEqual([
				{ index: { _id: ids[0], _index: 'test-index' } },
				{ embedding: embeddings.vectorFor('hello'), metadata: { source: 'a' }, text: 'hello' },
				{ index: { _id: ids[1], _index: 'test-index' } },
				{ embedding: embeddings.vectorFor('world!!'), metadata: { source: 'b' }, text: 'world!!' },
			]);
		});

		it('uses caller-provided IDs when given', async () => {
			const { client, store } = makeStore();
			const ids = await store.addDocuments(docs, { ids: ['id-1', 'id-2'] });
			expect(ids).toEqual(['id-1', 'id-2']);
			const { operations } = client.bulk.mock.calls[0][0];
			expect(operations[0]).toEqual({ index: { _id: 'id-1', _index: 'test-index' } });
		});

		it('returns [] for empty input without touching the client', async () => {
			const { client, store } = makeStore();
			await expect(store.addDocuments([])).resolves.toEqual([]);
			expect(client.bulk).not.toHaveBeenCalled();
			expect(client.indices.exists).not.toHaveBeenCalled();
		});

		it('accepts plain objects with pageContent/metadata (no instanceof checks)', async () => {
			const { client, store } = makeStore();
			const foreign = { pageContent: 'duck', metadata: { source: 'typed' } } as Document;
			await store.addDocuments([foreign]);
			const { operations } = client.bulk.mock.calls[0][0];
			expect(operations[1]).toMatchObject({ text: 'duck', metadata: { source: 'typed' } });
		});

		it('throws an aggregated error listing only the failed bulk items', async () => {
			const client = createMockClient();
			client.bulk.mockResolvedValue({
				errors: true,
				items: [
					{ index: { _id: 'ok-id', status: 201 } },
					{
						index: {
							_id: 'bad-id',
							status: 400,
							error: { type: 'mapper_parsing_exception', reason: 'failed to parse field' },
						},
					},
					{ index: { _id: 'ok-id-2', status: 201 } },
				],
			});
			const { store } = makeStore(client);

			await expect(store.addDocuments(docs)).rejects.toThrow(
				/1 of 3 document\(s\)[\s\S]*bad-id[\s\S]*mapper_parsing_exception[\s\S]*failed to parse field/,
			);
		});
	});

	describe('index auto-creation', () => {
		const doc = [new Document({ pageContent: 'abc', metadata: {} })];

		it('creates the index with the community-parity mapping when absent', async () => {
			const client = createMockClient();
			client.indices.exists.mockResolvedValue(false);
			const { store } = makeStore(client);

			await store.addDocuments(doc);
			expect(client.indices.create).toHaveBeenCalledWith(communityMapping(3));
		});

		it('skips creation when the index exists', async () => {
			const { client, store } = makeStore();
			await store.addDocuments(doc);
			expect(client.indices.create).not.toHaveBeenCalled();
		});

		it('honors similarity/engine overrides from vectorSearchOptions', async () => {
			const client = createMockClient();
			client.indices.exists.mockResolvedValue(false);
			const { store } = makeStore(client, { vectorSearchOptions: { similarity: 'cosine' } });

			await store.addDocuments(doc);
			expect(client.indices.create).toHaveBeenCalledWith(communityMapping(3, 'cosine'));
		});

		it('tolerates a concurrent create (resource_already_exists_exception)', async () => {
			const client = createMockClient();
			client.indices.exists.mockResolvedValue(false);
			client.indices.create.mockRejectedValue({
				meta: { body: { error: { type: 'resource_already_exists_exception' } } },
			});
			const { store } = makeStore(client);

			await expect(store.addDocuments(doc)).resolves.toHaveLength(1);
			expect(client.bulk).toHaveBeenCalled();
		});

		it('rethrows other index-creation failures', async () => {
			const client = createMockClient();
			client.indices.exists.mockResolvedValue(false);
			client.indices.create.mockRejectedValue({
				meta: { body: { error: { type: 'security_exception' } } },
			});
			const { store } = makeStore(client);

			await expect(store.addDocuments(doc)).rejects.toMatchObject({
				meta: { body: { error: { type: 'security_exception' } } },
			});
			expect(client.bulk).not.toHaveBeenCalled();
		});
	});

	describe('similaritySearchVectorWithScore', () => {
		it('sends the exact community-parity kNN request and passes scores through raw', async () => {
			const client = createMockClient();
			client.search.mockResolvedValue({
				hits: {
					hits: [
						searchHit('first', { source: 'a' }, 0.9231),
						searchHit('second', { source: 'b' }, 0.0417),
					],
				},
			});
			const { store } = makeStore(client);

			const results = await store.similaritySearchVectorWithScore([0.1, 0.2, 0.3], 4);

			expect(client.search).toHaveBeenCalledWith({
				index: 'test-index',
				size: 4,
				knn: {
					field: 'embedding',
					query_vector: [0.1, 0.2, 0.3],
					filter: { bool: { must: [], must_not: [] } },
					k: 4,
					num_candidates: 200,
				},
			});
			// Raw ES _score, no conversion — user thresholds depend on this
			expect(results).toEqual([
				[new Document({ pageContent: 'first', metadata: { source: 'a' } }), 0.9231],
				[new Document({ pageContent: 'second', metadata: { source: 'b' } }), 0.0417],
			]);
		});

		it('honors a custom num_candidates', async () => {
			const client = createMockClient();
			const { store } = makeStore(client, { vectorSearchOptions: { candidates: 500 } });
			await store.similaritySearchVectorWithScore([1], 2);
			expect(client.search.mock.calls[0][0].knn.num_candidates).toBe(500);
		});

		it('translates object filters into metadata term clauses', async () => {
			const { client, store } = makeStore();
			await store.similaritySearchVectorWithScore([1], 2, { source: 'a', page: 3 });
			expect(client.search.mock.calls[0][0].knn.filter).toEqual({
				bool: {
					must: [{ term: { 'metadata.source': 'a' } }, { term: { 'metadata.page': 3 } }],
					must_not: [],
				},
			});
		});

		it('supports the full array filter grammar', async () => {
			const { client, store } = makeStore();
			await store.similaritySearchVectorWithScore([1], 2, [
				{ operator: 'term', field: 'source', value: 'a' },
				{ operator: 'exists', field: 'page' },
				{ operator: 'not_exists', field: 'draft' },
				{ operator: 'exclude', field: 'lang', value: ['de', 'fr'] },
				{ operator: 'exclude', field: 'kind', value: 'note' },
				{ operator: 'or', field: 'team', value: 'x' },
				{ operator: 'or', field: 'team', value: 'y' },
			]);
			expect(client.search.mock.calls[0][0].knn.filter).toEqual({
				bool: {
					must: [{ term: { 'metadata.source': 'a' } }, { exists: { field: 'metadata.page' } }],
					must_not: [
						{ exists: { field: 'metadata.draft' } },
						{ terms: { 'metadata.lang': ['de', 'fr'] } },
						{ term: { 'metadata.kind': 'note' } },
					],
					should: [{ term: { 'metadata.team': 'x' } }, { term: { 'metadata.team': 'y' } }],
					minimum_should_match: 1,
				},
			});
		});

		it('targets top-level fields when topLevel is set', async () => {
			const { client, store } = makeStore();
			await store.similaritySearchVectorWithScore([1], 2, [
				{ operator: 'term', field: 'account_id', value: '42', topLevel: true },
			]);
			expect(client.search.mock.calls[0][0].knn.filter).toEqual({
				bool: { must: [{ term: { account_id: '42' } }], must_not: [] },
			});
		});

		it('falls back to defaultFilter when no per-call filter is given', async () => {
			const { client, store } = makeStore(createMockClient(), {
				defaultFilter: [{ operator: 'term', field: 'tenant', value: 't1', topLevel: true }],
			});
			await store.similaritySearchVectorWithScore([1], 2);
			expect(client.search.mock.calls[0][0].knn.filter).toEqual({
				bool: { must: [{ term: { tenant: 't1' } }], must_not: [] },
			});

			// an explicit per-call filter takes precedence
			await store.similaritySearchVectorWithScore([1], 2, { source: 'a' });
			expect(client.search.mock.calls[1][0].knn.filter).toEqual({
				bool: { must: [{ term: { 'metadata.source': 'a' } }], must_not: [] },
			});
		});
	});

	describe('base-class integration', () => {
		it('similaritySearchWithScore embeds the query and returns scored documents', async () => {
			const client = createMockClient();
			client.search.mockResolvedValue({ hits: { hits: [searchHit('doc', {}, 0.5)] } });
			const embeddings = new FakeEmbeddings();
			const { store } = makeStore(client, {}, embeddings);

			const results = await store.similaritySearchWithScore('my query', 7);

			expect(client.search.mock.calls[0][0].knn.query_vector).toEqual(
				embeddings.vectorFor('my query'),
			);
			expect(client.search.mock.calls[0][0].knn.k).toBe(7);
			expect(results).toEqual([[new Document({ pageContent: 'doc', metadata: {} }), 0.5]]);
		});

		it('asRetriever drives searches through the vendored implementation', async () => {
			const client = createMockClient();
			client.search.mockResolvedValue({ hits: { hits: [searchHit('retrieved', {}, 0.7)] } });
			const { store } = makeStore(client);

			const docs = await store.asRetriever(3).invoke('question');
			expect(docs).toEqual([new Document({ pageContent: 'retrieved', metadata: {} })]);
			expect(client.search.mock.calls[0][0].knn.k).toBe(3);
		});
	});

	describe('delete', () => {
		it('bulk-deletes by ID with refresh', async () => {
			const { client, store } = makeStore();
			await store.delete({ ids: ['a', 'b'] });
			expect(client.bulk).toHaveBeenCalledWith({
				refresh: true,
				operations: [
					{ delete: { _id: 'a', _index: 'test-index' } },
					{ delete: { _id: 'b', _index: 'test-index' } },
				],
			});
		});

		it('does nothing for an empty ID list', async () => {
			const { client, store } = makeStore();
			await store.delete({ ids: [] });
			expect(client.bulk).not.toHaveBeenCalled();
		});
	});

	describe('static factories and index helpers', () => {
		it('fromDocuments builds a store and inserts the documents', async () => {
			const client = createMockClient();
			const store = await ElasticVectorSearch.fromDocuments(
				[new Document({ pageContent: 'x', metadata: {} })],
				new FakeEmbeddings(),
				{ client, indexName: 'test-index' },
			);
			expect(store).toBeInstanceOf(ElasticVectorSearch);
			expect(client.bulk).toHaveBeenCalledTimes(1);
		});

		it('fromTexts zips texts with per-document or shared metadata', async () => {
			const client = createMockClient();
			await ElasticVectorSearch.fromTexts(
				['one', 'two'],
				[{ n: 1 }, { n: 2 }],
				new FakeEmbeddings(),
				{ client, indexName: 'test-index' },
			);
			const { operations } = client.bulk.mock.calls[0][0];
			expect(operations[1]).toMatchObject({ text: 'one', metadata: { n: 1 } });
			expect(operations[3]).toMatchObject({ text: 'two', metadata: { n: 2 } });
		});

		it('fromExistingIndex resolves when the index exists and throws when it does not', async () => {
			const client = createMockClient();
			await expect(
				ElasticVectorSearch.fromExistingIndex(new FakeEmbeddings(), {
					client,
					indexName: 'test-index',
				}),
			).resolves.toBeInstanceOf(ElasticVectorSearch);

			client.indices.exists.mockResolvedValue(false);
			await expect(
				ElasticVectorSearch.fromExistingIndex(new FakeEmbeddings(), {
					client,
					indexName: 'test-index',
				}),
			).rejects.toThrow('The index test-index does not exist.');
		});

		it('deleteIfExists only deletes when the index is present', async () => {
			const { client, store } = makeStore();
			await store.deleteIfExists();
			expect(client.indices.delete).toHaveBeenCalledWith({ index: 'test-index' });

			client.indices.delete.mockClear();
			client.indices.exists.mockResolvedValue(false);
			await store.deleteIfExists();
			expect(client.indices.delete).not.toHaveBeenCalled();
		});
	});
});
