-- Tower store schema (mirrors the DDL embedded in sqlite.ts).
CREATE TABLE IF NOT EXISTS claims (
  id         TEXT PRIMARY KEY,
  agentId    TEXT NOT NULL,
  repo       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  files      TEXT NOT NULL,   -- JSON string[]
  symbols    TEXT NOT NULL,   -- JSON SymbolRef[]
  purpose    TEXT NOT NULL,
  status     TEXT NOT NULL,   -- active | completed | expired | released
  etaMinutes INTEGER,
  createdAt  INTEGER NOT NULL,
  expiresAt  INTEGER NOT NULL,
  commitSha  TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_scope ON claims (repo, branch, status);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  author       TEXT NOT NULL,
  tags         TEXT NOT NULL,  -- JSON string[]
  relatedFiles TEXT NOT NULL,  -- JSON string[]
  createdAt    INTEGER NOT NULL
);
