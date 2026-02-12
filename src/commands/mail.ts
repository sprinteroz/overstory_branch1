/**
 * CLI command: overstory mail send/check/list/read/reply
 *
 * Parses CLI args and delegates to the mail client.
 * Supports --inject for hook context injection, --json for machine output,
 * and various filters for listing messages.
 */

import { join } from "node:path";
import { MailError, ValidationError } from "../errors.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { MailMessage } from "../types.ts";

/**
 * Parse a named flag value from an args array.
 * Returns the value after the flag, or undefined if not present.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/** Check if a boolean flag is present in the args. */
function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/** Format a single message for human-readable output. */
function formatMessage(msg: MailMessage): string {
	const readMarker = msg.read ? " " : "*";
	const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
	const lines: string[] = [
		`${readMarker} ${msg.id}  From: ${msg.from} → To: ${msg.to}${priorityTag}`,
		`  Subject: ${msg.subject}  (${msg.type})`,
		`  ${msg.body}`,
		`  ${msg.createdAt}`,
	];
	return lines.join("\n");
}

/**
 * Open a mail client connected to the project's mail.db.
 * Resolves the path relative to cwd/.overstory/mail.db.
 */
function openClient(cwd: string) {
	const dbPath = join(cwd, ".overstory", "mail.db");
	const store = createMailStore(dbPath);
	const client = createMailClient(store);
	return client;
}

/** overstory mail send */
function handleSend(args: string[], cwd: string): void {
	const to = getFlag(args, "--to");
	const subject = getFlag(args, "--subject");
	const body = getFlag(args, "--body");
	const from = getFlag(args, "--agent") ?? getFlag(args, "--from") ?? "orchestrator";
	const type = (getFlag(args, "--type") ?? "status") as MailMessage["type"];
	const priority = (getFlag(args, "--priority") ?? "normal") as MailMessage["priority"];

	if (!to) {
		throw new ValidationError("--to is required for mail send", { field: "to" });
	}
	if (!subject) {
		throw new ValidationError("--subject is required for mail send", { field: "subject" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail send", { field: "body" });
	}

	const client = openClient(cwd);
	try {
		const id = client.send({ from, to, subject, body, type, priority });

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id })}\n`);
		} else {
			process.stdout.write(`✉️  Sent message ${id} to ${to}\n`);
		}
	} finally {
		client.close();
	}
}

/** overstory mail check */
function handleCheck(args: string[], cwd: string): void {
	const agent = getFlag(args, "--agent") ?? "orchestrator";
	const inject = hasFlag(args, "--inject");
	const json = hasFlag(args, "--json");

	const client = openClient(cwd);
	try {
		if (inject) {
			const output = client.checkInject(agent);
			if (output.length > 0) {
				process.stdout.write(output);
			}
			return;
		}

		const messages = client.check(agent);

		if (json) {
			process.stdout.write(`${JSON.stringify(messages)}\n`);
		} else if (messages.length === 0) {
			process.stdout.write("No new messages.\n");
		} else {
			process.stdout.write(
				`📬 ${messages.length} new message${messages.length === 1 ? "" : "s"}:\n\n`,
			);
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
		}
	} finally {
		client.close();
	}
}

/** overstory mail list */
function handleList(args: string[], cwd: string): void {
	const from = getFlag(args, "--from");
	const to = getFlag(args, "--to");
	const unread = hasFlag(args, "--unread") ? true : undefined;
	const json = hasFlag(args, "--json");

	const client = openClient(cwd);
	try {
		const messages = client.list({ from, to, unread });

		if (json) {
			process.stdout.write(`${JSON.stringify(messages)}\n`);
		} else if (messages.length === 0) {
			process.stdout.write("No messages found.\n");
		} else {
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
			process.stdout.write(
				`Total: ${messages.length} message${messages.length === 1 ? "" : "s"}\n`,
			);
		}
	} finally {
		client.close();
	}
}

/** overstory mail read */
function handleRead(args: string[], cwd: string): void {
	const id = args.find((a) => !a.startsWith("--"));
	if (!id) {
		throw new ValidationError("Message ID is required for mail read", { field: "id" });
	}

	const client = openClient(cwd);
	try {
		client.markRead(id);
		process.stdout.write(`Marked ${id} as read.\n`);
	} finally {
		client.close();
	}
}

/** overstory mail reply */
function handleReply(args: string[], cwd: string): void {
	const id = args.find((a) => !a.startsWith("--"));
	const body = getFlag(args, "--body");
	const from = getFlag(args, "--agent") ?? getFlag(args, "--from") ?? "orchestrator";

	if (!id) {
		throw new ValidationError("Message ID is required for mail reply", { field: "id" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail reply", { field: "body" });
	}

	const client = openClient(cwd);
	try {
		const replyId = client.reply(id, body, from);

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id: replyId })}\n`);
		} else {
			process.stdout.write(`✉️  Reply sent: ${replyId}\n`);
		}
	} finally {
		client.close();
	}
}

/**
 * Entry point for `overstory mail <subcommand> [args...]`.
 *
 * Subcommands: send, check, list, read, reply.
 */
export async function mailCommand(args: string[]): Promise<void> {
	const subcommand = args[0];
	const subArgs = args.slice(1);
	const cwd = process.cwd();

	switch (subcommand) {
		case "send":
			handleSend(subArgs, cwd);
			break;
		case "check":
			handleCheck(subArgs, cwd);
			break;
		case "list":
			handleList(subArgs, cwd);
			break;
		case "read":
			handleRead(subArgs, cwd);
			break;
		case "reply":
			handleReply(subArgs, cwd);
			break;
		default:
			throw new MailError(
				`Unknown mail subcommand: ${subcommand ?? "(none)"}. Use: send, check, list, read, reply`,
			);
	}
}
