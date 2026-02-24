/**
 * CLI command: overstory spec write <bead-id> --body <content>
 *
 * Writes a task specification to `.overstory/specs/<bead-id>.md`.
 * Scouts use this to persist spec documents as files instead of
 * sending entire specs via mail messages.
 *
 * Supports reading body content from --body flag or stdin.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";

export interface SpecWriteOptions {
	body?: string;
	agent?: string;
}

/**
 * Read all of stdin as a string. Returns empty string if stdin is a TTY
 * (no piped input).
 */
async function readStdin(): Promise<string> {
	// Bun.stdin is a ReadableStream when piped, a TTY otherwise
	if (process.stdin.isTTY) {
		return "";
	}
	return await new Response(Bun.stdin.stream()).text();
}

/**
 * Write a spec file to .overstory/specs/<bead-id>.md.
 *
 * Exported for direct use in tests.
 */
export async function writeSpec(
	projectRoot: string,
	beadId: string,
	body: string,
	agent?: string,
): Promise<string> {
	const specsDir = join(projectRoot, ".overstory", "specs");
	await mkdir(specsDir, { recursive: true });

	// Build the spec content with optional attribution header
	let content = "";
	if (agent) {
		content += `<!-- written-by: ${agent} -->\n`;
	}
	content += body;

	// Ensure trailing newline
	if (!content.endsWith("\n")) {
		content += "\n";
	}

	const specPath = join(specsDir, `${beadId}.md`);
	await Bun.write(specPath, content);

	return specPath;
}

/**
 * Entry point for `overstory spec write <bead-id> [flags]`.
 *
 * @param beadId - The bead/task ID for the spec file
 * @param opts - Command options
 */
export async function specWriteCommand(beadId: string, opts: SpecWriteOptions): Promise<void> {
	if (!beadId || beadId.trim().length === 0) {
		throw new ValidationError(
			"Bead ID is required: overstory spec write <bead-id> --body <content>",
			{ field: "beadId" },
		);
	}

	let body = opts.body;

	// If no --body flag, try reading from stdin
	if (body === undefined) {
		const stdinContent = await readStdin();
		if (stdinContent.trim().length > 0) {
			body = stdinContent;
		}
	}

	if (body === undefined || body.trim().length === 0) {
		throw new ValidationError("Spec body is required: use --body <content> or pipe via stdin", {
			field: "body",
		});
	}

	const { resolveProjectRoot } = await import("../config.ts");
	const projectRoot = await resolveProjectRoot(process.cwd());

	const specPath = await writeSpec(projectRoot, beadId, body, opts.agent);
	process.stdout.write(`${specPath}\n`);
}
