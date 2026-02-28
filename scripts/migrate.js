
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
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='last_accessed_at') THEN
          ALTER TABLE chats ADD COLUMN last_accessed_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='decay_metadata') THEN
          ALTER TABLE chats ADD COLUMN decay_metadata JSONB DEFAULT '{}';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='recall_count') THEN
          ALTER TABLE chats ADD COLUMN recall_count INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);
    
    // Facts table columns for decay tracking
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='last_accessed_at') THEN
          ALTER TABLE facts ADD COLUMN last_accessed_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='decay_metadata') THEN
          ALTER TABLE facts ADD COLUMN decay_metadata JSONB DEFAULT '{}';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='facts' AND column_name='recall_count') THEN
          ALTER TABLE facts ADD COLUMN recall_count INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);
    
    // Create salience decay metrics table
    await client.query(`
      CREATE TABLE IF NOT EXISTS salience_decay_metrics (
        id SERIAL PRIMARY KEY,
        run_timestamp TIMESTAMPTZ DEFAULT NOW(),
        items_processed INTEGER DEFAULT 0,
        items_decayed INTEGER DEFAULT 0,
        average_decay_amount FLOAT DEFAULT 0,
        memory_entropy FLOAT DEFAULT 0,
        environmental_context TEXT,
        processing_duration_ms INTEGER,
        error_count INTEGER DEFAULT 0
      )
    `);
    
    // Create indexes for efficient decay queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chats_last_accessed 
      ON chats(last_accessed_at) 
      WHERE salience > 0.1
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_facts_last_accessed 
      ON facts(last_accessed_at) 
      WHERE salience > 0.1
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_decay_metrics_timestamp 
      ON salience_decay_metrics(run_timestamp DESC)
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
