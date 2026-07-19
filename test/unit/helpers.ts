import type { Client } from '@elastic/elasticsearch';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';

/**
 * Deterministic fake embeddings: each text maps to a fixed-dimension vector
 * derived from its length, so assertions can predict exact vectors.
 */
export class FakeEmbeddings implements EmbeddingsInterface {
	constructor(readonly dimensions = 3) {}

	async embedDocuments(texts: string[]): Promise<number[][]> {
		return texts.map((t) => this.vectorFor(t));
	}

	async embedQuery(text: string): Promise<number[]> {
		return this.vectorFor(text);
	}

	vectorFor(text: string): number[] {
		return Array.from({ length: this.dimensions }, (_, i) => (text.length + i) / 10);
	}
}

export interface MockClient {
	indices: {
		exists: jest.Mock;
		create: jest.Mock;
		delete: jest.Mock;
	};
	bulk: jest.Mock;
	search: jest.Mock;
}

export function createMockClient(overrides: Partial<MockClient> = {}): MockClient & Client {
	const client: MockClient = {
		indices: {
			exists: jest.fn().mockResolvedValue(true),
			create: jest.fn().mockResolvedValue({ acknowledged: true }),
			delete: jest.fn().mockResolvedValue({ acknowledged: true }),
		},
		bulk: jest.fn().mockResolvedValue({ errors: false, items: [] }),
		search: jest.fn().mockResolvedValue({ hits: { hits: [] } }),
		...overrides,
	};
	return client as MockClient & Client;
}

export function searchHit(text: string, metadata: Record<string, unknown>, score: number) {
	return { _index: 'idx', _id: 'id', _score: score, _source: { text, metadata } };
}
