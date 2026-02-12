/**
 * SQLite-backed mail storage for inter-agent messaging.
 *
 * Provides low-level CRUD operations on the messages table.
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * The higher-level mail client (L2) wraps this store.
 */

import { Database } from "bun:sqlite";
import { MailError } from "../errors.ts";
import type { MailMessage } from "../types.ts";

export interface MailStore {
	insert(message: Omit<MailMessage, "read" | "createdAt">): MailMessage;
	getUnread(agentName: string): MailMessage[];
	getAll(filters?: { from?: string; to?: string; unread?: boolean }): MailMessage[];
	getById(id: string): MailMessage | null;
	getByThread(threadId: string): MailMessage[];
	markRead(id: string): void;
	close(): void;
}

/** Row shape as stored in SQLite (snake_case columns, integer boolean). */
interface MessageRow {
	id: string;
	from_agent: string;
	to_agent: string;
	subject: string;
	body: string;
	type: string;
	priority: string;
	thread_id: string | null;
	read: number;
	created_at: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status',
  priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id)`;

/** Generate a random 12-character alphanumeric ID. */
function randomId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	let result = "";
	for (let i = 0; i < 12; i++) {
		const byte = bytes[i];
		if (byte !== undefined) {
			result += chars[byte % chars.length];
		}
	}
	return result;
}

/** Convert a database row (snake_case) to a MailMessage object (camelCase). */
function rowToMessage(row: MessageRow): MailMessage {
	return {
		id: row.id,
		from: row.from_agent,
		to: row.to_agent,
		subject: row.subject,
		body: row.body,
		type: row.type as MailMessage["type"],
		priority: row.priority as MailMessage["priority"],
		threadId: row.thread_id,
		read: row.read === 1,
		createdAt: row.created_at,
	};
}

/**
 * Create a new MailStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the messages table and indexes if they do not already exist.
 */
export function createMailStore(dbPath: string): MailStore {
	const db = new Database(dbPath);

	// Configure for concurrent access
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	// Prepare statements for all queries
	const insertStmt = db.prepare<
		void,
		{
			$id: string;
			$from_agent: string;
			$to_agent: string;
			$subject: string;
			$body: string;
			$type: string;
			$priority: string;
			$thread_id: string | null;
			$read: number;
			$created_at: string;
		}
	>(`
		INSERT INTO messages
			(id, from_agent, to_agent, subject, body, type, priority, thread_id, read, created_at)
		VALUES
			($id, $from_agent, $to_agent, $subject, $body, $type, $priority, $thread_id, $read, $created_at)
	`);

	const getByIdStmt = db.prepare<MessageRow, { $id: string }>(`
		SELECT * FROM messages WHERE id = $id
	`);

	const getUnreadStmt = db.prepare<MessageRow, { $to_agent: string }>(`
		SELECT * FROM messages WHERE to_agent = $to_agent AND read = 0 ORDER BY created_at ASC
	`);

	const getByThreadStmt = db.prepare<MessageRow, { $thread_id: string }>(`
		SELECT * FROM messages WHERE thread_id = $thread_id ORDER BY created_at ASC
	`);

	const markReadStmt = db.prepare<void, { $id: string }>(`
		UPDATE messages SET read = 1 WHERE id = $id
	`);

	// Dynamic filter queries are built at call time since the WHERE clause varies
	function buildFilterQuery(filters?: {
		from?: string;
		to?: string;
		unread?: boolean;
	}): MailMessage[] {
		const conditions: string[] = [];
		const params: Record<string, string | number> = {};

		if (filters?.from !== undefined) {
			conditions.push("from_agent = $from_agent");
			params.$from_agent = filters.from;
		}
		if (filters?.to !== undefined) {
			conditions.push("to_agent = $to_agent");
			params.$to_agent = filters.to;
		}
		if (filters?.unread !== undefined) {
			conditions.push("read = $read");
			params.$read = filters.unread ? 0 : 1;
		}

		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT * FROM messages ${whereClause} ORDER BY created_at DESC`;
		const stmt = db.prepare<MessageRow, Record<string, string | number>>(query);
		const rows = stmt.all(params);
		return rows.map(rowToMessage);
	}

	return {
		insert(message: Omit<MailMessage, "read" | "createdAt">): MailMessage {
			const id = message.id || `msg-${randomId()}`;
			const createdAt = new Date().toISOString();

			try {
				insertStmt.run({
					$id: id,
					$from_agent: message.from,
					$to_agent: message.to,
					$subject: message.subject,
					$body: message.body,
					$type: message.type,
					$priority: message.priority,
					$thread_id: message.threadId,
					$read: 0,
					$created_at: createdAt,
				});
			} catch (err) {
				throw new MailError(`Failed to insert message: ${id}`, {
					messageId: id,
					cause: err instanceof Error ? err : undefined,
				});
			}

			return {
				...message,
				id,
				read: false,
				createdAt,
			};
		},

		getUnread(agentName: string): MailMessage[] {
			const rows = getUnreadStmt.all({ $to_agent: agentName });
			return rows.map(rowToMessage);
		},

		getAll(filters?: { from?: string; to?: string; unread?: boolean }): MailMessage[] {
			return buildFilterQuery(filters);
		},

		getById(id: string): MailMessage | null {
			const row = getByIdStmt.get({ $id: id });
			return row ? rowToMessage(row) : null;
		},

		getByThread(threadId: string): MailMessage[] {
			const rows = getByThreadStmt.all({ $thread_id: threadId });
			return rows.map(rowToMessage);
		},

		markRead(id: string): void {
			markReadStmt.run({ $id: id });
		},

		close(): void {
			db.close();
		},
	};
}
