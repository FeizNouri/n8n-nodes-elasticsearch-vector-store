import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';
import { Client, type ClientOptions } from '@elastic/elasticsearch';
import { ElasticVectorSearch } from '@langchain/community/vectorstores/elasticsearch';
import type { Document } from '@langchain/core/documents';
import type { Embeddings } from '@langchain/core/embeddings';
import { DynamicTool } from '@langchain/core/tools';

// ---------- Field definitions ---------------------------------------------

const sharedFields: INodeProperties[] = [
	{
		displayName: 'Index Name',
		name: 'indexName',
		type: 'string',
		default: '',
		required: true,
		description:
			'Name of the Elasticsearch index. Will be auto-created on first insert if it does not exist.',
	},
];

const insertFields: INodeProperties[] = [
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { mode: ['insert'] } },
		options: [
			{
				displayName: 'Clear Index Before Insert',
				name: 'clearIndex',
				type: 'boolean',
				default: false,
				description:
					'Whether to delete and recreate the index before inserting. Use with care — destroys existing data.',
			},
		],
	},
];

const retrieveFields: INodeProperties[] = [
	// --- "Get Many" (load) mode ---
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		default: '',
		required: true,
		typeOptions: { rows: 2 },
		displayOptions: { show: { mode: ['load'] } },
		description: 'The query that will be embedded and used for similarity search',
	},
	{
		displayName: 'Limit',
		name: 'topK',
		type: 'number',
		default: 4,
		displayOptions: { show: { mode: ['load', 'retrieve-as-tool'] } },
		description: 'Number of top documents to return',
	},
	{
		displayName: 'Include Metadata',
		name: 'includeMetadata',
		type: 'boolean',
		default: true,
		displayOptions: { show: { mode: ['load'] } },
		description: 'Whether to include document metadata in the output',
	},

	// --- "Retrieve as Tool" mode ---
	{
		displayName: 'Name',
		name: 'toolName',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'company_knowledge_base',
		displayOptions: { show: { mode: ['retrieve-as-tool'] } },
		description: 'Name of the tool. Must contain only letters, numbers, underscores, and hyphens.',
	},
	{
		displayName: 'Description',
		name: 'toolDescription',
		type: 'string',
		default: '',
		required: true,
		typeOptions: { rows: 3 },
		placeholder: 'Useful for answering questions about [your data here]',
		displayOptions: { show: { mode: ['retrieve-as-tool'] } },
		description:
			"Description shown to the AI agent. Be specific — agents use this to decide when to call the tool.",
	},
];

// ---------- Node class -----------------------------------------------------

export class VectorStoreElasticsearch implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Elasticsearch Vector Store',
		name: 'vectorStoreElasticsearch',
		icon: 'file:elasticsearchVectorStore.svg',
		group: ['transform'],
		version: 1,
		description: 'Use Elasticsearch as a LangChain vector store for RAG workflows',
		defaults: { name: 'Elasticsearch Vector Store' },
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Vector Stores', 'Tools', 'Root Nodes'],
				'Vector Stores': ['Other Vector Stores'],
				Tools: ['Other Tools'],
			},
			resources: {
				primaryDocumentation: [
					{ url: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/' },
				],
			},
		},
		credentials: [{ name: 'elasticsearchVectorApi', required: true }],

		// Inputs vary by mode (mirrors the pattern used by official PGVector / Pinecone nodes)
		inputs: `={{
			((parameters) => {
				const mode = parameters?.mode;
				const inputs = [{ displayName: "Embedding", type: "${NodeConnectionTypes.AiEmbedding}", required: true, maxConnections: 1 }];
				if (mode === 'retrieve-as-tool') {
					return inputs;
				}
				if (mode === 'insert') {
					inputs.push({ displayName: "", type: "${NodeConnectionTypes.Main}" });
					inputs.push({ displayName: "Document", type: "${NodeConnectionTypes.AiDocument}", required: true, maxConnections: 1 });
				} else if (mode === 'load' || mode === 'retrieve') {
					inputs.push({ displayName: "", type: "${NodeConnectionTypes.Main}" });
				}
				return inputs;
			})($parameter)
		}}`,

		outputs: `={{
			((parameters) => {
				const mode = parameters?.mode;
				if (mode === 'retrieve') {
					return [{ displayName: "Vector Store", type: "${NodeConnectionTypes.AiVectorStore}" }];
				}
				if (mode === 'retrieve-as-tool') {
					return [{ displayName: "Tool", type: "${NodeConnectionTypes.AiTool}" }];
				}
				return [{ displayName: "", type: "${NodeConnectionTypes.Main}" }];
			})($parameter)
		}}`,

		properties: [
			{
				displayName: 'Operation Mode',
				name: 'mode',
				type: 'options',
				noDataExpression: true,
				default: 'retrieve',
				options: [
					{
						name: 'Get Many',
						value: 'load',
						description: 'Get many ranked documents from vector store for query',
						action: 'Get ranked documents from vector store',
					},
					{
						name: 'Insert Documents',
						value: 'insert',
						description: 'Insert documents into vector store',
						action: 'Add documents to vector store',
					},
					{
						name: 'Retrieve Documents (As Vector Store for Chain/Tool)',
						value: 'retrieve',
						description: 'Provide this vector store to a chain or retriever sub-node',
						action: 'Retrieve documents to be used with a chain or tool',
					},
					{
						name: 'Retrieve Documents (As Tool for AI Agent)',
						value: 'retrieve-as-tool',
						description: 'Expose the vector store as a tool for an AI Agent',
						action: 'Retrieve documents as a tool for AI agent',
					},
				],
			},
			...sharedFields,
			...insertFields,
			...retrieveFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const mode = this.getNodeParameter('mode', 0) as string;

		if (mode === 'load') {
			return await runGetMany.call(this);
		}
		if (mode === 'insert') {
			return await runInsert.call(this);
		}
		throw new NodeOperationError(
			this.getNode(),
			`Operation mode "${mode}" should not run via execute(). Use it as a sub-node instead.`,
		);
	}

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const mode = this.getNodeParameter('mode', itemIndex) as string;

		if (mode === 'retrieve') {
			const store = await buildVectorStore.call(this, itemIndex);
			return { response: store };
		}

		if (mode === 'retrieve-as-tool') {
			const tool = await buildVectorStoreTool.call(this, itemIndex);
			return { response: tool };
		}

		throw new NodeOperationError(
			this.getNode(),
			`Operation mode "${mode}" cannot supply data. Use it inline via execute() instead.`,
		);
	}
}

// ---------- Helpers --------------------------------------------------------

interface ESCredentials {
	baseUrl: string;
	authentication: 'basicAuth' | 'apiKey' | 'none';
	username?: string;
	password?: string;
	apiKey?: string;
	ignoreSSLIssues?: boolean;
}

async function getElasticsearchClient(
	this: IExecuteFunctions | ISupplyDataFunctions,
): Promise<Client> {
	const creds = (await this.getCredentials('elasticsearchVectorApi')) as unknown as ESCredentials;

	const config: ClientOptions = {
		node: creds.baseUrl.replace(/\/$/, ''),
	};

	if (creds.authentication === 'apiKey' && creds.apiKey) {
		config.auth = { apiKey: creds.apiKey };
	} else if (creds.authentication === 'basicAuth' && creds.username) {
		config.auth = { username: creds.username, password: creds.password ?? '' };
	}

	if (creds.ignoreSSLIssues) {
		config.tls = { rejectUnauthorized: false };
	}

	return new Client(config);
}

async function buildVectorStore(
	this: IExecuteFunctions | ISupplyDataFunctions,
	itemIndex: number,
): Promise<ElasticVectorSearch> {
	const indexName = this.getNodeParameter('indexName', itemIndex) as string;

	const embeddings = (await this.getInputConnectionData(
		NodeConnectionTypes.AiEmbedding,
		itemIndex,
	)) as Embeddings;

	if (!embeddings) {
		throw new NodeOperationError(
			this.getNode(),
			'No embeddings sub-node connected. Connect an Embeddings node to the "Embedding" input.',
		);
	}

	const client = await getElasticsearchClient.call(this);

	return new ElasticVectorSearch(embeddings, {
		client,
		indexName,
	});
}

async function runGetMany(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const out: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		const prompt = this.getNodeParameter('prompt', i) as string;
		const topK = this.getNodeParameter('topK', i, 4) as number;
		const includeMetadata = this.getNodeParameter('includeMetadata', i, true) as boolean;

		const store = await buildVectorStore.call(this, i);
		const results = await store.similaritySearchWithScore(prompt, topK);

		for (const [doc, score] of results) {
			out.push({
				json: {
					document: {
						pageContent: doc.pageContent,
						...(includeMetadata ? { metadata: doc.metadata } : {}),
					},
					score,
				} as IDataObject,
				pairedItem: { item: i },
			});
		}
	}

	return [out];
}

async function runInsert(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const indexName = this.getNodeParameter('indexName', 0) as string;
	const options = this.getNodeParameter('options', 0, {}) as { clearIndex?: boolean };

	const embeddings = (await this.getInputConnectionData(
		NodeConnectionTypes.AiEmbedding,
		0,
	)) as Embeddings;

	if (!embeddings) {
		throw new NodeOperationError(
			this.getNode(),
			'No embeddings sub-node connected. Connect an Embeddings node to the "Embedding" input.',
		);
	}

	// Documents may arrive as a Document[] (already processed) or as a loader object
	// with a processItem method (e.g. Default Data Loader operating per-item).
	const documentInput = await this.getInputConnectionData(NodeConnectionTypes.AiDocument, 0);

	const documents: Document[] = await resolveDocuments(documentInput, items);

	if (documents.length === 0) {
		throw new NodeOperationError(
			this.getNode(),
			'No documents to insert. Make sure your document loader is producing output.',
		);
	}

	const client = await getElasticsearchClient.call(this);

	if (options.clearIndex) {
		try {
			await client.indices.delete({ index: indexName });
		} catch (err) {
			// 404 is fine — index didn't exist yet
			if ((err as { meta?: { statusCode?: number } })?.meta?.statusCode !== 404) {
				throw err;
			}
		}
	}

	const store = new ElasticVectorSearch(embeddings, { client, indexName });
	await store.addDocuments(documents);

	return [
		items.map((item, i) => ({
			json: {
				...item.json,
				inserted: documents.length,
				indexName,
			},
			pairedItem: { item: i },
		})),
	];
}

async function resolveDocuments(
	documentInput: unknown,
	items: INodeExecutionData[],
): Promise<Document[]> {
	if (!documentInput) return [];

	// Already an array of LangChain Documents
	if (Array.isArray(documentInput)) {
		return documentInput as Document[];
	}

	const loader = documentInput as { processItem?: (item: INodeExecutionData, i: number) => Promise<Document[]> };
	if (typeof loader.processItem === 'function') {
		const all: Document[] = [];
		for (let i = 0; i < items.length; i++) {
			const docs = await loader.processItem(items[i], i);
			all.push(...docs);
		}
		return all;
	}

	// Some loaders return { processedDocuments: Document[] }
	const wrapped = documentInput as { processedDocuments?: Document[] };
	if (Array.isArray(wrapped.processedDocuments)) {
		return wrapped.processedDocuments;
	}

	return [];
}

async function buildVectorStoreTool(
	this: ISupplyDataFunctions,
	itemIndex: number,
): Promise<DynamicTool> {
	const store = await buildVectorStore.call(this, itemIndex);
	const rawName = this.getNodeParameter('toolName', itemIndex) as string;
	const description = this.getNodeParameter('toolDescription', itemIndex) as string;
	const topK = this.getNodeParameter('topK', itemIndex, 4) as number;

	// LangChain tool names must match ^[a-zA-Z0-9_-]+$
	const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'elasticsearch_vector_store';

	return new DynamicTool({
		name,
		description,
		func: async (input: string) => {
			const results = await store.similaritySearch(input, topK);
			return JSON.stringify(
				results.map((d) => ({
					content: d.pageContent,
					metadata: d.metadata,
				})),
			);
		},
	});
}
