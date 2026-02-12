/**
 * Metrics reporting utilities.
 *
 * Generates summary statistics from a MetricsStore and formats them
 * for human-readable console output.
 */

import type { SessionMetrics } from "../types.ts";
import type { MetricsStore } from "./store.ts";

export interface MetricsSummary {
	totalSessions: number;
	completedSessions: number;
	averageDurationMs: number;
	byCapability: Record<string, { count: number; avgDurationMs: number }>;
	recentSessions: SessionMetrics[];
}

/**
 * Generate an aggregate summary from the metrics store.
 *
 * @param store - The MetricsStore to query
 * @param limit - Maximum number of recent sessions to include (default 10)
 */
export function generateSummary(store: MetricsStore, limit = 10): MetricsSummary {
	const recentSessions = store.getRecentSessions(limit);

	// Fetch all sessions for aggregate stats (use a generous limit)
	const allSessions = store.getRecentSessions(10_000);

	const totalSessions = allSessions.length;
	const completedSessions = allSessions.filter((s) => s.completedAt !== null).length;
	const averageDurationMs = store.getAverageDuration();

	// Group by capability
	const capabilityMap = new Map<string, { count: number; totalMs: number }>();
	for (const session of allSessions) {
		const existing = capabilityMap.get(session.capability);
		if (existing) {
			existing.count++;
			if (session.completedAt !== null) {
				existing.totalMs += session.durationMs;
			}
		} else {
			capabilityMap.set(session.capability, {
				count: 1,
				totalMs: session.completedAt !== null ? session.durationMs : 0,
			});
		}
	}

	const byCapability: Record<string, { count: number; avgDurationMs: number }> = {};
	for (const [capability, data] of capabilityMap) {
		const completedInCap = allSessions.filter(
			(s) => s.capability === capability && s.completedAt !== null,
		).length;
		byCapability[capability] = {
			count: data.count,
			avgDurationMs: completedInCap > 0 ? Math.round(data.totalMs / completedInCap) : 0,
		};
	}

	return {
		totalSessions,
		completedSessions,
		averageDurationMs: Math.round(averageDurationMs),
		byCapability,
		recentSessions,
	};
}

/**
 * Format a MetricsSummary into a human-readable string for console output.
 */
export function formatSummary(summary: MetricsSummary): string {
	const lines: string[] = [];

	lines.push("=== Session Metrics ===");
	lines.push("");
	lines.push(`Total sessions:     ${summary.totalSessions}`);
	lines.push(`Completed:          ${summary.completedSessions}`);
	lines.push(`Average duration:   ${formatDuration(summary.averageDurationMs)}`);

	const capabilities = Object.entries(summary.byCapability);
	if (capabilities.length > 0) {
		lines.push("");
		lines.push("By capability:");
		for (const [cap, data] of capabilities) {
			lines.push(`  ${cap}: ${data.count} sessions, avg ${formatDuration(data.avgDurationMs)}`);
		}
	}

	if (summary.recentSessions.length > 0) {
		lines.push("");
		lines.push("Recent sessions:");
		for (const session of summary.recentSessions) {
			const status = session.completedAt !== null ? "done" : "running";
			const duration =
				session.completedAt !== null ? formatDuration(session.durationMs) : "in progress";
			lines.push(`  ${session.agentName} [${session.capability}] ${status} (${duration})`);
		}
	}

	return lines.join("\n");
}

/** Format milliseconds into a human-friendly duration string. */
function formatDuration(ms: number): string {
	if (ms < 1_000) {
		return `${ms}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1_000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}m ${seconds}s`;
}
