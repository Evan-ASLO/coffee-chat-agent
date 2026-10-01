import type {
	AppBindings,
	AuthenticatedUser,
	CredentialKind,
	CredentialProvider,
} from "../types";
import type { EncryptedValue } from "./crypto";

export interface SessionRecord {
	id: string;
	user_id: string;
	csrf_hash: string;
	expires_at: string;
	last_seen_at: string;
	google_sub: string;
	email: string;
	name: string;
	image: string;
}

export interface CredentialRecord extends EncryptedValue {
	kind: CredentialKind;
	provider: CredentialProvider;
	key_hint: string;
	metadata_json: string;
}

export async function findSession(
	env: AppBindings,
	tokenHash: string,
): Promise<SessionRecord | null> {
	return env.DB.prepare(
		`SELECT s.id, s.user_id, s.csrf_hash, s.expires_at, s.last_seen_at,
		        u.google_sub, u.email, u.name, u.image
		   FROM sessions s
		   JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = ?
		    AND s.revoked_at IS NULL
		    AND s.expires_at > ?
		    AND u.deleted_at IS NULL`,
	)
		.bind(tokenHash, new Date().toISOString())
		.first<SessionRecord>();
}

export async function upsertUser(
	env: AppBindings,
	profile: Omit<AuthenticatedUser, "id">,
): Promise<AuthenticatedUser> {
	const now = new Date().toISOString();
	const existing = await env.DB.prepare(
		"SELECT id FROM users WHERE google_sub = ?",
	)
		.bind(profile.googleSub)
		.first<{ id: string }>();
	const id = existing?.id ?? crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO users(id, google_sub, email, name, image, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(google_sub) DO UPDATE SET
		   email = excluded.email,
		   name = excluded.name,
		   image = excluded.image,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			id,
			profile.googleSub,
			profile.email.toLowerCase(),
			profile.name,
			profile.image,
			now,
			now,
		)
		.run();
	await env.DB.prepare(
		`INSERT INTO user_settings(user_id, created_at, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO NOTHING`,
	)
		.bind(id, now, now)
		.run();
	return { id, ...profile, email: profile.email.toLowerCase() };
}

export async function createSession(
	env: AppBindings,
	userId: string,
	tokenHash: string,
	csrfHash: string,
	expiresAt: string,
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO sessions(id, user_id, token_hash, csrf_hash, expires_at, last_seen_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, userId, tokenHash, csrfHash, expiresAt, now, now)
		.run();
	return id;
}

export async function revokeSession(
	env: AppBindings,
	sessionId: string,
): Promise<void> {
	await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), sessionId)
		.run();
}

export async function touchSession(
	env: AppBindings,
	sessionId: string,
	lastSeen: string,
): Promise<void> {
	if (Date.now() - new Date(lastSeen).getTime() < 6 * 60 * 60 * 1000) return;
	await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), sessionId)
		.run();
}

export async function putCredential(
	env: AppBindings,
	input: {
		userId: string;
		kind: CredentialKind;
		provider: CredentialProvider;
		encrypted: EncryptedValue;
		keyHint: string;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO encrypted_credentials(
		   id, user_id, kind, provider, ciphertext, iv, key_version,
		   key_hint, metadata_json, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, kind, provider) DO UPDATE SET
		   ciphertext = excluded.ciphertext,
		   iv = excluded.iv,
		   key_version = excluded.key_version,
		   key_hint = excluded.key_hint,
		   metadata_json = excluded.metadata_json,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			crypto.randomUUID(),
			input.userId,
			input.kind,
			input.provider,
			input.encrypted.ciphertext,
			input.encrypted.iv,
			input.encrypted.keyVersion,
			input.keyHint,
			JSON.stringify(input.metadata ?? {}),
			now,
			now,
		)
		.run();
}

export async function getCredential(
	env: AppBindings,
	userId: string,
	kind: CredentialKind,
	provider: CredentialProvider,
): Promise<CredentialRecord | null> {
	const record = await env.DB.prepare(
		`SELECT kind, provider, ciphertext, iv, key_version, key_hint, metadata_json
		   FROM encrypted_credentials
		  WHERE user_id = ? AND kind = ? AND provider = ?`,
	)
		.bind(userId, kind, provider)
		.first<{
			kind: CredentialKind;
			provider: CredentialProvider;
			ciphertext: string;
			iv: string;
			key_version: string;
			key_hint: string;
			metadata_json: string;
		}>();
	if (!record) return null;
	return {
		...record,
		keyVersion: record.key_version,
	};
}

export async function deleteCredential(
	env: AppBindings,
	userId: string,
	kind: CredentialKind,
	provider: CredentialProvider,
): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM encrypted_credentials WHERE user_id = ? AND kind = ? AND provider = ?",
	)
		.bind(userId, kind, provider)
		.run();
}
