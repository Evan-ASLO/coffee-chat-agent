import { z } from "zod";
import type { AppBindings } from "../types";
import { ClientInputError, ConflictError } from "./errors";

export const ONBOARDING_VERSION = 1;
export const ONBOARDING_STEPS = [
	"welcome",
	"tavily",
	"hunter",
	"drafting",
	"search-fallback",
	"personal-context",
	"google-connections",
	"private-data",
	"home-summary",
	"home-journey",
	"jobs-search",
	"jobs-actions",
	"applications",
	"networking-find",
	"networking-review",
	"networking-send",
	"analytics",
	"workspace-settings",
] as const;

const statuses = [
	"legacy",
	"invited",
	"in_progress",
	"paused",
	"completed",
	"skipped",
] as const;

export const onboardingInputSchema = z
	.object({
		version: z.literal(ONBOARDING_VERSION),
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		action: z.enum([
			"start",
			"progress",
			"pause",
			"resume",
			"complete",
			"skip",
			"replay",
			"explore",
		]),
		step: z.enum(ONBOARDING_STEPS),
	})
	.strict();

export interface OnboardingState {
	version: typeof ONBOARDING_VERSION;
	status: (typeof statuses)[number];
	step: (typeof ONBOARDING_STEPS)[number];
	revision: number;
	updatedAt: string | null;
}

type OnboardingInput = z.infer<typeof onboardingInputSchema>;

export async function getOnboarding(
	env: AppBindings,
	userId: string,
): Promise<OnboardingState> {
	const row = await env.DB.prepare(
		`SELECT onboarding_version AS version, onboarding_status AS status,
		        onboarding_step AS step, onboarding_revision AS revision,
		        onboarding_updated_at AS updatedAt
		   FROM users WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(userId)
		.first<OnboardingState>();
	if (!row) throw new Error("Unauthorized tutorial state.");
	if (
		row.version !== ONBOARDING_VERSION ||
		!ONBOARDING_STEPS.includes(row.step) ||
		!statuses.includes(row.status)
	) {
		throw new ConflictError("The tutorial has changed. Reload the workspace.");
	}
	return row;
}

export async function updateOnboarding(
	env: AppBindings,
	userId: string,
	input: OnboardingInput,
): Promise<OnboardingState> {
	const current = await getOnboarding(env, userId);
	if (input.revision !== current.revision) {
		throw new ConflictError(
			"Tutorial progress changed in another window. Reload the saved progress before retrying.",
		);
	}
	const status = transition(current, input);
	const updatedAt = new Date().toISOString();
	// The revision guard also covers a concurrent completion between read and write.
	const result = await env.DB.prepare(
		`UPDATE users SET onboarding_status = ?, onboarding_step = ?,
		        onboarding_revision = onboarding_revision + 1, onboarding_updated_at = ?
		  WHERE id = ? AND deleted_at IS NULL
		    AND onboarding_version = ? AND onboarding_revision = ?`,
	)
		.bind(
			status,
			input.step,
			updatedAt,
			userId,
			input.version,
			input.revision,
		)
		.run();
	if (result.meta.changes !== 1) {
		throw new ConflictError(
			"Tutorial progress changed in another window. Reload the saved progress before retrying.",
		);
	}
	return {
		version: ONBOARDING_VERSION,
		status,
		step: input.step,
		revision: current.revision + 1,
		updatedAt,
	};
}

function transition(
	current: OnboardingState,
	input: OnboardingInput,
): OnboardingState["status"] {
	const atCurrentStep = input.step === current.step;
	switch (input.action) {
		case "replay":
			if (input.step === ONBOARDING_STEPS[0]) return "in_progress";
			break;
		case "start":
			if (current.status === "invited" && atCurrentStep) return "in_progress";
			break;
		case "resume":
			if (current.status === "paused" && atCurrentStep) return "in_progress";
			break;
		case "explore":
			if (
				["invited", "in_progress", "paused"].includes(current.status) &&
				ONBOARDING_STEPS.indexOf(current.step) <
					ONBOARDING_STEPS.indexOf("home-summary") &&
				input.step === "home-summary"
			) return "in_progress";
			break;
		case "progress":
			if (
				current.status === "in_progress" &&
				Math.abs(
					ONBOARDING_STEPS.indexOf(current.step) -
						ONBOARDING_STEPS.indexOf(input.step),
				) === 1
			) return "in_progress";
			break;
		case "pause":
			if (
				["invited", "in_progress"].includes(current.status) &&
				atCurrentStep
			) return "paused";
			break;
		case "skip":
			if (
				["invited", "in_progress", "paused"].includes(current.status) &&
				atCurrentStep
			) return "skipped";
			break;
		case "complete":
			if (
				current.status === "in_progress" &&
				atCurrentStep &&
				input.step === ONBOARDING_STEPS.at(-1)
			) return "completed";
			break;
	}
	throw new ClientInputError(
		"This tutorial action is not available from the saved step. Resume or explicitly replay from Settings.",
	);
}
