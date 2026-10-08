import type { AppBindings } from "../types";
import { readCredential } from "./credentials";
import { toBase64 } from "./encoding";
import { fetchForm, fetchJson } from "./fetch";
import type { Prospect } from "./store";

const sheetHeaders = [
	"ID",
	"Status",
	"Name",
	"Title",
	"Company",
	"Location",
	"LinkedIn",
	"Email",
	"Email confidence",
	"Why relevant",
	"Subject",
	"Draft",
	"Sent at",
	"Last reply",
	"Reply from",
	"Reply snippet",
	"Updated at",
];

export async function googleAccessToken(
	env: AppBindings,
	userId: string,
): Promise<string> {
	const refreshToken = await readCredential(
		env,
		userId,
		"GOOGLE",
		"OAUTH_REFRESH_TOKEN",
	);
	const response = await fetchForm<{
		access_token: string;
		expires_in: number;
		token_type: string;
	}>(
		"https://oauth2.googleapis.com/token",
		new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	);
	if (!response.access_token) throw new Error("Google authorization is unavailable.");
	return response.access_token;
}

export async function createTrackingSheet(
	env: AppBindings,
	userId: string,
): Promise<string> {
	const accessToken = await googleAccessToken(env, userId);
	const spreadsheet = await fetchJson<{
		spreadsheetId: string;
	}>("https://sheets.googleapis.com/v4/spreadsheets", {
		headers: { Authorization: `Bearer ${accessToken}` },
		body: {
			properties: { title: "Coffee Chat Agent CRM" },
			sheets: [
				{ properties: { title: "Prospects" } },
				{ properties: { title: "Activity" } },
			],
		},
	});
	await fetchJson(
		`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}/values/Prospects!A1:Q1?valueInputOption=RAW`,
		{
			method: "PUT",
			headers: { Authorization: `Bearer ${accessToken}` },
			body: { values: [sheetHeaders] },
		},
	);
	await fetchJson(
		`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheet.spreadsheetId)}/values/Activity!A1:E1?valueInputOption=RAW`,
		{
			method: "PUT",
			headers: { Authorization: `Bearer ${accessToken}` },
			body: { values: [["Timestamp", "Action", "Prospect ID", "Details", "Request ID"]] },
		},
	);
	return spreadsheet.spreadsheetId;
}

export async function syncProspectToSheet(
	env: AppBindings,
	userId: string,
	spreadsheetId: string,
	prospect: Prospect,
): Promise<number> {
	const accessToken = await googleAccessToken(env, userId);
	const values = [prospectRow(prospect)];
	if (prospect.sheetRow) {
		await fetchJson(
			`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/Prospects!A${prospect.sheetRow}:Q${prospect.sheetRow}?valueInputOption=RAW`,
			{
				method: "PUT",
				headers: { Authorization: `Bearer ${accessToken}` },
				body: { values },
			},
		);
		return prospect.sheetRow;
	}
	const response = await fetchJson<{
		updates?: { updatedRange?: string };
	}>(
		`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/Prospects!A:Q:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
		{
			headers: { Authorization: `Bearer ${accessToken}` },
			body: { values },
		},
	);
	const range = response.updates?.updatedRange || "";
	return Number(range.match(/!A(\d+):/)?.[1] || 0);
}

export async function sendGmailMessage(
	env: AppBindings,
	userId: string,
	input: {
		to: string;
		subject: string;
		body: string;
		senderName: string;
		attachment?: {
			fileName: string;
			mimeType: string;
			data: Uint8Array;
		};
	},
): Promise<{ messageId: string; threadId: string }> {
	const accessToken = await googleAccessToken(env, userId);
	const raw = encodeMimeMessage(input);
	let response: { id: string; threadId: string };
	try {
		response = await fetchJson<{ id: string; threadId: string }>(
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
			{
				headers: { Authorization: `Bearer ${accessToken}` },
				body: { raw },
				attempts: 1,
				timeoutMs: 20000,
			},
		);
	} catch (error) {
		if (
			error instanceof Error &&
			!error.message.includes("HTTP ")
		) {
			throw new Error("GMAIL_SEND_UNCERTAIN");
		}
		throw error;
	}
	if (!response.id) throw new Error("Gmail did not return a message ID.");
	return { messageId: response.id, threadId: response.threadId || "" };
}

export async function latestIncomingReply(
	env: AppBindings,
	userId: string,
	threadId: string,
	sentAt: string,
): Promise<
	| { receivedAt: string; from: string; snippet: string }
	| null
> {
	if (!threadId) return null;
	const accessToken = await googleAccessToken(env, userId);
	const thread = await fetchJson<{
		messages?: Array<{
			internalDate?: string;
			snippet?: string;
			payload?: { headers?: Array<{ name: string; value: string }> };
			labelIds?: string[];
		}>;
	}>(
		`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	);
	const sentMs = new Date(sentAt).getTime();
	const incoming = (thread.messages ?? [])
		.filter((message) => {
			const received = Number(message.internalDate || 0);
			return (
				received > sentMs &&
				!(message.labelIds ?? []).includes("SENT")
			);
		})
		.sort(
			(left, right) =>
				Number(right.internalDate || 0) - Number(left.internalDate || 0),
		)[0];
	if (!incoming) return null;
	const from =
		incoming.payload?.headers?.find(
			(header) => header.name.toLowerCase() === "from",
		)?.value || "";
	return {
		receivedAt: new Date(Number(incoming.internalDate)).toISOString(),
		from: from.slice(0, 320),
		snippet: (incoming.snippet || "").slice(0, 1000),
	};
}

function prospectRow(prospect: Prospect): Array<string | number> {
	return [
		prospect.id,
		prospect.status,
		prospect.fullName,
		prospect.title,
		prospect.company,
		prospect.location,
		prospect.linkedinUrl,
		prospect.email,
		prospect.preparation?.email?.provider === "APOLLO" ? "" : prospect.emailConfidence,
		prospect.whyRelevant,
		prospect.subject,
		prospect.draftBody,
		prospect.sentAt || "",
		prospect.lastReplyAt || "",
		prospect.replyFrom,
		prospect.replySnippet,
		prospect.updatedAt,
	];
}

export function encodeMimeMessage(input: {
	to: string;
	subject: string;
	body: string;
	senderName: string;
	attachment?: {
		fileName: string;
		mimeType: string;
		data: Uint8Array;
	};
}): string {
	const encodedSubject = `=?UTF-8?B?${base64Utf8(input.subject)}?=`;
	const headers = [
		`To: ${input.to}`,
		`From: ${input.senderName.replace(/[\r\n]/g, " ")}`,
		`Subject: ${encodedSubject}`,
		"MIME-Version: 1.0",
	];
	let message: string;
	if (input.attachment) {
		const boundary = `coffee-chat-${crypto.randomUUID().replace(/-/g, "")}`;
		const fileName = input.attachment.fileName
			.replace(/[\r\n"\\]/g, "_")
			.slice(0, 160);
		const mimeType = input.attachment.mimeType.replace(/[\r\n]/g, "");
		message = [
			...headers,
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			'Content-Type: text/plain; charset="UTF-8"',
			"Content-Transfer-Encoding: base64",
			"",
			wrapBase64(base64Utf8(input.body)),
			`--${boundary}`,
			`Content-Type: ${mimeType}; name="${fileName}"`,
			`Content-Disposition: attachment; filename="${fileName}"`,
			"Content-Transfer-Encoding: base64",
			"",
			wrapBase64(toBase64(input.attachment.data)),
			`--${boundary}--`,
			"",
		].join("\r\n");
	} else {
		message = [
			...headers,
			'Content-Type: text/plain; charset="UTF-8"',
			"Content-Transfer-Encoding: base64",
			"",
			wrapBase64(base64Utf8(input.body)),
		].join("\r\n");
	}
	return base64Utf8(message)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	return toBase64(bytes);
}

function wrapBase64(value: string): string {
	return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}
