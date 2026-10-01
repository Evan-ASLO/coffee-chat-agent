import type {
	AppBindings,
	CredentialKind,
	CredentialProvider,
} from "../types";
import { decryptCredential, encryptCredential, secretHint } from "./crypto";
import {
	deleteCredential,
	getCredential,
	putCredential,
} from "./db";

export async function readCredential(
	env: AppBindings,
	userId: string,
	provider: CredentialProvider,
	kind: CredentialKind = "API_KEY",
): Promise<string> {
	const record = await getCredential(env, userId, kind, provider);
	if (!record) throw new Error(`${provider} is not configured.`);
	return decryptCredential(env, userId, kind, provider, record);
}

export async function readOptionalCredential(
	env: AppBindings,
	userId: string,
	provider: CredentialProvider,
	kind: CredentialKind = "API_KEY",
): Promise<string | null> {
	const record = await getCredential(env, userId, kind, provider);
	if (!record) return null;
	return decryptCredential(env, userId, kind, provider, record);
}

export async function saveCredential(
	env: AppBindings,
	input: {
		userId: string;
		provider: CredentialProvider;
		kind?: CredentialKind;
		value: string;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	const kind = input.kind ?? "API_KEY";
	const value = input.value.trim();
	if (value.length < 8 || value.length > 10000) {
		throw new Error("Credential value is not valid.");
	}
	const encrypted = await encryptCredential(
		env,
		input.userId,
		kind,
		input.provider,
		value,
	);
	await putCredential(env, {
		userId: input.userId,
		kind,
		provider: input.provider,
		encrypted,
		keyHint: kind === "API_KEY" ? secretHint(value) : "Google connected",
		metadata: input.metadata,
	});
}

export async function removeCredential(
	env: AppBindings,
	userId: string,
	provider: CredentialProvider,
	kind: CredentialKind = "API_KEY",
): Promise<void> {
	await deleteCredential(env, userId, kind, provider);
}
