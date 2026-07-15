import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import type { JsonObject } from "../types.js";
import { formatVectorComponent } from "./vector.js";

const vector = customType<{
	data: number[];
	driverData: string;
	config: { dimensions?: number };
}>({
	dataType(config) {
		const dimensions = config?.dimensions ?? 1536;
		return `vector(${dimensions})`;
	},
	toDriver(value) {
		return `[${value.map(formatVectorComponent).join(",")}]`;
	},
	fromDriver(value) {
		return value.slice(1, -1).split(",").filter(Boolean).map(Number);
	},
});

export const memoriesTable = pgTable(
	"mnemocyte_memories",
	{
		id: text("id").primaryKey(),
		entityId: text("entity_id").notNull(),
		content: text("content").notNull(),
		type: text("type").notNull().default("fact"),
		importance: text("importance").notNull().default("normal"),
		tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
		source: text("source"),
		metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
		confidence: real("confidence").notNull().default(1),
		embedding: vector("embedding", { dimensions: 1536 }),
		embeddingModel: text("embedding_model").notNull(),
		embeddingDimensions: integer("embedding_dimensions").notNull(),
		supersededBy: text("superseded_by").references(
			(): AnyPgColumn => memoriesTable.id,
		),
		supersededAt: timestamp("superseded_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
		accessCount: integer("access_count").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("mnemocyte_memories_entity_idx").on(table.entityId),
		index("mnemocyte_memories_entity_type_idx").on(table.entityId, table.type),
		index("mnemocyte_memories_embedding_hnsw_idx").using(
			"hnsw",
			table.embedding.op("vector_cosine_ops"),
		),
	],
);

export const eventsTable = pgTable(
	"mnemocyte_events",
	{
		id: text("id").primaryKey(),
		entityId: text("entity_id").notNull(),
		description: text("description").notNull(),
		metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
		timestamp: timestamp("timestamp", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("mnemocyte_events_entity_time_idx").on(
			table.entityId,
			table.timestamp,
		),
	],
);

export const metaTable = pgTable("mnemocyte_meta", {
	key: text("key").primaryKey(),
	embeddingDimensions: integer("embedding_dimensions").notNull(),
});

export type MemoryRow = typeof memoriesTable.$inferSelect;
export type NewMemoryRow = typeof memoriesTable.$inferInsert;
export type EventRow = typeof eventsTable.$inferSelect;
export type NewEventRow = typeof eventsTable.$inferInsert;
export type MetaRow = typeof metaTable.$inferSelect;
