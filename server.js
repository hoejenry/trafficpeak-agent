import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { trafficpeakTools } from './src/tools/trafficpeak.js';
import {
  saveTrafficPeakConfig,
  getTrafficPeakConfig,
  deleteTrafficPeakConfig,
  listTrafficPeakAccounts,
} from './src/auth.js';

const PORT = process.env.TRAFFICPEAK_PORT || 3001;

const toolMap = Object.fromEntries(trafficpeakTools.map(t => [t.name, t]));

const anthropicTools = trafficpeakTools.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

const anthropic = new Anthropic({
  apiKey:  process.env.ANTHROPIC_FOUNDRY_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_FOUNDRY_BASE_URL,
  defaultHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS
    ? Object.fromEntries(
        process.env.ANTHROPIC_CUSTOM_HEADERS.split(',').map(h => {
          const [k, ...v] = h.split(':');
          return [k.trim(), v.join(':').trim()];
        })
      )
    : {},
});

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a TrafficPeak analytics assistant. TrafficPeak is a ClickHouse-based analytics platform for Akamai edge delivery data.

You have four tools:
- tp_list_databases — discover available databases
- tp_list_tables — list tables in a database
- tp_get_table_info — get column names and types for a table
- tp_run_select_query — execute a read-only SQL SELECT query

When a user asks an analytics question:
1. First discover the schema if you don't know it (list databases → tables → table info)
2. Write an accurate ClickHouse SQL query
3. Run it and explain the results clearly

Always share the howTo guidance from tool results. Use ClickHouse-specific functions where helpful (toDate, now, countIf, groupArray, formatDateTime, etc.). Keep queries efficient — always add date filters for partition pruning.`;

const app = express();
app.use(express.json());
app.use(express.static('public'));

function getTpAccount(req) {
  return (req.headers['x-tp-account'] || 'default').trim();
}

// ── Accounts ──────────────────────────────────────────────────────────────────

app.get('/api/accounts', (req, res) => {
  res.json({ accounts: listTrafficPeakAccounts() });
});

app.post('/api/accounts', (req, res) => {
  const { account, url, token } = req.body;
  if (!account || !url || !token)
    return res.status(400).json({ error: 'account, url, and token are required.' });
  try {
    saveTrafficPeakConfig(account.trim(), url.trim(), token.trim());
    res.json({ ok: true, account: account.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts', (req, res) => {
  const { account } = req.body;
  if (!account) return res.status(400).json({ error: 'account is required.' });
  try {
    deleteTrafficPeakConfig(account);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Explorer ──────────────────────────────────────────────────────────────────

app.get('/api/databases', async (req, res) => {
  const tpAccount = getTpAccount(req);
  try {
    const result = await toolMap['tp_list_databases'].handler({ _tp_account: tpAccount });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tables', async (req, res) => {
  const tpAccount = getTpAccount(req);
  const { database } = req.query;
  if (!database) return res.status(400).json({ error: 'database required.' });
  try {
    const result = await toolMap['tp_list_tables'].handler({ database, _tp_account: tpAccount });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/table-info', async (req, res) => {
  const tpAccount = getTpAccount(req);
  const { database, table } = req.query;
  if (!database || !table) return res.status(400).json({ error: 'database and table required.' });
  try {
    const result = await toolMap['tp_get_table_info'].handler({ database, table, _tp_account: tpAccount });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/query', async (req, res) => {
  const tpAccount = getTpAccount(req);
  const { query, database } = req.body;
  if (!query) return res.status(400).json({ error: 'query required.' });
  try {
    const result = await toolMap['tp_run_select_query'].handler({ query, database, _tp_account: tpAccount });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { messages } = req.body;
  const tpAccount = getTpAccount(req);
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const history = [...(messages || [])];
    while (true) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: `${SYSTEM_PROMPT}\n\nActive TrafficPeak account: [${tpAccount}]`,
        tools: anthropicTools,
        messages: history,
      });

      for (const block of response.content) {
        if (block.type === 'text') send({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') send({ type: 'tool_call', name: block.name, input: block.input });
      }

      if (response.stop_reason !== 'tool_use') {
        send({ type: 'done' });
        break;
      }

      history.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content.filter(b => b.type === 'tool_use').map(async block => {
          const tool = toolMap[block.name];
          let result;
          try {
            result = tool
              ? await tool.handler({ ...(block.input || {}), _tp_account: tpAccount })
              : { error: `Unknown tool: ${block.name}` };
          } catch (err) {
            result = { error: err.message };
          }
          send({ type: 'tool_result', name: block.name, result });
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
        })
      );

      history.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`TrafficPeak UI  →  http://localhost:${PORT}`);
});
