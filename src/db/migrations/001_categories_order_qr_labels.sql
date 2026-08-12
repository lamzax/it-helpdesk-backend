-- ============================================================
-- MIGRĀCIJA 001 — palaist TIKAI, ja datubāze jau iepriekš izveidota
-- (ja veidojat DATUBĀZI NO JAUNA, vienkārši izmantojiet atjaunināto
-- schema.sql -- šī migrācija tur jau ir iekļauta).
--
-- Kā palaist: Neon.tech -> SQL Editor -> ielīmēt visu šo failu -> Run.
-- ============================================================

-- Kategorijām pievieno kārtas numuru (secība, kādā tās rādās ticketa formā)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE categories SET sort_order = id WHERE sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_categories_sort_order ON categories (sort_order);
