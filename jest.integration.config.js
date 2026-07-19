// Integration tests against a real Elasticsearch. Not part of `npm test`.
// Run with:  ES_TEST_URL=http://localhost:9200 npm run test:integration
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/test/integration'],
	// A single real cluster round-trip can be slow on cold indices
	testTimeout: 30000,
};
