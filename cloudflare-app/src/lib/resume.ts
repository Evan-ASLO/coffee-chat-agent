import { strFromU8, unzipSync } from "fflate";
import type { AppBindings } from "../types";
import { readCredential } from "./credentials";
import { decryptBytes, encryptBytes } from "./crypto";
import {
	decodeUtf8,
	fromBase64Url,
	toBase64,
	toBase64Url,
} from "./encoding";
import { ClientInputError } from "./errors";
import {
	analyzeResumeProfile,
	type AiProvider,
	type ResumeProfileSuggestions,
} from "./providers";
import {
	credentialStatus,
	enforceRateLimit,
	getSettings,
} from "./store";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const MAX_RESUME_TEXT = 60_000;
const RESUME_PURPOSE = "RESUME";
const RESUME_CHUNK_CHARACTERS = 1_000_000;

export interface ResumeStatus {
	configured: boolean;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
	uploadedAt: string;
}

export interface ResumeAttachment {
	fileName: string;
	mimeType: string;
	data: Uint8Array;
	uploadedAt: string;
}

interface ResumeRecord {
	user_id: string;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
	uploadedAt: string;
	iv: string;
	keyVersion: string;
	chunkCount: number;
}

export async function importResume(
	env: AppBindings,
	userId: string,
	file: File,
): Promise<{
	resume: ResumeStatus;
	suggestions: ResumeProfileSuggestions;
}> {
	await enforceRateLimit(env, {
		userId,
		action: "RESUME_IMPORT",
		limit: 10,
		windowSeconds: 60 * 60,
	});
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (!bytes.byteLength) throw new ClientInputError("Choose a non-empty resume file.");
	if (bytes.byteLength > MAX_RESUME_BYTES) {
		throw new ClientInputError("Resume files must be 5 MB or smaller.");
	}
	const fileName = safeResumeFileName(file.name);
	const mimeType = resumeMimeType(fileName, file.type, bytes);
	const settings = await getSettings(env, userId);
	const provider = await resumeProvider(env, userId, settings.draftProvider, mimeType);
	const apiKey = await readCredential(env, userId, provider);
	const suggestions =
		mimeType === "application/pdf"
			? await analyzeResumeProfile({
					provider,
					settings,
					apiKey,
					pdfBase64: toBase64(bytes),
				})
			: await analyzeResumeProfile({
					provider,
					settings,
					apiKey,
					resumeText: extractResumeText(mimeType, bytes),
				});
	const encrypted = await encryptBytes(env, userId, RESUME_PURPOSE, bytes);
	const ciphertext = toBase64Url(encrypted.ciphertext);
	const chunks = splitCiphertext(ciphertext);
	const uploadedAt = new Date().toISOString();
	const statements = [
		env.DB.prepare("DELETE FROM user_resume_chunks WHERE user_id = ?").bind(
			userId,
		),
		env.DB.prepare(
			`INSERT INTO user_resumes(
			   user_id, file_name, mime_type, size_bytes, iv, key_version,
			   chunk_count, uploaded_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   file_name = excluded.file_name,
			   mime_type = excluded.mime_type,
			   size_bytes = excluded.size_bytes,
			   iv = excluded.iv,
			   key_version = excluded.key_version,
			   chunk_count = excluded.chunk_count,
			   uploaded_at = excluded.uploaded_at,
			   updated_at = excluded.updated_at`,
		).bind(
			userId,
			fileName,
			mimeType,
			bytes.byteLength,
			encrypted.iv,
			encrypted.keyVersion,
			chunks.length,
			uploadedAt,
			uploadedAt,
		),
		...chunks.map((chunk, index) =>
			env.DB.prepare(
				`INSERT INTO user_resume_chunks(user_id, chunk_index, ciphertext)
				 VALUES (?, ?, ?)`,
			).bind(userId, index, chunk),
		),
	];
	await env.DB.batch(statements);
	const metadata: ResumeRecord = {
		user_id: userId,
		fileName,
		mimeType,
		sizeBytes: bytes.byteLength,
		uploadedAt,
		iv: encrypted.iv,
		keyVersion: encrypted.keyVersion,
		chunkCount: chunks.length,
	};
	return {
		resume: publicResumeStatus(metadata),
		suggestions,
	};
}

export async function getResumeStatus(
	env: AppBindings,
	userId: string,
): Promise<ResumeStatus> {
	const record = await env.DB.prepare(
		`SELECT user_id, file_name, mime_type, size_bytes, iv, key_version,
		        chunk_count, uploaded_at
		   FROM user_resumes
		  WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{
			user_id: string;
			file_name: string;
			mime_type: string;
			size_bytes: number;
			iv: string;
			key_version: string;
			chunk_count: number;
			uploaded_at: string;
		}>();
	return record ? publicResumeStatus(mapResumeRecord(record)) : emptyResumeStatus();
}

export async function readResumeAttachment(
	env: AppBindings,
	userId: string,
): Promise<ResumeAttachment | null> {
	const result = await env.DB.prepare(
		`SELECT r.user_id, r.file_name, r.mime_type, r.size_bytes, r.iv,
		        r.key_version, r.chunk_count, r.uploaded_at,
		        c.chunk_index, c.ciphertext
		   FROM user_resumes r
		   JOIN user_resume_chunks c ON c.user_id = r.user_id
		  WHERE r.user_id = ?
		  ORDER BY c.chunk_index ASC`,
	)
		.bind(userId)
		.all<{
			user_id: string;
			file_name: string;
			mime_type: string;
			size_bytes: number;
			iv: string;
			key_version: string;
			chunk_count: number;
			uploaded_at: string;
			chunk_index: number;
			ciphertext: string;
		}>();
	if (!result.results.length) return null;
	const first = result.results[0];
	const metadata = mapResumeRecord(first);
	if (
		result.results.length !== metadata.chunkCount ||
		result.results.some((row, index) => row.chunk_index !== index)
	) {
		throw new Error("Stored resume chunks are incomplete.");
	}
	const ciphertext = fromBase64Url(
		result.results.map((row) => row.ciphertext).join(""),
	);
	const data = await decryptBytes(env, userId, RESUME_PURPOSE, {
		ciphertext,
		iv: metadata.iv,
		keyVersion: metadata.keyVersion,
	});
	if (data.byteLength !== metadata.sizeBytes) {
		throw new Error("Stored resume failed its integrity check.");
	}
	return {
		fileName: metadata.fileName,
		mimeType: metadata.mimeType,
		data,
		uploadedAt: metadata.uploadedAt,
	};
}

export async function deleteResume(
	env: AppBindings,
	userId: string,
): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM user_resume_chunks WHERE user_id = ?").bind(
			userId,
		),
		env.DB.prepare("DELETE FROM user_resumes WHERE user_id = ?").bind(userId),
	]);
}

export function extractResumeText(
	mimeType: string,
	bytes: Uint8Array,
): string {
	if (mimeType === "text/plain") {
		try {
			return normalizeResumeText(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch {
			throw new ClientInputError("The text resume must use UTF-8 encoding.");
		}
	}
	if (
		mimeType ===
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	) {
		let files: ReturnType<typeof unzipSync>;
		try {
			files = unzipSync(bytes);
		} catch {
			throw new ClientInputError("The uploaded DOCX file could not be opened.");
		}
		const document = files["word/document.xml"];
		if (!document) {
			throw new ClientInputError("The uploaded file is not a valid DOCX resume.");
		}
		const xml = strFromU8(document);
		const text = decodeXmlEntities(
			xml
				.replace(/<w:tab\b[^>]*\/>/gi, "\t")
				.replace(/<w:br\b[^>]*\/>/gi, "\n")
				.replace(/<\/w:p>/gi, "\n")
				.replace(/<[^>]+>/g, ""),
		);
		return normalizeResumeText(text);
	}
	throw new ClientInputError("Only PDF, DOCX, and TXT resumes are supported.");
}

function normalizeResumeText(value: string): string {
	const text = value
		.replace(/\u0000/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, MAX_RESUME_TEXT);
	if (text.length < 80) {
		throw new ClientInputError(
			"The resume did not contain enough readable text to analyze.",
		);
	}
	return text;
}

async function resumeProvider(
	env: AppBindings,
	userId: string,
	selectedProvider: string,
	mimeType: string,
): Promise<AiProvider> {
	const status = await credentialStatus(env, userId);
	if (mimeType === "application/pdf") {
		if (!status.GEMINI.configured) {
			throw new ClientInputError(
				"Configure a Gemini key before uploading a PDF resume.",
			);
		}
		return "GEMINI";
	}
	const candidates = [
		selectedProvider,
		"GEMINI",
		"OPENAI",
		"ANTHROPIC",
	].filter(
		(provider, index, all): provider is AiProvider =>
			isAiProvider(provider) && all.indexOf(provider) === index,
	);
	const provider = candidates.find((candidate) => status[candidate].configured);
	if (!provider) {
		throw new ClientInputError(
			"Configure Gemini, OpenAI, or Anthropic before importing a resume.",
		);
	}
	return provider;
}

function isAiProvider(value: string): value is AiProvider {
	return ["GEMINI", "OPENAI", "ANTHROPIC"].includes(value);
}

function resumeMimeType(
	fileName: string,
	reportedType: string,
	bytes: Uint8Array,
): string {
	const extension = fileName.split(".").pop()?.toLowerCase();
	if (
		extension === "pdf" ||
		reportedType.toLowerCase() === "application/pdf"
	) {
		if (decodeUtf8(bytes.slice(0, 5)) !== "%PDF-") {
			throw new ClientInputError("The uploaded file is not a valid PDF.");
		}
		return "application/pdf";
	}
	if (
		extension === "docx" ||
		reportedType.toLowerCase() ===
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	) {
		if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
			throw new ClientInputError("The uploaded file is not a valid DOCX document.");
		}
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	}
	if (
		extension === "txt" ||
		reportedType.toLowerCase() === "text/plain"
	) {
		return "text/plain";
	}
	throw new ClientInputError("Only PDF, DOCX, and TXT resumes are supported.");
}

function safeResumeFileName(value: string): string {
	const original = value.replace(/\\/g, "/").split("/").pop()?.trim() || "resume";
	const dot = original.lastIndexOf(".");
	const extension = dot >= 0 ? original.slice(dot).toLowerCase() : "";
	const base = (dot >= 0 ? original.slice(0, dot) : original)
		.normalize("NFKD")
		.replace(/[^\x20-\x7E]/g, "")
		.replace(/[^A-Za-z0-9 _().-]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 140);
	return `${base || "resume"}${extension}`.slice(0, 160);
}

function publicResumeStatus(metadata: ResumeRecord): ResumeStatus {
	return {
		configured: true,
		fileName: metadata.fileName,
		mimeType: metadata.mimeType,
		sizeBytes: metadata.sizeBytes,
		uploadedAt: metadata.uploadedAt,
	};
}

function mapResumeRecord(record: {
	user_id: string;
	file_name: string;
	mime_type: string;
	size_bytes: number;
	iv: string;
	key_version: string;
	chunk_count: number;
	uploaded_at: string;
}): ResumeRecord {
	return {
		user_id: record.user_id,
		fileName: record.file_name,
		mimeType: record.mime_type,
		sizeBytes: record.size_bytes,
		iv: record.iv,
		keyVersion: record.key_version,
		chunkCount: record.chunk_count,
		uploadedAt: record.uploaded_at,
	};
}

function splitCiphertext(value: string): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < value.length; index += RESUME_CHUNK_CHARACTERS) {
		chunks.push(value.slice(index, index + RESUME_CHUNK_CHARACTERS));
	}
	if (!chunks.length || chunks.length > 16) {
		throw new Error("Encrypted resume exceeds storage limits.");
	}
	return chunks;
}

function emptyResumeStatus(): ResumeStatus {
	return {
		configured: false,
		fileName: "",
		mimeType: "",
		sizeBytes: 0,
		uploadedAt: "",
	};
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		)
		.replace(/&#(\d+);/g, (_match, code) =>
			String.fromCodePoint(Number.parseInt(code, 10)),
		)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}
