import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { IExecuteFunctions, INodeExecutionData, ISupplyDataFunctions } from 'n8n-workflow';
import { Document } from '@langchain/core/documents';
import { VectorStoreElasticsearch } from '../../src/nodes/VectorStoreElasticsearch/VectorStoreElasticsearch.node';
import { ElasticVectorSearch } from '../../src/vectorstore/ElasticVectorSearch';
import { createMockClient, FakeEmbeddings, searchHit, type MockClient } from './helpers';

let mockClientInstance: MockClient;

jest.mock('@elastic/elasticsearch', () => ({
	Client: jest.fn().mockImplementation(() => mockClientInstance),
}));

type ParamValue = unknown | ((itemIndex: number) => unknown);

interface ContextConfig {
	params: Record<string, ParamValue>;
	items?: INodeExecutionData[];
	embeddings?: FakeEmbeddings | null;
	documentInput?: unknown;
}

function createContext({
	params,
	items = [{ json: {} }],
	embeddings = new FakeEmbeddings(),
	documentInput,
}: ContextConfig) {
	return {
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			if (!(name in params)) return fallback;
			const value = params[name];
			return typeof value === 'function' ? (value as (i: number) => unknown)(itemIndex) : value;
		},
		getInputData: () => items,
		getInputConnectionData: async (type: string) => {
			if (type === NodeConnectionTypes.AiEmbedding) return embeddings;
			if (type === NodeConnectionTypes.AiDocument) return documentInput;
			return undefined;
		},
		getCredentials: async () => ({ baseUrl: 'http://localhost:9200', authentication: 'none' }),
		getNode: () => ({ name: 'Elasticsearch Vector Store', type: 'test', typeVersion: 1 }),
	} as unknown as IExecuteFunctions & ISupplyDataFunctions;
}

function loaderFor(docsPerItem: Document[][]) {
	return {
		processItem: async (_item: INodeExecutionData, i: number) => docsPerItem[i] ?? [],
	};
}

const node = new VectorStoreElasticsearch();

beforeEach(() => {
	mockClientInstance = createMockClient();
});

describe('insert mode — raw path (document shape options active)', () => {
	const docsPerItem = [
		[
			new Document({ pageContent: 'chunk-0', metadata: { source: 'f.pdf', pdf: { x: 1 } } }),
			new Document({ pageContent: 'chunk-1', metadata: { source: 'f.pdf', loc: { l: 2 } } }),
		],
		[new Document({ pageContent: 'chunk-2', metadata: { source: 'g.pdf' } })],
	];

	const rawParams = {
		mode: 'insert',
		indexName: 'raw-idx',
		options: { metadataKeep: 'source', addChunkIndex: true },
		'customFields.fields': (i: number) => [{ name: 'account_id', value: `acct-${i}` }],
	};

	it('writes full-shape documents: filtered metadata, chunk_index, per-item custom fields', async () => {
		const ctx = createContext({
			params: rawParams,
			items: [{ json: {} }, { json: {} }],
			documentInput: loaderFor(docsPerItem),
		});
		const embeddings = new FakeEmbeddings();

		const result = await node.execute.call(ctx);

		expect(mockClientInstance.bulk).toHaveBeenCalledTimes(2); // one batch per input item
		const firstOps = mockClientInstance.bulk.mock.calls[0][0].operations;
		expect(firstOps[0]).toEqual({ index: { _index: 'raw-idx' } }); // no client-side _id in raw mode
		expect(firstOps[1]).toEqual({
			text: 'chunk-0',
			embedding: embeddings.vectorFor('chunk-0'),
			metadata: { source: 'f.pdf' }, // pdf.* stripped by the allowlist
			account_id: 'acct-0',
			chunk_index: 0,
		});
		expect(firstOps[3]).toMatchObject({ text: 'chunk-1', chunk_index: 1 });

		const secondOps = mockClientInstance.bulk.mock.calls[1][0].operations;
		expect(secondOps[1]).toMatchObject({
			text: 'chunk-2',
			account_id: 'acct-1', // expression re-evaluated per item
			chunk_index: 0, // chunk numbering restarts per item
		});

		expect(result[0][0].json).toMatchObject({ inserted: 3, indexName: 'raw-idx' });
	});

	it('auto-creates the index with the historical cosine mapping', async () => {
		mockClientInstance.indices.exists.mockResolvedValue(false);
		const ctx = createContext({
			params: rawParams,
			items: [{ json: {} }, { json: {} }],
			documentInput: loaderFor(docsPerItem),
		});

		await node.execute.call(ctx);

		expect(mockClientInstance.indices.create).toHaveBeenCalledWith({
			index: 'raw-idx',
			mappings: {
				properties: {
					text: { type: 'text' },
					embedding: { type: 'dense_vector', dims: 3, index: true, similarity: 'cosine' },
					metadata: { type: 'object', enabled: true },
				},
			},
		});
	});

	it('applies the Similarity Metric override to the raw-mode mapping', async () => {
		mockClientInstance.indices.exists.mockResolvedValue(false);
		const ctx = createContext({
			params: { ...rawParams, options: { metadataKeep: 'source', similarity: 'dot_product' } },
			documentInput: loaderFor([docsPerItem[0]]),
		});

		await node.execute.call(ctx);

		const mapping = mockClientInstance.indices.create.mock.calls[0][0];
		expect(mapping.mappings.properties.embedding.similarity).toBe('dot_product');
	});

	it('splits bulk requests according to Batch Size', async () => {
		const ctx = createContext({
			params: { ...rawParams, options: { metadataKeep: 'source', batchSize: 1 } },
			documentInput: loaderFor([docsPerItem[0]]),
		});

		await node.execute.call(ctx);

		expect(mockClientInstance.bulk).toHaveBeenCalledTimes(2); // 2 docs, batch size 1
	});

	it('surfaces bulk failures as NodeOperationError', async () => {
		mockClientInstance.bulk.mockResolvedValue({
			errors: true,
			items: [{ index: { error: { type: 'mapper_parsing_exception', reason: 'bad field' } } }],
		});
		const ctx = createContext({
			params: rawParams,
			documentInput: loaderFor([docsPerItem[0]]),
		});

		await expect(node.execute.call(ctx)).rejects.toThrow(NodeOperationError);
	});
});

describe('insert mode — default path (ElasticVectorSearch.addDocuments)', () => {
	const documents = [
		new Document({ pageContent: 'aaa', metadata: { s: 1 } }),
		new Document({ pageContent: 'bbb', metadata: { s: 2 } }),
	];
	const defaultParams = { mode: 'insert', indexName: 'default-idx', options: {} };

	it('delegates to the vendored store: UUID _ids and community doc shape', async () => {
		const ctx = createContext({ params: defaultParams, documentInput: documents });

		const result = await node.execute.call(ctx);

		const { operations, refresh } = mockClientInstance.bulk.mock.calls[0][0];
		expect(refresh).toBe(true);
		expect(operations[0].index._index).toBe('default-idx');
		expect(operations[0].index._id).toEqual(expect.any(String)); // default path assigns IDs
		expect(operations[1]).toEqual({
			embedding: new FakeEmbeddings().vectorFor('aaa'),
			metadata: { s: 1 },
			text: 'aaa',
		});
		expect(result[0][0].json).toMatchObject({ inserted: 2 });
	});

	it('auto-creates the index with the community-parity l2_norm mapping', async () => {
		mockClientInstance.indices.exists.mockResolvedValue(false);
		const ctx = createContext({ params: defaultParams, documentInput: documents });

		await node.execute.call(ctx);

		const request = mockClientInstance.indices.create.mock.calls[0][0];
		expect(request.mappings.properties.embedding.similarity).toBe('l2_norm');
		expect(request.mappings.dynamic_templates).toHaveLength(1);
	});

	it('applies the Similarity Metric override to the default-path mapping', async () => {
		mockClientInstance.indices.exists.mockResolvedValue(false);
		const ctx = createContext({
			params: { ...defaultParams, options: { similarity: 'cosine' } },
			documentInput: documents,
		});

		await node.execute.call(ctx);

		const request = mockClientInstance.indices.create.mock.calls[0][0];
		expect(request.mappings.properties.embedding.similarity).toBe('cosine');
	});

	it('clears the index first when Clear Index Before Insert is set, tolerating 404', async () => {
		mockClientInstance.indices.delete.mockRejectedValue({ meta: { statusCode: 404 } });
		const ctx = createContext({
			params: { ...defaultParams, options: { clearIndex: true } },
			documentInput: documents,
		});

		await expect(node.execute.call(ctx)).resolves.toBeDefined();
		expect(mockClientInstance.indices.delete).toHaveBeenCalledWith({ index: 'default-idx' });
	});

	it('fails clearly when no documents are produced', async () => {
		const ctx = createContext({ params: defaultParams, documentInput: [] });
		await expect(node.execute.call(ctx)).rejects.toThrow('No documents to insert');
	});

	it('fails clearly when no embeddings sub-node is connected', async () => {
		const ctx = createContext({ params: defaultParams, embeddings: null, documentInput: documents });
		await expect(node.execute.call(ctx)).rejects.toThrow('No embeddings sub-node connected');
	});
});

describe('load mode (Get Many)', () => {
	const loadParams = {
		mode: 'load',
		indexName: 'search-idx',
		prompt: 'find me things',
		topK: 2,
	};

	it('returns scored documents with raw ES scores', async () => {
		mockClientInstance.search.mockResolvedValue({
			hits: { hits: [searchHit('result-a', { source: 'x' }, 0.87), searchHit('result-b', {}, 0.31)] },
		});
		const ctx = createContext({ params: loadParams });

		const result = await node.execute.call(ctx);

		expect(mockClientInstance.search.mock.calls[0][0]).toMatchObject({
			index: 'search-idx',
			size: 2,
			knn: { k: 2, num_candidates: 200 },
		});
		expect(result[0]).toEqual([
			{
				json: { document: { pageContent: 'result-a', metadata: { source: 'x' } }, score: 0.87 },
				pairedItem: { item: 0 },
			},
			{
				json: { document: { pageContent: 'result-b', metadata: {} }, score: 0.31 },
				pairedItem: { item: 0 },
			},
		]);
	});

	it('omits metadata when Include Metadata is off', async () => {
		mockClientInstance.search.mockResolvedValue({ hits: { hits: [searchHit('r', { m: 1 }, 0.5)] } });
		const ctx = createContext({ params: { ...loadParams, includeMetadata: false } });

		const result = await node.execute.call(ctx);
		expect(result[0][0].json).toEqual({ document: { pageContent: 'r' }, score: 0.5 });
	});

	it('applies Search Filters and Number of Candidates to the kNN request', async () => {
		const ctx = createContext({
			params: {
				...loadParams,
				'searchFilters.filters': [
					{ field: 'account_id', location: 'topLevel', value: '42' },
					{ field: 'source', location: 'metadata', value: 'f.pdf' },
				],
				searchOptions: { numCandidates: 500 },
			},
		});

		await node.execute.call(ctx);

		const { knn } = mockClientInstance.search.mock.calls[0][0];
		expect(knn.num_candidates).toBe(500);
		expect(knn.filter).toEqual({
			bool: {
				must: [{ term: { account_id: '42' } }, { term: { 'metadata.source': 'f.pdf' } }],
				must_not: [],
			},
		});
	});
});

describe('supplyData modes', () => {
	it('retrieve mode supplies the vendored store', async () => {
		const ctx = createContext({ params: { mode: 'retrieve', indexName: 'idx' } });
		const { response } = await node.supplyData.call(ctx, 0);
		expect(response).toBeInstanceOf(ElasticVectorSearch);
	});

	it('retrieve mode bakes Search Filters into retriever-driven searches', async () => {
		mockClientInstance.search.mockResolvedValue({ hits: { hits: [searchHit('d', {}, 0.9)] } });
		const ctx = createContext({
			params: {
				mode: 'retrieve',
				indexName: 'idx',
				'searchFilters.filters': [{ field: 'tenant', location: 'topLevel', value: 't1' }],
			},
		});

		const { response } = await node.supplyData.call(ctx, 0);
		await (response as ElasticVectorSearch).asRetriever(4).invoke('q');

		expect(mockClientInstance.search.mock.calls[0][0].knn.filter).toEqual({
			bool: { must: [{ term: { tenant: 't1' } }], must_not: [] },
		});
	});

	it('retrieve-as-tool supplies a sanitized DynamicTool wired to the store', async () => {
		mockClientInstance.search.mockResolvedValue({
			hits: { hits: [searchHit('tool result', { source: 's' }, 0.77)] },
		});
		const ctx = createContext({
			params: {
				mode: 'retrieve-as-tool',
				indexName: 'idx',
				toolName: 'My Tool! With Spaces',
				toolDescription: 'test tool',
				topK: 3,
			},
		});

		const { response } = await node.supplyData.call(ctx, 0);
		const tool = response as { name: string; description: string; func: (i: string) => Promise<string> };

		expect(tool.name).toBe('My_Tool__With_Spaces');
		expect(tool.description).toBe('test tool');

		const output = JSON.parse(await tool.func('question'));
		expect(output).toEqual([{ content: 'tool result', metadata: { source: 's' } }]);
		expect(mockClientInstance.search.mock.calls[0][0].knn.k).toBe(3);
	});

	it('rejects unsupported mode combinations', async () => {
		const executeCtx = createContext({ params: { mode: 'retrieve' } });
		await expect(node.execute.call(executeCtx)).rejects.toThrow(NodeOperationError);

		const supplyCtx = createContext({ params: { mode: 'insert' } });
		await expect(node.supplyData.call(supplyCtx, 0)).rejects.toThrow(NodeOperationError);
	});
});
