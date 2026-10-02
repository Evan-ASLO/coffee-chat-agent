import type { AppBindings } from "../types";

const APPLICATION_STATUSES = [
	"SAVED",
	"APPLIED",
	"INTERVIEWING",
	"OFFER",
	"REJECTED",
	"ARCHIVED",
] as const;

const PROSPECT_STATUSES = [
	"DISCOVERED",
	"PREPARING",
	"DRAFT_READY",
	"SENDING",
	"SENT",
	"REPLIED",
	"REJECTED",
	"ERROR",
] as const;

interface CountRow {
	status: string;
	count: number;
}

interface ActivityRow {
	action: string;
	entity_type: string;
	created_at: string;
	job_title: string | null;
	job_company: string | null;
	prospect_name: string | null;
}

export interface UserAnalytics {
	generatedAt: string;
	applications: {
		total: number;
		saved: number;
		applied: number;
		interviewing: number;
		offers: number;
		rejected: number;
		archived: number;
		inProgress: number;
	};
	networking: {
		tracked: number;
		discovered: number;
		drafts: number;
		sent: number;
		replied: number;
		rejected: number;
		errors: number;
	};
	topCompanies: Array<{ company: string; count: number }>;
	activity: {
		from: string;
		to: string;
		days: Array<{ date: string; count: number }>;
	};
	recentActivity: Array<{
		action: string;
		label: string;
		context: string;
		createdAt: string;
	}>;
}

export async function getUserAnalytics(
	env: AppBindings,
	userId: string,
	now = new Date(),
): Promise<UserAnalytics> {
	const to = dateKey(now);
	const fromDate = new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate() - 27,
		),
	);
	const from = dateKey(fromDate);
	const [applicationRows, prospectRows, companyRows, activityRows, recentRows] =
		await Promise.all([
			env.DB.prepare(
				`SELECT status, COUNT(*) AS count
				   FROM user_job_states
				  WHERE user_id = ?
				  GROUP BY status`,
			)
				.bind(userId)
				.all<CountRow>(),
			env.DB.prepare(
				`SELECT status, COUNT(*) AS count
				   FROM prospects
				  WHERE user_id = ?
				  GROUP BY status`,
			)
				.bind(userId)
				.all<CountRow>(),
			env.DB.prepare(
				`SELECT j.company, COUNT(*) AS count
				   FROM user_job_states ujs
				   JOIN jobs j ON j.id = ujs.job_id
				  WHERE ujs.user_id = ? AND ujs.status <> 'ARCHIVED'
				  GROUP BY j.company
				  ORDER BY count DESC, j.company COLLATE NOCASE
				  LIMIT 8`,
			)
				.bind(userId)
				.all<{ company: string; count: number }>(),
			env.DB.prepare(
				`SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
				   FROM audit_events
				  WHERE user_id = ? AND created_at >= ?
				  GROUP BY substr(created_at, 1, 10)
				  ORDER BY date`,
			)
				.bind(userId, `${from}T00:00:00.000Z`)
				.all<{ date: string; count: number }>(),
			env.DB.prepare(
				`SELECT ae.action, ae.entity_type, ae.created_at,
				        j.title AS job_title, j.company AS job_company,
				        p.full_name AS prospect_name
				   FROM audit_events ae
				   LEFT JOIN jobs j
				     ON ae.entity_type = 'job' AND j.id = ae.entity_id
				   LEFT JOIN prospects p
				     ON ae.entity_type = 'prospect'
				    AND p.id = ae.entity_id
				    AND p.user_id = ae.user_id
				  WHERE ae.user_id = ?
				  ORDER BY ae.created_at DESC
				  LIMIT 30`,
			)
				.bind(userId)
				.all<ActivityRow>(),
		]);

	const applicationCounts = completeCounts(
		APPLICATION_STATUSES,
		applicationRows.results,
	);
	const prospectCounts = completeCounts(
		PROSPECT_STATUSES,
		prospectRows.results,
	);
	const activityCounts = new Map(
		activityRows.results.map((row) => [row.date, Number(row.count)]),
	);
	const days = Array.from({ length: 28 }, (_, index) => {
		const date = new Date(fromDate);
		date.setUTCDate(fromDate.getUTCDate() + index);
		const key = dateKey(date);
		return { date: key, count: activityCounts.get(key) ?? 0 };
	});
	const applied = applicationCounts.APPLIED;
	const interviewing = applicationCounts.INTERVIEWING;
	const offers = applicationCounts.OFFER;
	const rejected = applicationCounts.REJECTED;

	return {
		generatedAt: now.toISOString(),
		applications: {
			total: applied + interviewing + offers + rejected,
			saved: applicationCounts.SAVED,
			applied,
			interviewing,
			offers,
			rejected,
			archived: applicationCounts.ARCHIVED,
			inProgress: applied + interviewing,
		},
		networking: {
			tracked: PROSPECT_STATUSES.reduce(
				(total, status) => total + prospectCounts[status],
				0,
			),
			discovered: prospectCounts.DISCOVERED + prospectCounts.PREPARING,
			drafts: prospectCounts.DRAFT_READY,
			sent:
				prospectCounts.SENDING +
				prospectCounts.SENT +
				prospectCounts.REPLIED,
			replied: prospectCounts.REPLIED,
			rejected: prospectCounts.REJECTED,
			errors: prospectCounts.ERROR,
		},
		topCompanies: companyRows.results.map((row) => ({
			company: row.company,
			count: Number(row.count),
		})),
		activity: { from, to, days },
		recentActivity: recentRows.results.map(mapActivity),
	};
}

function completeCounts<const T extends readonly string[]>(
	statuses: T,
	rows: CountRow[],
): Record<T[number], number> {
	const counts = Object.fromEntries(
		statuses.map((status) => [status, 0]),
	) as Record<T[number], number>;
	for (const row of rows) {
		if (row.status in counts) {
			counts[row.status as T[number]] = Number(row.count);
		}
	}
	return counts;
}

function mapActivity(row: ActivityRow): UserAnalytics["recentActivity"][number] {
	const labels: Record<string, string> = {
		BETA_ACCESS_APPROVED: "Beta access approved",
		BETA_ACCESS_REQUEST_APPROVED: "Beta request approved",
		BETA_ACCESS_REQUEST_DENIED: "Beta request denied",
		BETA_ACCESS_REVOKED: "Beta access revoked",
		CREDENTIAL_DELETED: "Provider credential removed",
		CREDENTIAL_UPDATED: "Provider credential updated",
		DISCOVERY_COMPLETED: "People search completed",
		DRAFT_EDITED: "Outreach draft edited",
		DRAFT_PREPARED: "Outreach draft prepared",
		DRAFT_REGENERATED: "Outreach draft regenerated",
		EMAIL_SENT: "Outreach email sent",
		JOB_STATE_DELETED: "Job removed from tracker",
		JOB_STATE_UPDATED: "Application stage updated",
		LEGACY_JOB_STATE_IMPORTED: "Legacy job progress imported",
		LEGACY_JOB_STATE_UNMATCHED: "Legacy import needs another match attempt",
		PROSPECT_REJECTED: "Networking prospect rejected",
		RESUME_DELETED: "Resume deleted",
		RESUME_IMPORTED: "Resume imported",
		SETTINGS_UPDATED: "Profile settings updated",
		WORKSPACE_INITIALIZED: "Google workspace initialized",
	};
	const jobContext = [row.job_company, row.job_title]
		.filter(Boolean)
		.join(" — ");
	return {
		action: row.action,
		label: labels[row.action] ?? titleCase(row.action),
		context: jobContext || row.prospect_name || "",
		createdAt: row.created_at,
	};
}

function titleCase(value: string): string {
	return value
		.toLowerCase()
		.split("_")
		.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
		.join(" ");
}

function dateKey(value: Date): string {
	return value.toISOString().slice(0, 10);
}
