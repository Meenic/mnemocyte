CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS mnemocyte_memories (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  content text NOT NULL,
  type text NOT NULL DEFAULT 'fact',
  importance text NOT NULL DEFAULT 'normal',
  tags text[] NOT NULL DEFAULT '{}',
  source text,
  metadata jsonb NOT NULL DEFAULT '{}',
  confidence real NOT NULL DEFAULT 1.0,
  embedding vector(1536),
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  superseded_by text REFERENCES mnemocyte_memories(id),
  superseded_at timestamptz,
  expires_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mnemocyte_events (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  timestamp timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mnemocyte_memories_entity_idx
  ON mnemocyte_memories (entity_id);

CREATE INDEX IF NOT EXISTS mnemocyte_memories_entity_type_idx
  ON mnemocyte_memories (entity_id, type);

CREATE INDEX IF NOT EXISTS mnemocyte_events_entity_time_idx
  ON mnemocyte_events (entity_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS mnemocyte_memories_fts_idx
  ON mnemocyte_memories USING gin (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS mnemocyte_memories_embedding_hnsw_idx
  ON mnemocyte_memories USING hnsw (embedding vector_cosine_ops);
