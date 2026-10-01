import type { AppBindings, CredentialKind, CredentialProvider } from "../types";
import {
	decodeUtf8,
	bufferSource,
	fromBase64Url,
	toBase64Url,
	utf8,
} from "./encoding";

export interface EncryptedValue {
	ciphertext: string;
	iv: string;
	keyVersion: string;
}

export interface EncryptedBytes {
	ciphertext: Uint8Array;
	iv: string;
	keyVersion: string;
}

function keySecret(env: AppBindings, version: string): string {
	if (version === "1") return env.MASTER_ENCRYPTION_KEY_V1;
	if (version === "2" && env.MASTER_ENCRYPTION_KEY_V2) {
		return env.MASTER_ENCRYPTION_KEY_V2;
	}
	throw new Error(`Encryption key version ${version} is unavailable.`);
}

async function importMasterKey(
	env: AppBindings,
	version: string,
): Promise<CryptoKey> {
	const raw = fromBase64Url(keySecret(env, version));
	if (raw.byteLength !== 32) {
		throw new Error("The active encryption key must be exactly 32 bytes.");
	}
	return crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

function associatedData(
	userId: string,
	kind: CredentialKind,
	provider: CredentialProvider,
): Uint8Array {
	return utf8(`coffee-chat-agent|${userId}|${kind}|${provider}`);
}

function fileAssociatedData(userId: string, purpose: string): Uint8Array {
	return utf8(`coffee-chat-agent|${userId}|FILE|${purpose}`);
}

export async function encryptCredential(
	env: AppBindings,
	userId: string,
	kind: CredentialKind,
	provider: CredentialProvider,
	plaintext: string,
): Promise<EncryptedValue> {
	const keyVersion = env.ACTIVE_KEY_VERSION;
	const key = await importMasterKey(env, keyVersion);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(iv),
			additionalData: bufferSource(associatedData(userId, kind, provider)),
			tagLength: 128,
		},
		key,
		bufferSource(utf8(plaintext)),
	);
	return {
		ciphertext: toBase64Url(ciphertext),
		iv: toBase64Url(iv),
		keyVersion,
	};
}

export async function decryptCredential(
	env: AppBindings,
	userId: string,
	kind: CredentialKind,
	provider: CredentialProvider,
	value: EncryptedValue,
): Promise<string> {
	const key = await importMasterKey(env, value.keyVersion);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(fromBase64Url(value.iv)),
			additionalData: bufferSource(associatedData(userId, kind, provider)),
			tagLength: 128,
		},
		key,
		bufferSource(fromBase64Url(value.ciphertext)),
	);
	return decodeUtf8(plaintext);
}

export async function encryptBytes(
	env: AppBindings,
	userId: string,
	purpose: string,
	plaintext: Uint8Array,
): Promise<EncryptedBytes> {
	const keyVersion = env.ACTIVE_KEY_VERSION;
	const key = await importMasterKey(env, keyVersion);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(iv),
			additionalData: bufferSource(fileAssociatedData(userId, purpose)),
			tagLength: 128,
		},
		key,
		bufferSource(plaintext),
	);
	return {
		ciphertext: new Uint8Array(ciphertext),
		iv: toBase64Url(iv),
		keyVersion,
	};
}

export async function decryptBytes(
	env: AppBindings,
	userId: string,
	purpose: string,
	value: EncryptedBytes,
): Promise<Uint8Array> {
	const key = await importMasterKey(env, value.keyVersion);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(fromBase64Url(value.iv)),
			additionalData: bufferSource(fileAssociatedData(userId, purpose)),
			tagLength: 128,
		},
		key,
		bufferSource(value.ciphertext),
	);
	return new Uint8Array(plaintext);
}

export function secretHint(value: string): string {
	const cleaned = value.trim();
	return cleaned.length <= 4 ? "configured" : `••••${cleaned.slice(-4)}`;
}

async function importSessionKey(env: AppBindings): Promise<CryptoKey> {
	const raw = fromBase64Url(env.SESSION_SIGNING_KEY);
	if (raw.byteLength !== 32) {
		throw new Error("SESSION_SIGNING_KEY must be exactly 32 bytes.");
	}
	return crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

export async function sealPayload(
	env: AppBindings,
	purpose: string,
	value: Record<string, unknown>,
): Promise<string> {
	const key = await importSessionKey(env);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(iv),
			additionalData: bufferSource(utf8(`coffee-chat-agent|${purpose}`)),
			tagLength: 128,
		},
		key,
		bufferSource(utf8(JSON.stringify(value))),
	);
	return `${toBase64Url(iv)}.${toBase64Url(encrypted)}`;
}

export async function openPayload<T>(
	env: AppBindings,
	purpose: string,
	sealed: string,
): Promise<T> {
	const [ivPart, ciphertextPart] = sealed.split(".");
	if (!ivPart || !ciphertextPart) throw new Error("Invalid sealed payload.");
	const key = await importSessionKey(env);
	const decrypted = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(fromBase64Url(ivPart)),
			additionalData: bufferSource(utf8(`coffee-chat-agent|${purpose}`)),
			tagLength: 128,
		},
		key,
		bufferSource(fromBase64Url(ciphertextPart)),
	);
	return JSON.parse(decodeUtf8(decrypted)) as T;
}
