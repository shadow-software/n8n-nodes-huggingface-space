import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Hugging Face access token.
 *
 * Optional by design: public Spaces accept anonymous calls. But an anonymous
 * caller shares a single, very small ZeroGPU allowance with everyone else on the
 * same egress IP, so in practice unauthenticated runs fail with an out-of-quota
 * error under any real load. Supplying a token gives the call your own account's
 * allowance, which is why the node asks for one even though it can run without.
 */
export class HuggingFaceSpaceApi implements ICredentialType {
	name = 'huggingFaceSpaceApi';

	displayName = 'Hugging Face Space API';

	icon = 'file:huggingFaceSpaceApi.svg' as const;

	documentationUrl = 'https://huggingface.co/docs/hub/security-tokens';

	properties: INodeProperties[] = [
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Hugging Face access token, created at https://huggingface.co/settings/tokens. A read token is enough. Leave empty to call public Spaces anonymously — but anonymous callers share a very small GPU quota, so most Spaces will reject the call under load.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://huggingface.co',
			url: '/api/whoami-v2',
		},
	};
}
