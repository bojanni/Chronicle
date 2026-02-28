
export const PACKAGE_JSON = JSON.stringify({
  "name": "chronicle-mcp-server",
  "version": "1.1.0",
  "description": "MCP Server for your Chronicle AI Archive",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.6.0",
    "pg": "^8.18.0"
  }
}, null, 2);

export const SERVER_JS = `#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive'
});

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

const server = new Server(
  { name: 'chronicle-mcp-server', version: '1.1.0' },
  { capabilities: { resources: {}, tools: {} } }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const res = await pool.query('SELECT id, title, summary FROM chats ORDER BY createdAt DESC');
  const resources = res.rows.map(chat => ({
    uri: \`chronicle://chats/\${chat.id}\`,
    name: chat.title || 'Untitled',
    description: chat.summary || '',
    mimeType: 'text/markdown',
  }));
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);
  const id = url.pathname.replace(/^\\//, '');
  const res = await pool.query('SELECT * FROM chats WHERE id = $1', [id]);
  const chat = res.rows[0];
  if (!chat) throw new Error(\`Chat \${id} not found\`);

  const tags = Array.isArray(chat.tags) ? chat.tags : (typeof chat.tags === 'string' ? JSON.parse(chat.tags) : []);
  const md = \`# \${chat.title}
**Date:** \${new Date(Number(chat.createdat)).toLocaleDateString()}
**Source:** \${chat.source}
**Tags:** \${tags.join(', ')}

## Summary
\${chat.summary || ''}

## Transcript
\${chat.content || ''}
\`;
  return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: md }] };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_archive',
        description: 'Search conversations by keywords in title, summary, or tags.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or keyword' },
          },
          required: ['query'],
        },
      },
      {
        name: 'semantic_search',
        description: 'Find conversations conceptually similar to a specific chat ID using vector embeddings.',
        inputSchema: {
          type: 'object',
          properties: {
            targetId: { type: 'string', description: 'ID of the chat to find similar results for' },
            limit: { type: 'number', description: 'Number of results (default 5)' }
          },
          required: ['targetId'],
        },
      },
      {
        name: 'list_recent_chats',
        description: 'Get a list of the most recent archived conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'Number of chats to return' },
          },
        },
      },
      {
        name: 'list_tags',
        description: 'List all unique tags used across the archive.',
        inputSchema: { type: 'object', properties: {} },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'search_archive': {
      const pattern = \`%\${String(args.query)}%\`;
      const { rows } = await pool.query(
        \`
          SELECT id, title, summary
          FROM chats
          WHERE title ILIKE $1
             OR summary ILIKE $1
             OR EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(tags) t
               WHERE t ILIKE $1
             )
          ORDER BY createdAt DESC
          LIMIT 10
        \`,
        [pattern]
      );
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'semantic_search': {
      const targetId = String(args.targetId);
      const targetRes = await pool.query('SELECT id, title, summary, embedding FROM chats WHERE id = $1', [targetId]);
      const target = targetRes.rows[0];
      if (!target || !target.embedding) {
        return { isError: true, content: [{ type: 'text', text: 'Target chat not found or has no vector data.' }] };
      }
      const othersRes = await pool.query('SELECT id, title, summary, embedding FROM chats WHERE id <> $1 AND embedding IS NOT NULL', [targetId]);
      const scored = othersRes.rows
        .filter(r => Array.isArray(r.embedding))
        .map(r => ({ id: r.id, title: r.title, summary: r.summary, score: cosineSimilarity(target.embedding, r.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Number(args.limit) || 5);
      return { content: [{ type: 'text', text: JSON.stringify(scored, null, 2) }] };
    }

    case 'list_recent_chats': {
      const count = Math.max(1, Number(args.count) || 5);
      const { rows } = await pool.query(
        'SELECT id, title, createdAt FROM chats ORDER BY createdAt DESC LIMIT $1',
        [count]
      );
      const recent = rows.map(r => ({ id: r.id, title: r.title, date: new Date(Number(r.createdat)).toISOString() }));
      return { content: [{ type: 'text', text: JSON.stringify(recent, null, 2) }] };
    }

    case 'list_tags': {
      const { rows } = await pool.query(\`
        SELECT DISTINCT tag FROM (
          SELECT jsonb_array_elements_text(tags) AS tag FROM chats
        ) t
        WHERE tag IS NOT NULL
        ORDER BY tag
      \`);
      const tags = rows.map(r => r.tag);
      return { content: [{ type: 'text', text: tags.join(', ') }] };
    }

    default:
      throw new Error(\`Unknown tool: \${name}\`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[Chronicle] MCP Server Started');
`;
