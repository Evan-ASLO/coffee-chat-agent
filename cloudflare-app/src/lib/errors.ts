export class PublicHttpError extends Error {
	constructor(
		message: string,
		public readonly status: 400 | 401 | 403 | 409 | 413 | 429,
		public readonly code: string,
		public readonly publicMessage = message,
	) {
		super(message);
		this.name = "PublicHttpError";
	}
}

export class ClientInputError extends PublicHttpError {
	constructor(message: string) {
		super(message, 400, "INVALID_REQUEST");
		this.name = "ClientInputError";
	}
}

export class AuthenticationError extends PublicHttpError {
	constructor(message = "Authentication failed.") {
		super(message, 401, "UNAUTHORIZED", "The request could not be authenticated.");
		this.name = "AuthenticationError";
	}
}

export class ConflictError extends PublicHttpError {
	constructor(message: string) {
		super(message, 409, "CONFLICT");
		this.name = "ConflictError";
	}
}

export class PayloadTooLargeError extends PublicHttpError {
	constructor(message: string) {
		super(message, 413, "PAYLOAD_TOO_LARGE");
		this.name = "PayloadTooLargeError";
	}
}
