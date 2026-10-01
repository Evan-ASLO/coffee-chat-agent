export type CredentialProvider =
	| "GOOGLE"
	| "TAVILY"
	| "HUNTER"
	| "GEMINI"
	| "OPENAI"
	| "ANTHROPIC";

export type CredentialKind = "OAUTH_REFRESH_TOKEN" | "API_KEY";

export type ProspectStatus =
	| "DISCOVERED"
	| "PREPARING"
	| "DRAFT_READY"
	| "SENDING"
	| "SENT"
	| "REPLIED"
	| "REJECTED"
	| "ERROR";

export type QueueMessage =
	| { type: "SYNC_PROSPECT"; userId: string; prospectId: string }
	| { type: "SYNC_REPLIES"; userId: string };

export interface AppBindings {
	DB: D1Database;
	ASSETS: Fetcher;
	MAIL_QUEUE: Queue<QueueMessage>;
	APP_ORIGIN: string;
	ACTIVE_KEY_VERSION: string;
	MAX_DISCOVERY_RESULTS: string;
	MAX_DRAFTS_PER_HOUR: string;
	MAX_SENDS_PER_DAY: string;
	SESSION_DAYS: string;
	JOBS_INGEST_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	MASTER_ENCRYPTION_KEY_V1: string;
	MASTER_ENCRYPTION_KEY_V2?: string;
	SESSION_SIGNING_KEY: string;
}

export interface AuthenticatedUser {
	id: string;
	googleSub: string;
	email: string;
	name: string;
	image: string;
}

export interface AppVariables {
	requestId: string;
	user?: AuthenticatedUser;
	sessionId?: string;
	csrfHash?: string;
}

export type AppEnvironment = {
	Bindings: AppBindings;
	Variables: AppVariables;
};
