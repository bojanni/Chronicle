
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive'
});

async function migrate() {
  console.log('Starting migration to PostgreSQL...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Updating "chats" table with assets column...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'chat',
        title TEXT,
        content TEXT,
        summary TEXT,
        tags JSONB,
        source TEXT,
        createdAt BIGINT,
        updatedAt BIGINT,
        fileName TEXT,
        embedding double precision[],
        assets JSONB DEFAULT '[]',
        memory_type TEXT,
        salience double precision
      )
    `);

    // Check if column exists, add if missing (for existing databases)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='assets') THEN
          ALTER TABLE chats ADD COLUMN assets JSONB DEFAULT '[]';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='memory_type') THEN
          ALTER TABLE chats ADD COLUMN memory_type TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='salience') THEN
          ALTER TABLE chats ADD COLUMN salience double precision;
        END IF;
      END $$;
    `);

    console.log('Checking "links" table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        link_type TEXT,
        created_at BIGINT,
        UNIQUE(from_id, to_id)
      )
    `);

    // Enable pgvector and create vector index for semantic search
    console.log('Enabling pgvector extension and creating vector index if needed...');
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    // Expression index using cosine distance on embedding cast to vector
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'idx_chats_embedding_ivfflat'
        ) THEN
          EXECUTE 'CREATE INDEX idx_chats_embedding_ivfflat ON chats USING ivfflat ((embedding::vector) vector_cosine_ops)';
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
