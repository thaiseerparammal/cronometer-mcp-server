import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	CronometerClient,
	type CronometerSession,
} from "./lib/client.js";
import { handleError } from "./lib/errors.js";
import {
	type Macros,
	averageMacros,
	enumerateDates,
	MEAL_GROUPS,
	type MealName,
	nowTime,
	parseConsumed,
	parseDiary,
	parseFoodSearch,
	parseGoals,
	toCronoDay,
	todayDate,
	validateDate,
} from "./lib/transforms.js";
import type { Env, Props } from "./types.js";

function macroLine(m: Macros): string {
	return `${m.calories} kcal · P ${m.protein}g · C ${m.carbs}g · F ${m.fat}g`;
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Cronometer",
		version: "1.0.0",
		title: "Cronometer Nutrition",
	});

	/** Cached session, reused across tool calls within this agent instance. */
	private session: CronometerSession | null = null;

	/** Build a client from the configured credentials, reusing any cached session. */
	private getClient(): CronometerClient {
		const email = this.env.CRONOMETER_EMAIL;
		const password = this.env.CRONOMETER_PASSWORD;
		if (!email || !password) {
			throw new Error(
				"Cronometer credentials are not configured. Set the CRONOMETER_EMAIL and CRONOMETER_PASSWORD secrets with `wrangler secret put`.",
			);
		}
		return new CronometerClient({
			email,
			password,
			session: this.session,
			onSession: (s) => {
				this.session = s;
			},
		});
	}

	async init() {
		// ============================================
		// READ — DIARY (per-day food log + daily totals)
		// ============================================
		this.server.tool(
			"get_nutrition_diary",
			{
				date: z
					.string()
					.optional()
					.describe("Date in YYYY-MM-DD format. Defaults to today."),
			},
			async ({ date }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");
					const cronoDay = toCronoDay(d);

					const client = this.getClient();
					const diaryRaw = await client.getDiary(cronoDay);

					const entries = parseDiary(diaryRaw);
					const totals = parseConsumed(diaryRaw);

					const list =
						entries.length > 0
							? entries
									.map((e) => {
										const grams = e.grams != null ? ` — ${e.grams} g` : "";
										return `   - ${e.name}${grams}`;
									})
									.join("\n")
							: "No food logged for this date.";

					return {
						content: [
							{
								type: "text",
								text: `Nutrition diary for ${d}\nDaily totals: ${macroLine(totals)}`,
							},
							{ type: "text", text: `Logged foods:\n${list}` },
							{
								type: "text",
								text: `\n\nRaw diary:\n${JSON.stringify(diaryRaw, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// READ — SUMMARY OVER A RANGE
		// ============================================
		this.server.tool(
			"get_nutrition_summary",
			{
				start_date: z.string().describe("Start date (YYYY-MM-DD), inclusive."),
				end_date: z.string().describe("End date (YYYY-MM-DD), inclusive."),
			},
			async ({ start_date, end_date }) => {
				try {
					validateDate(start_date, "start_date");
					validateDate(end_date, "end_date");

					const dates = enumerateDates(start_date, end_date, 31);
					const client = this.getClient();

					const daily: Array<{ date: string } & Macros> = [];
					for (const d of dates) {
						const diaryRaw = await client.getDiary(toCronoDay(d));
						const m = parseConsumed(diaryRaw);
						daily.push({ date: d, ...m });
					}

					const overall = averageMacros(daily);
					const last7 = averageMacros(daily.slice(-7));

					const rows = daily.map((d) => `${d.date}: ${macroLine(d)}`).join("\n");

					return {
						content: [
							{
								type: "text",
								text: `Nutrition summary ${start_date} → ${end_date} (${daily.length} days)`,
							},
							{
								type: "text",
								text: `Average over range: ${macroLine(overall)}\n7-day average (most recent): ${macroLine(last7)}`,
							},
							{ type: "text", text: `Daily totals:\n${rows}` },
							{ type: "text", text: `\n\nRaw daily data:\n${JSON.stringify(daily, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// READ — GOALS (macro targets)
		// ============================================
		this.server.tool("get_goals", {}, async () => {
			try {
				const client = this.getClient();
				// Goal targets are computed into the diary summary (summary.macros).
				const diaryRaw = await client.getDiary(toCronoDay(todayDate()));
				const { goals, raw } = parseGoals(diaryRaw);

				return {
					content: [
						{
							type: "text",
							text: `Daily goals\nCalories: ${goals.calories} kcal\nProtein: ${goals.protein} g\nCarbs: ${goals.carbs} g\nFat: ${goals.fat} g`,
						},
						{ type: "text", text: `\n\nRaw summary:\n${JSON.stringify(raw, null, 2)}` },
					],
				};
			} catch (error) {
				return handleError(error);
			}
		});

		// ============================================
		// READ — FOOD SEARCH
		// ============================================
		this.server.tool(
			"search_food",
			{
				query: z.string().describe("Food to search for, e.g. 'chicken breast'."),
				max_results: z
					.number()
					.int()
					.min(1)
					.max(20)
					.optional()
					.default(5)
					.describe("Maximum number of results (default 5, max 20)."),
			},
			async ({ query, max_results }) => {
				try {
					const client = this.getClient();
					const raw = await client.searchFood(query);
					const results = parseFoodSearch(raw).slice(0, max_results);

					const list =
						results.length > 0
							? results
									.map((r, i) => {
										const src = r.source ? ` [${r.source}]` : "";
										const ids =
											`\n   food_id: ${r.id ?? "?"}` +
											(r.measureId != null ? `, measure_id: ${r.measureId}` : "");
										return `${i + 1}. ${r.name}${src}${ids}`;
									})
									.join("\n")
							: "No foods found (see raw response).";

					return {
						content: [
							{ type: "text", text: `Search results for "${query}"` },
							{ type: "text", text: list },
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WRITE — LOG FOOD (add a serving to the diary)
		// ============================================
		this.server.tool(
			"log_food",
			{
				meal_name: z
					.enum(["breakfast", "lunch", "dinner", "snacks"])
					.describe("Which meal to log under."),
				food_id: z
					.number()
					.int()
					.describe("Cronometer food_id (from search_food)."),
				grams: z
					.number()
					.positive()
					.describe("Amount in grams to log."),
				measure_id: z
					.number()
					.int()
					.optional()
					.describe(
						"Measure/unit id (from search_food). Required for database foods; 0 is only valid for custom foods.",
					),
				date: z
					.string()
					.optional()
					.describe("Date in YYYY-MM-DD format. Defaults to today."),
			},
			async ({ meal_name, food_id, grams, measure_id, date }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");

					const client = this.getClient();

					// Resolve a measure id if none provided: prefer the food's default.
					let resolvedMeasureId = measure_id;
					if (resolvedMeasureId == null) {
						const food = await client.getFood(food_id);
						resolvedMeasureId =
							food?.defaultMeasureId ??
							food?.measures?.[0]?.id ??
							0;
					}

					const raw = await client.addServing({
						foodId: food_id,
						measureId: resolvedMeasureId ?? 0,
						grams,
						day: toCronoDay(d),
						time: nowTime(),
						mealGroup: MEAL_GROUPS[meal_name as MealName],
					});

					return {
						content: [
							{
								type: "text",
								text: `✓ Logged ${grams} g of food ${food_id} to ${meal_name} on ${d}.`,
							},
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);
	}
}
