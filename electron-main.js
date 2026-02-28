
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

// Initialize PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive'
});

let mainWindow;

/**
 * Database Initialization for PostgreSQL
 */
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Create core table with assets column
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

    // Create Links Table
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS facts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        confidence FLOAT DEFAULT 1.0,
        salience FLOAT DEFAULT 0.5,
        valid_from TIMESTAMPTZ DEFAULT NOW(),
        valid_to TIMESTAMPTZ,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_facts_chat_id ON facts(chat_id)');
    await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS salience FLOAT DEFAULT 0.4');
    await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS recall_count INTEGER DEFAULT 0');

    // Optimized Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(createdAt DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_chats_source ON chats(source)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type)');

    // Enable pgvector and ensure vector index exists for semantic search
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
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
    console.log('[Chronicle] PostgreSQL Schema verified.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chronicle] DB Init Error:', err);
  } finally {
    client.release();
  }
}

// IPC Handlers
ipcMain.handle('save-database', async (event, items) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(`
        INSERT INTO chats (id, type, title, content, summary, tags, source, createdAt, updatedAt, fileName, embedding, assets, memory_type, salience)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          summary = EXCLUDED.summary,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          updatedAt = EXCLUDED.updatedAt,
          embedding = EXCLUDED.embedding,
          assets = EXCLUDED.assets,
          memory_type = EXCLUDED.memory_type,
          salience = EXCLUDED.salience
      `, [
        item.id,
        item.type || 'chat',
        item.title,
        item.content,
        item.summary,
        JSON.stringify(item.tags),
        item.source,
        item.createdAt,
        item.updatedAt || item.createdAt,
        item.fileName,
        item.embedding,
        JSON.stringify(item.assets || []),
        item.memory_type || null,
        typeof item.salience === 'number' ? item.salience : null
      ]);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chronicle] Save Error:', err);
    return false;
  } finally {
    client.release();
  }
});

ipcMain.handle('load-database', async () => {
  try {
    const res = await pool.query('SELECT * FROM chats ORDER BY createdAt DESC');
    return res.rows.map(r => ({
      ...r,
      createdAt: Number(r.createdat),
      updatedAt: Number(r.updatedat),
      tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags,
      assets: typeof r.assets === 'string' ? JSON.parse(r.assets) : r.assets,
      embedding: r.embedding,
      memory_type: r.memory_type || null,
      salience: r.salience !== undefined && r.salience !== null ? Number(r.salience) : null
    }));
  } catch (err) {
    console.error('[Chronicle] Load Error:', err);
    return [];
  }
});

ipcMain.handle('save-facts', async (event, chatId, facts) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const fact of facts) {
      await client.query(
        'UPDATE facts SET valid_to = NOW() WHERE subject = $1 AND predicate = $2 AND valid_to IS NULL AND id <> $3',
        [fact.subject, fact.predicate, fact.id || '00000000-0000-0000-0000-000000000000']
      );
      await client.query(
        'INSERT INTO facts (chat_id, subject, predicate, object, confidence, salience) VALUES ($1, $2, $3, $4, $5, 0.5) ON CONFLICT DO NOTHING',
        [chatId, fact.subject, fact.predicate, fact.object, typeof fact.confidence === 'number' ? fact.confidence : 1.0]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chronicle] Save facts error:', err);
    return false;
  } finally {
    client.release();
  }
});

ipcMain.handle('boost-salience', async (event, chatId) => {
  try {
    await pool.query(
      'UPDATE chats SET salience = LEAST(salience + 0.05, 1.0), recall_count = recall_count + 1 WHERE id = $1',
      [chatId]
    );
    await pool.query(
      'UPDATE facts SET salience = LEAST(salience + 0.03, 1.0) WHERE chat_id = $1',
      [chatId]
    );
    return true;
  } catch (err) {
    console.error('[Chronicle] Salience boost error:', err);
    return false;
  }
});

ipcMain.handle('load-facts', async (event, chatId) => {
  try {
    const res = await pool.query(
      'SELECT * FROM facts WHERE chat_id = $1 AND valid_to IS NULL ORDER BY salience DESC, created_at DESC',
      [chatId]
    );
    return res.rows;
  } catch (err) {
    console.error('[Chronicle] Load facts error:', err);
    return [];
  }
});

// Original boilerplate (rest of file) remains unchanged for window creation and other handlers...
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fefef9',
    webPreferences: { 
      preload: path.join(__dirname, 'electron-preload.js'), 
      contextIsolation: true 
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  await initDatabase();
  createWindow();
});
