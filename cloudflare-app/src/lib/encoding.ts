const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value: string): Uint8Array {
	return encoder.encode(value);
}

export function bufferSource(value: Uint8Array): ArrayBuffer {
	return value.buffer.slice(
		value.byteOffset,
		value.byteOffset + value.byteLength,
	) as ArrayBuffer;
}

export function decodeUtf8(value: ArrayBuffer | Uint8Array): string {
	return decoder.decode(value);
}

export function toBase64Url(value: ArrayBuffer | Uint8Array): string {
	return toBase64(value)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export function toBase64(value: ArrayBuffer | Uint8Array): string {
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
		Math.ceil(value.length / 4) * 4,
		"=",
	);
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
	return toBase64Url(
		await crypto.subtle.digest("SHA-256", bufferSource(utf8(value))),
	);
}

export function safeEqual(left: string, right: string): boolean {
	const leftBytes = utf8(left);
	const rightBytes = utf8(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const maximum = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < maximum; index += 1) {
		difference |=
			(leftBytes[index % leftBytes.length] || 0) ^
			(rightBytes[index % rightBytes.length] || 0);
	}
	return difference === 0;
}
