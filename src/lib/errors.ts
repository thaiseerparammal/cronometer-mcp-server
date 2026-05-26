import { CronometerApiError } from "./client.js";
import { ValidationError } from "./transforms.js";

/** MCP tool response shape. */
export interface McpToolResponse {
	[x: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

const STATUS_CODE_MESSAGES: Record<number, string> = {
	400: "Invalid request parameters",
	401: "Cronometer authentication failed",
	403: "Forbidden — Cronometer blocked or rate-limited the request",
	404: "Resource not found",
	429: "Rate limit exceeded",
	500: "Cronometer API error",
	502: "Cronometer API returned an unexpected response",
	503: "Cronometer API is temporarily unavailable",
};

function getStatusMessage(status: number): string {
	return STATUS_CODE_MESSAGES[status] || `Unexpected error (HTTP ${status})`;
}

/** Format a CronometerApiError into an MCP tool response, preserving API detail. */
export function formatCronometerApiError(error: CronometerApiError): McpToolResponse {
	const parts: string[] = [];
	parts.push(`❌ ${getStatusMessage(error.status)}`);
	parts.push("");
	parts.push("**What went wrong:**");
	parts.push(error.message);

	if (error.data) {
		if (typeof error.data === "string") {
			parts.push("");
			parts.push("**Details:**");
			parts.push(error.data);
		} else if (typeof error.data === "object") {
			const data = error.data as Record<string, unknown>;
			let known = false;
			if (data.error) {
				known = true;
				parts.push("");
				parts.push("**Details:**");
				parts.push(String(data.error));
			}
			if (data.message && data.message !== data.error) {
				known = true;
				parts.push("");
				parts.push("**Message:**");
				parts.push(String(data.message));
			}
			if (!known) {
				parts.push("");
				parts.push("**Raw API Response:**");
				parts.push(JSON.stringify(data, null, 2));
			}
		}
	}

	parts.push("");
	parts.push("**How to fix:**");
	switch (error.status) {
		case 400:
			parts.push("  - Check parameter formats (date must be YYYY-MM-DD)");
			parts.push("  - Verify all required parameters are provided");
			break;
		case 401:
			parts.push("  - Verify the CRONOMETER_EMAIL and CRONOMETER_PASSWORD secrets are correct");
			parts.push("  - Reset them with: wrangler secret put CRONOMETER_EMAIL / CRONOMETER_PASSWORD");
			break;
		case 403:
			parts.push("  - Cronometer may be rate-limiting the request — wait and retry");
			break;
		case 404:
			parts.push("  - Verify the resource exists (e.g. a valid food_id / measure_id)");
			break;
		case 429:
			parts.push("  - Wait before making more requests");
			break;
		case 500:
		case 502:
		case 503:
			parts.push("  - Temporary Cronometer issue — try again shortly");
			break;
		default:
			parts.push("  - Review the error details above");
	}

	return { content: [{ type: "text", text: parts.join("\n") }], isError: true };
}

function formatValidationError(error: ValidationError): McpToolResponse {
	return {
		content: [
			{
				type: "text",
				text: `❌ Validation Error\n\n**What went wrong:**\n${error.message}\n\n**How to fix:**\n  - Review the message above and correct the input.`,
			},
		],
		isError: true,
	};
}

/** Central error handler routing errors to the right formatter. */
export function handleError(error: unknown): McpToolResponse {
	if (error instanceof CronometerApiError) {
		return formatCronometerApiError(error);
	}
	if (error instanceof ValidationError) {
		return formatValidationError(error);
	}
	if (error instanceof Error) {
		return { content: [{ type: "text", text: `❌ Error: ${error.message}` }], isError: true };
	}
	return { content: [{ type: "text", text: "❌ An unknown error occurred" }], isError: true };
}
