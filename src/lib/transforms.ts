/**
 * Validation and nutrition-parsing helpers for the Cronometer mobile API.
 *
 * The mobile API's JSON response shapes are reverse-engineered, so the parsers
 * are intentionally defensive: they accept several field-name / structure
 * variants and coerce values rather than assuming one rigid schema. Every tool
 * also returns the raw API JSON, so data is usable even if a field differs.
 */

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/** Macro totals used throughout the tools. */
export interface Macros {
	calories: number;
	protein: number;
	carbs: number;
	fat: number;
}

/** Cronometer meal groups. */
export const MEAL_GROUPS = {
	breakfast: 1,
	lunch: 2,
	dinner: 3,
	snacks: 4,
} as const;

export type MealName = keyof typeof MEAL_GROUPS;

/** Reverse map: meal group number → name (for display). */
export const MEAL_NAMES: Record<number, string> = {
	1: "breakfast",
	2: "lunch",
	3: "dinner",
	4: "snacks",
};

/**
 * Default IANA timezone used when the Worker has no TIMEZONE var configured.
 *
 * A Cloudflare Worker always runs with its process clock in UTC, so every
 * "today" / "now" the server derives must be converted into the user's own
 * zone explicitly. Leaving this at UTC reproduces the original behaviour.
 */
export const DEFAULT_TIMEZONE = "UTC";

/** Validate an IANA timezone name, falling back to UTC if unusable. */
export function resolveTimeZone(tz?: string | null): string {
	const candidate = (tz ?? "").trim();
	if (!candidate) {
		return DEFAULT_TIMEZONE;
	}
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format();
		return candidate;
	} catch {
		console.warn(
			`Invalid TIMEZONE "${candidate}" — falling back to ${DEFAULT_TIMEZONE}.`,
		);
		return DEFAULT_TIMEZONE;
	}
}

export interface ZonedParts {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
	second: string;
}

/** Wall-clock parts of an instant, as seen in the given IANA timezone. */
export function zonedParts(
	timeZone: string = DEFAULT_TIMEZONE,
	at: Date = new Date(),
): ZonedParts {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: resolveTimeZone(timeZone),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		// h23 rather than hour12:false: the latter can yield "24" at midnight.
		hourCycle: "h23",
	}).formatToParts(at);

	const out: Record<string, string> = {};
	for (const { type, value } of parts) {
		out[type] = value;
	}
	return out as unknown as ZonedParts;
}

/** Today's date in YYYY-MM-DD, as seen in the given timezone. */
export function todayDate(timeZone: string = DEFAULT_TIMEZONE): string {
	const { year, month, day } = zonedParts(timeZone);
	return `${year}-${month}-${day}`;
}

/**
 * Shift a YYYY-MM-DD date by a whole number of days.
 *
 * Pure calendar arithmetic on the date string — deliberately not
 * `Date.now() - n * 86400000`, which drifts across a DST boundary and, worse,
 * resolves against UTC rather than the user's zone.
 */
export function shiftDate(date: string, days: number): string {
	const base = new Date(`${date}T00:00:00Z`);
	base.setUTCDate(base.getUTCDate() + days);
	return base.toISOString().slice(0, 10);
}

/** The UTC offset of a timezone at an instant, in minutes (IST → 330). */
export function timeZoneOffsetMinutes(
	timeZone: string = DEFAULT_TIMEZONE,
	at: Date = new Date(),
): number {
	const { year, month, day, hour, minute, second } = zonedParts(timeZone, at);
	const asUtc = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
	);
	// Wall clock minus the real instant (seconds truncated on both sides).
	return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Validate a YYYY-MM-DD date string. */
export function validateDate(date: string, fieldName: string): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new ValidationError(
			`${fieldName} must be in YYYY-MM-DD format (e.g., 2026-05-26), got "${date}"`,
		);
	}
	const parsed = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw new ValidationError(`${fieldName} is not a valid date: "${date}"`);
	}
}

/**
 * Convert YYYY-MM-DD to Cronometer's non-zero-padded YYYY-M-D format.
 * e.g. "2026-05-06" → "2026-5-6".
 */
export function toCronoDay(date: string): string {
	const [y, m, d] = date.split("-");
	return `${Number(y)}-${Number(m)}-${Number(d)}`;
}

/**
 * Current wall-clock time as HH:MM:SS in the given timezone.
 *
 * Cronometer stores a diary serving's `time` as the local wall clock of the
 * meal, so sending the Worker's UTC clock makes every entry appear shifted by
 * the zone offset (a 13:00 IST lunch shows up as 07:30).
 */
export function nowTime(timeZone: string = DEFAULT_TIMEZONE): string {
	const { hour, minute, second } = zonedParts(timeZone);
	return `${hour}:${minute}:${second}`;
}

/**
 * Normalise a user-supplied time of day to the HH:MM:SS the diary expects.
 *
 * Accepts 24-hour ("7:30", "07:30:15", "19:05") and, because a model relaying
 * what someone said will often keep their wording, 12-hour with a suffix
 * ("7:30 am", "7:30PM"). Seconds are optional and default to 00.
 */
export function normalizeTime(input: string, fieldName = "time"): string {
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(
		input.trim(),
	);
	if (!match) {
		throw new ValidationError(
			`${fieldName} must look like HH:MM or HH:MM:SS, optionally with am/pm (e.g. "07:30", "7:30 am", "19:05:00"), got "${input}"`,
		);
	}

	const [, rawHour, rawMinute, rawSecond, meridiem] = match;
	let hour = Number(rawHour);
	const minute = Number(rawMinute);
	const second = Number(rawSecond ?? "0");

	if (meridiem) {
		if (hour < 1 || hour > 12) {
			throw new ValidationError(
				`${fieldName} hour must be 1-12 when am/pm is given, got "${input}"`,
			);
		}
		hour = meridiem.toLowerCase() === "pm" ? (hour % 12) + 12 : hour % 12;
	} else if (hour > 23) {
		throw new ValidationError(
			`${fieldName} hour must be 0-23, got "${input}"`,
		);
	}

	if (minute > 59 || second > 59) {
		throw new ValidationError(
			`${fieldName} minutes and seconds must be 0-59, got "${input}"`,
		);
	}

	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/** Coerce a value that may be a number, numeric string, or { value/amount }. */
function num(value: unknown): number {
	if (value == null) {
		return 0;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : 0;
	}
	if (typeof value === "string") {
		const n = Number.parseFloat(value);
		return Number.isFinite(n) ? n : 0;
	}
	if (typeof value === "object") {
		const v = value as Record<string, unknown>;
		return num(v.amount ?? v.value);
	}
	return 0;
}

function round(m: Macros): Macros {
	return {
		calories: Math.round(m.calories),
		protein: Math.round(m.protein * 10) / 10,
		carbs: Math.round(m.carbs * 10) / 10,
		fat: Math.round(m.fat * 10) / 10,
	};
}

function addMacros(a: Macros, b: Macros): Macros {
	return {
		calories: a.calories + b.calories,
		protein: a.protein + b.protein,
		carbs: a.carbs + b.carbs,
		fat: a.fat + b.fat,
	};
}

/**
 * Daily consumed macro totals, read from a get_diary response's
 * `summary.consumed` block: { total (kcal), protein_g, carbs_g, fat_g }.
 */
export function parseConsumed(diaryResponse: any): Macros {
	const c = diaryResponse?.summary?.consumed ?? {};
	return round({
		calories: num(c.total ?? c.energy_kcal ?? c.kcal),
		protein: num(c.protein_g),
		carbs: num(c.carbs_g),
		fat: num(c.fat_g),
	});
}

export interface DiaryEntry {
	name: string;
	servingId?: string | number;
	foodId?: number;
	grams?: number;
	mealGroup?: number;
}

/** Parse a get_diary response into a compact list of logged entries. */
export function parseDiary(response: any): DiaryEntry[] {
	const items: any[] = Array.isArray(response?.diary)
		? response.diary
		: Array.isArray(response?.entries)
			? response.entries
			: Array.isArray(response)
				? response
				: [];

	return items
		.filter((e) => e && (e.type === undefined || e.type === "Serving"))
		.map((e) => ({
			name:
				e.foodName ??
				e.name ??
				e.description ??
				e.food?.name ??
				`Food ${e.foodId ?? "?"}`,
			servingId: e.servingId ?? e.id,
			foodId: e.foodId,
			grams: typeof e.grams === "number" ? e.grams : undefined,
			mealGroup: typeof e.order === "number" ? e.order >> 16 : undefined,
		}));
}

export interface FoodResult {
	id?: number;
	name: string;
	measureId?: number;
	translationId?: number;
	source?: string;
}

/** Parse a find_food response into a compact result list. */
export function parseFoodSearch(response: any): FoodResult[] {
	const foods: any[] = Array.isArray(response?.foods)
		? response.foods
		: Array.isArray(response?.results)
			? response.results
			: Array.isArray(response)
				? response
				: [];

	return foods.map((f) => ({
		id: f.id ?? f.foodId,
		name: f.name ?? f.description ?? f.measureDisplayName ?? "Unknown food",
		measureId: f.measureId ?? f.measure_id,
		translationId: f.translationId ?? f.translation_id ?? 0,
		source: f.source,
	}));
}

/**
 * Daily macro goal targets. Cronometer computes these into a get_diary
 * response's `summary.macros` block: { energy (kcal), protein, carbs, fat }
 * in grams. (The get_macro_target_templates endpoint returns only percentages
 * and is often empty, so the diary summary is the reliable source.)
 */
export function parseGoals(diaryResponse: any): { goals: Macros; raw: any } {
	const m = diaryResponse?.summary?.macros ?? {};
	return {
		goals: round({
			calories: num(m.energy ?? m.kcal),
			protein: num(m.protein),
			carbs: num(m.carbs ?? m.total_carbs ?? m.carbohydrates),
			fat: num(m.fat),
		}),
		raw: diaryResponse?.summary ?? diaryResponse,
	};
}

/** Average a list of macro totals. */
export function averageMacros(days: Macros[]): Macros {
	if (days.length === 0) {
		return { calories: 0, protein: 0, carbs: 0, fat: 0 };
	}
	let sum: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0 };
	for (const d of days) {
		sum = addMacros(sum, d);
	}
	return round({
		calories: sum.calories / days.length,
		protein: sum.protein / days.length,
		carbs: sum.carbs / days.length,
		fat: sum.fat / days.length,
	});
}

/**
 * Inclusive list of YYYY-MM-DD dates from start to end. Throws if the range is
 * reversed or exceeds maxDays.
 */
export function enumerateDates(start: string, end: string, maxDays = 31): string[] {
	const startMs = Date.parse(`${start}T00:00:00Z`);
	const endMs = Date.parse(`${end}T00:00:00Z`);
	if (endMs < startMs) {
		throw new ValidationError("end_date must be on or after start_date");
	}
	const dayMs = 86_400_000;
	const count = Math.floor((endMs - startMs) / dayMs) + 1;
	if (count > maxDays) {
		throw new ValidationError(
			`Date range too large: ${count} days (max ${maxDays}). Narrow start_date/end_date.`,
		);
	}
	const dates: string[] = [];
	for (let i = 0; i < count; i++) {
		dates.push(new Date(startMs + i * dayMs).toISOString().slice(0, 10));
	}
	return dates;
}
