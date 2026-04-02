-- =====================================================
-- CO3404 Distributed Systems – Database Init Script
-- File: db/init.sql
--
-- This file is mounted into the MySQL container at:
--   /docker-entrypoint-initdb.d/init.sql
-- MySQL executes it automatically on first startup.
--
-- Schema Design Notes:
--   - types.name is UNIQUE → prevents duplicate categories
--   - jokes.type_id is a FK → enforces referential integrity
--   - INSERT IGNORE on types → safe for concurrent inserts (ETL)
-- =====================================================

USE jokesdb;

-- ── Tables ────────────────────────────────────────────────

-- Stores unique joke categories/types
CREATE TABLE IF NOT EXISTS types (
  id   INT          AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

-- Stores individual jokes linked to a type
CREATE TABLE IF NOT EXISTS jokes (
  id        INT  AUTO_INCREMENT PRIMARY KEY,
  setup     TEXT NOT NULL,
  punchline TEXT NOT NULL,
  type_id   INT  NOT NULL,
  FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE RESTRICT,
  -- Prevent exact-duplicate joke submissions reaching the database.
  -- TEXT columns need a prefix length for index/unique constraints in MySQL.
  -- utf8mb4 uses up to 4 bytes/char; MySQL InnoDB's combined index key cap is
  -- 3072 bytes. 255+255 = 510 chars × 4 = 2040 bytes, safely within the limit.
  -- prefetch(1) in moderate + manual ACK already prevents most duplication;
  -- this is a defence-in-depth constraint at the DB layer.
  UNIQUE KEY uq_joke (setup(255), punchline(255))
);

-- ── Seed Data ─────────────────────────────────────────────

-- Insert default joke types (INSERT IGNORE = skip if exists)
INSERT IGNORE INTO types (name) VALUES
  ('general'),
  ('programming'),
  ('knock-knock'),
  ('dad'),
  ('science');

-- Insert sample jokes (type_id resolved via subquery)
-- INSERT IGNORE: safe to re-run — skips rows that already match the
-- UNIQUE KEY uq_joke (setup, punchline) constraint, e.g. if the container
-- was restarted after the volume was partially written (edge case).
INSERT IGNORE INTO jokes (setup, punchline, type_id) VALUES
  (
    'Why don\'t scientists trust atoms?',
    'Because they make up everything!',
    (SELECT id FROM types WHERE name = 'general')
  ),
  (
    'I told my wife she should embrace her mistakes.',
    'She gave me a hug.',
    (SELECT id FROM types WHERE name = 'general')
  ),
  (
    'Why do programmers prefer dark mode?',
    'Because light attracts bugs!',
    (SELECT id FROM types WHERE name = 'programming')
  ),
  (
    'Why did the programmer quit his job?',
    'Because he didn\'t get arrays!',
    (SELECT id FROM types WHERE name = 'programming')
  ),
  (
    'A SQL query walks into a bar, walks up to two tables and asks...',
    'Can I join you?',
    (SELECT id FROM types WHERE name = 'programming')
  ),
  (
    'What do you call a fish without eyes?',
    'A fsh!',
    (SELECT id FROM types WHERE name = 'dad')
  ),
  (
    'Why did the scarecrow win an award?',
    'Because he was outstanding in his field!',
    (SELECT id FROM types WHERE name = 'dad')
  ),
  (
    'Knock knock. Who\'s there? Interrupting cow.',
    'Interrupting cow wh— MOOO!',
    (SELECT id FROM types WHERE name = 'knock-knock')
  ),
  (
    'Knock knock. Who\'s there? Nobel.',
    'Nobel who? Nobel, that\'s why I knocked!',
    (SELECT id FROM types WHERE name = 'knock-knock')
  ),
  (
    'What did the photon say when asked if it needed help with its luggage?',
    'No thanks, I\'m travelling light!',
    (SELECT id FROM types WHERE name = 'science')
  ),
  (
    'Why can\'t you trust an atom?',
    'Because they make up literally everything!',
    (SELECT id FROM types WHERE name = 'science')
  );
