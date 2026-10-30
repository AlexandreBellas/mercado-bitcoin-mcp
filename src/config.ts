export interface Config {
	apiKey: string;
	apiSecret: string;
	baseUrl: string;
}

export interface CredentialEnv {
	MB_API_KEY?: string;
	MB_API_SECRET?: string;
}

export function loadConfig(env: CredentialEnv, baseUrl: string): Config {
	return {
		apiKey: env.MB_API_KEY ?? "",
		apiSecret: env.MB_API_SECRET ?? "",
		baseUrl,
	};
}

export function hasCredentials(config: Config): boolean {
	return config.apiKey.length > 0 && config.apiSecret.length > 0;
}
