import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ElasticsearchVectorApi implements ICredentialType {
	name = 'elasticsearchVectorApi';

	displayName = 'Elasticsearch Vector Store API';

	documentationUrl = 'https://www.elastic.co/guide/en/elasticsearch/reference/current/security-api.html';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:9200',
			placeholder: 'https://elastic.example.com:9200',
			description: 'URL of the Elasticsearch instance (no trailing slash needed)',
			required: true,
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'options',
			options: [
				{ name: 'Basic Auth', value: 'basicAuth' },
				{ name: 'API Key', value: 'apiKey' },
				{ name: 'None', value: 'none' },
			],
			default: 'basicAuth',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: 'elastic',
			displayOptions: { show: { authentication: ['basicAuth'] } },
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authentication: ['basicAuth'] } },
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Base64-encoded "id:api_key" pair from Elasticsearch (use the encoded value, not "ApiKey ...")',
			displayOptions: { show: { authentication: ['apiKey'] } },
		},
		{
			displayName: 'Ignore SSL Issues',
			name: 'ignoreSSLIssues',
			type: 'boolean',
			default: false,
			description:
				'Whether to skip TLS certificate verification (useful for self-signed certs in dev)',
		},
	];

	// Allow n8n to test the credential against Elasticsearch's root endpoint
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				// Only set when API key auth is selected; basic auth is built dynamically below
				'={{$credentials.authentication === "apiKey" ? "Authorization" : "X-N8N-Skip"}}':
					'={{$credentials.authentication === "apiKey" ? "ApiKey " + $credentials.apiKey : ""}}',
			},
			auth: {
				username: '={{$credentials.authentication === "basicAuth" ? $credentials.username : ""}}',
				password: '={{$credentials.authentication === "basicAuth" ? $credentials.password : ""}}',
			},
			skipSslCertificateValidation: '={{$credentials.ignoreSSLIssues}}',
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/$/, "")}}',
			url: '/',
			method: 'GET',
		},
	};
}
