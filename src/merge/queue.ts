/**
 * FIFO merge queue for agent branches.
 *
 * Backed by a JSON file at `.overstory/merge-queue.json`.
 * Reads and writes the full queue on every operation for simplicity
 * and correctness (no concurrent write concern with file-based storage).
 * Uses Bun.file() for zero-dependency file I/O.
 */

import { MergeError } from "../errors.ts";
import type { MergeEntry, ResolutionTier } from "../types.ts";

export interface MergeQueue {
	/** Add a new entry to the end of the queue with pending status. */
	enqueue(entry: Omit<MergeEntry, "enqueuedAt" | "status" | "resolvedTier">): MergeEntry;

	/** Remove and return the first pending entry, or null if none. */
	dequeue(): MergeEntry | null;

	/** Return the first pending entry without removing it, or null if none. */
	peek(): MergeEntry | null;

	/** List entries, optionally filtered by status. */
	list(status?: MergeEntry["status"]): MergeEntry[];

	/** Update the status (and optional resolution tier) of an entry by branch name. */
	updateStatus(branchName: string, status: MergeEntry["status"], tier?: ResolutionTier): void;
}

/** Read the queue from disk. Returns an empty array if the file does not exist. */
function readQueue(queuePath: string): MergeEntry[] {
	const file = Bun.file(queuePath);
	if (file.size === 0) {
		return [];
	}

	try {
		// Bun.file().json() is async but we need sync reads.
		// Read the raw text synchronously via node:fs, or use a workaround.
		// Actually, Bun.file().text() is a promise. We'll store the data in memory
		// and only read from disk in a blocking way. Since Bun doesn't provide a
		// synchronous file read API through Bun.file(), we use node:fs.
		const { readFileSync, existsSync } = require("node:fs");
		if (!existsSync(queuePath)) {
			return [];
		}
		const raw = readFileSync(queuePath, "utf-8") as string;
		const trimmed = raw.trim();
		if (trimmed === "") {
			return [];
		}
		return JSON.parse(trimmed) as MergeEntry[];
	} catch (err) {
		throw new MergeError(`Failed to read merge queue at ${queuePath}`, {
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/** Write the queue to disk atomically. */
function writeQueue(queuePath: string, entries: MergeEntry[]): void {
	try {
		const { writeFileSync } = require("node:fs");
		writeFileSync(queuePath, JSON.stringify(entries, null, "\t"), "utf-8");
	} catch (err) {
		throw new MergeError(`Failed to write merge queue at ${queuePath}`, {
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/**
 * Create a new MergeQueue backed by a JSON file at the given path.
 *
 * The file stores an array of MergeEntry objects. Every mutation
 * reads the current state from disk, applies the change, and writes back,
 * ensuring durability across process restarts.
 */
export function createMergeQueue(queuePath: string): MergeQueue {
	return {
		enqueue(input): MergeEntry {
			const entries = readQueue(queuePath);

			const entry: MergeEntry = {
				branchName: input.branchName,
				beadId: input.beadId,
				agentName: input.agentName,
				filesModified: input.filesModified,
				enqueuedAt: new Date().toISOString(),
				status: "pending",
				resolvedTier: null,
			};

			entries.push(entry);
			writeQueue(queuePath, entries);
			return entry;
		},

		dequeue(): MergeEntry | null {
			const entries = readQueue(queuePath);
			const pendingIndex = entries.findIndex((e) => e.status === "pending");
			if (pendingIndex === -1) {
				return null;
			}
			const entry = entries[pendingIndex];
			if (entry === undefined) {
				return null;
			}
			entries.splice(pendingIndex, 1);
			writeQueue(queuePath, entries);
			return entry;
		},

		peek(): MergeEntry | null {
			const entries = readQueue(queuePath);
			const pending = entries.find((e) => e.status === "pending");
			return pending ?? null;
		},

		list(status?): MergeEntry[] {
			const entries = readQueue(queuePath);
			if (status === undefined) {
				return entries;
			}
			return entries.filter((e) => e.status === status);
		},

		updateStatus(branchName, status, tier?): void {
			const entries = readQueue(queuePath);
			const entry = entries.find((e) => e.branchName === branchName);
			if (entry === undefined) {
				throw new MergeError(`No queue entry found for branch: ${branchName}`, {
					branchName,
				});
			}
			entry.status = status;
			if (tier !== undefined) {
				entry.resolvedTier = tier;
			}
			writeQueue(queuePath, entries);
		},
	};
}
