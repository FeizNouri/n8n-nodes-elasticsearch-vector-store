/**
 * Integration tests against a real Elasticsearch 8.x cluster.
 *
 * Skipped entirely unless ES_TEST_URL is set. Never part of `npm test`.
 *
 *   ES_TEST_URL=http://localhost:9200 npm run test:integration
 *
 * Optional: ES_TEST_USERNAME / ES_TEST_PASSWORD for basic auth.
 */
import { Client } from '@elastic/elasticsearch';
import { Document } from '@langchain/core/documents';
import { ElasticVectorSearch } from '../../src/vectorstore/ElasticVectorSearch';
import { FakeEmbeddings } from '../unit/helpers';

const url = process.env.ES_TEST_URL;
const describeIf = url ? describe : describe.skip;

describeIf('ElasticVectorSearch against a real Elasticsearch', () => {
	const indexName = `evs-int-test-${Date.now()}`;
	let client: Client;
	let store: ElasticVectorSearch;
	const embeddings = new FakeEmbeddings(4);

	beforeAll(() => {
		client = new Client({
			node: url as string,
			...(process.env.ES_TEST_USERNAME
				? {
						auth: {
							username: process.env.ES_TEST_USERNAME,
							password: process.env.ES_TEST_PASSWORD ?? '',
						},
					}
				: {}),
		});
		store = new ElasticVectorSearch(embeddings, { client, indexName });
	});

	afterAll(async () => {
		try {
			await client.indices.delete({ index: indexName });
		} catch {
			// index may not exist if a test failed before creation
		}
		await client.close();
	});

	it('auto-creates the index and inserts documents', async () => {
		const ids = await store.addDocuments([
			new Document({ pageContent: 'alpha', metadata: { source: 'one', tenant: 't1' } }),
			new Document({ pageContent: 'bravo charlie', metadata: { source: 'two', tenant: 't1' } }),
			new Document({ pageContent: 'delta echo foxtrot', metadata: { source: 'three', tenant: 't2' } }),
		]);
		expect(ids).toHaveLength(3);

		const mapping = await client.indices.getMapping({ index: indexName });
		const props = mapping[indexName].mappings.properties as Record<string, { type?: string }>;
		expect(props.embedding.type).toBe('dense_vector');
		expect(props.text.type).toBe('text');
	});

	it('finds similar documents with raw positive scores', async () => {
		const results = await store.similaritySearchWithScore('alpha', 2);
		expect(results).toHaveLength(2);
		for (const [doc, score] of results) {
			expect(typeof doc.pageContent).toBe('string');
			expect(score).toBeGreaterThan(0);
			expect(score).toBeLessThanOrEqual(1); // l2_norm scores live in (0, 1]
		}
		// identical text embeds to the identical vector -> exact match ranks first
		expect(results[0][0].pageContent).toBe('alpha');
	});

	it('applies metadata filters', async () => {
		const results = await store.similaritySearchWithScore('alpha', 3, { tenant: 't2' });
		expect(results).toHaveLength(1);
		expect(results[0][0].metadata.tenant).toBe('t2');
	});

	it('deletes documents by ID', async () => {
		const [id] = await store.addDocuments([
			new Document({ pageContent: 'to be deleted', metadata: {} }),
		]);
		await store.delete({ ids: [id] });
		const results = await store.similaritySearchWithScore('to be deleted', 10);
		expect(results.every(([doc]) => doc.pageContent !== 'to be deleted')).toBe(true);
	});

	it('fromExistingIndex works against the created index', async () => {
		await expect(
			ElasticVectorSearch.fromExistingIndex(embeddings, { client, indexName }),
		).resolves.toBeInstanceOf(ElasticVectorSearch);
	});
});
