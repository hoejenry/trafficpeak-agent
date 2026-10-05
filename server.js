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

// ── Dashboard ──────────────────────────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  const tpAccount = getTpAccount(req);
  const { database, table } = req.query;
  if (!database || !table) return res.status(400).json({ error: 'database and table required.' });

  const fqt  = `${database}.${table}`;
  const run  = sql => toolMap['tp_run_select_query'].handler({ query: sql, _tp_account: tpAccount });
  const safe = async fn => { try { return await fn(); } catch (e) { return { error: e.message }; } };

  // Discover schema so we can pick the right column names
  let columns = [];
  try {
    const info = await toolMap['tp_get_table_info'].handler({ database, table, _tp_account: tpAccount });
    const extract = c => {
      if (!c) return null;
      if (typeof c === 'string') return c.split(/[|\s]/)[0].trim();
      if (typeof c === 'object') return c.name || c.column || c.field || null;
      return String(c);
    };
    if (Array.isArray(info?.columns))      columns = info.columns.map(extract).filter(Boolean);
    else if (Array.isArray(info?.rows))    columns = info.rows.map(r => extract(Array.isArray(r) ? r[0] : r)).filter(Boolean);
    else if (info?.text) { try { const p = JSON.parse(info.text); if (Array.isArray(p)) columns = p.map(extract).filter(Boolean); } catch {} }
  } catch {}

  const findCol = (...candidates) => {
    if (!columns.length) return candidates[0]; // no schema — try first candidate anyway
    return candidates.find(c => columns.some(col => col.toLowerCase() === c.toLowerCase())) || null;
  };

  const ipCol   = findCol('cliIP', 'clientIP', 'client_ip', 'reqIp', 'remoteIP', 'ip', 'srcIP', 'xForwardedFor');
  const uaCol   = findCol('UA', 'userAgent', 'ua', 'user_agent', 'reqUserAgent', 'reqUA', 'httpUserAgent');
  const denCol  = findCol('denied', 'deny', 'wafDenied', 'blocked');
  const hostCol = findCol('reqHost', 'host', 'hostname', 'vhost', 'reqHostname', 'serverName');
  const host    = hostCol || 'reqHost';
  const hint   = columns.length ? `Available columns: ${columns.join(', ')}` : '';

  const hasDeny = !!denCol;

  const ua = uaCol || 'UA';
  const ip = ipCol || 'cliIP';
  const dn = denCol || 'denied';

  const AI_BOT_FILTER = `(lower(${ua}) LIKE '%gptbot%' OR lower(${ua}) LIKE '%claudebot%' OR lower(${ua}) LIKE '%anthropic-ai%' OR lower(${ua}) LIKE '%google-extended%' OR lower(${ua}) LIKE '%perplexitybot%' OR lower(${ua}) LIKE '%bytespider%' OR lower(${ua}) LIKE '%ccbot%' OR lower(${ua}) LIKE '%facebookbot%' OR lower(${ua}) LIKE '%applebot%' OR lower(${ua}) LIKE '%amazonbot%' OR lower(${ua}) LIKE '%bingbot%' OR lower(${ua}) LIKE '%yandexbot%' OR lower(${ua}) LIKE '%semrushbot%' OR lower(${ua}) LIKE '%ahrefsbot%' OR lower(${ua}) LIKE '%diffbot%' OR lower(${ua}) LIKE '%cohere-ai%' OR lower(${ua}) LIKE '%meta-externalagent%')`;

  const BOT_FILTER = `(lower(${ua}) LIKE '%bot%' OR lower(${ua}) LIKE '%crawl%' OR lower(${ua}) LIKE '%spider%' OR lower(${ua}) LIKE '%slurp%' OR lower(${ua}) LIKE '%scan%')`;

  const [cdnTraffic, securityEvents, topIPs, topUserAgents, topWafRules, cacheStats, summary, aiBotBreakdown] = await Promise.all([
    safe(() => run(
      `SELECT toStartOfFiveMinutes(reqTimeSec) AS t, count() AS requests, round(sum(bytes)/1e9, 4) AS gb,
              countIf(${BOT_FILTER}) AS bot_requests, countIf(${AI_BOT_FILTER}) AS ai_bot_requests
       FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR GROUP BY t ORDER BY t ASC`
    )),
    safe(() => run(
      `SELECT toStartOfFiveMinutes(reqTimeSec) AS t,
              countIf(statusCode >= 400 AND statusCode < 500) AS err4xx,
              countIf(statusCode >= 500) AS err5xx
              ${hasDeny ? `, countIf(${denCol} = 1) AS waf_denied` : ''}
       FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR GROUP BY t ORDER BY t ASC`
    )),
    ipCol
      ? safe(() => run(
          `SELECT ${ipCol} AS ip, count() AS requests, countIf(statusCode >= 400) AS errors
           FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR AND ${ipCol} != ''
           GROUP BY ip ORDER BY requests DESC LIMIT 10`
        ))
      : { error: `IP column not found. ${hint}` },
    uaCol
      ? safe(() => run(
          `SELECT ${uaCol} AS ua, count() AS requests
           FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR AND ${uaCol} != ''
             AND ${BOT_FILTER}
           GROUP BY ua ORDER BY requests DESC LIMIT 10`
        ))
      : { error: `User-agent column not found. ${hint}` },
    safe(async () => {
      // Try siem_push then siem — authoritative WAF event source
      for (const siemT of ['siem_push', 'siem']) {
        try {
          const r = await run(
            `SELECT ruleMessage AS rule, appliedAction AS grp, count() AS blocked, uniq(clientIP) AS unique_ips
             FROM ${database}.${siemT}
             WHERE timestamp >= now() - INTERVAL 6 HOUR AND attack_waf = 1
             GROUP BY rule, grp ORDER BY blocked DESC LIMIT 10`
          );
          if (!r.error && (r.rows?.length || r.row_count > 0)) return r;
        } catch {}
      }
      // Fall back to logs table
      if (hasDeny) {
        return run(
          `SELECT denyRule AS rule, denyGroup AS grp, count() AS blocked, uniq(${ipCol || 'reqPath'}) AS unique_ips
           FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR AND ${denCol} = 1
           GROUP BY rule, grp ORDER BY blocked DESC LIMIT 10`
        );
      }
      return run(
        `SELECT reqPath AS path, countIf(statusCode >= 400) AS errors,
                round(countIf(statusCode >= 400) / count() * 100, 1) AS error_pct
         FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR AND statusCode >= 400
         GROUP BY path ORDER BY errors DESC LIMIT 10`
      );
    }),
    safe(() => run(
      `SELECT countIf(cacheStatus = 1) AS hits, countIf(cacheStatus != 1) AS misses,
              count() AS total, round(countIf(cacheStatus = 1) / count() * 100, 1) AS hit_rate,
              round(sum(bytes) / 1e9, 2) AS total_gb
       FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR`
    )),
    safe(() => run(
      `SELECT count() AS edge_hits,
              countIf(${dn} = 1) AS waf_blocks,
              countIf(${BOT_FILTER}) AS bot_detections,
              countIf(${AI_BOT_FILTER}) AS ai_bots
       FROM ${fqt} WHERE reqTimeSec >= now() - INTERVAL 6 HOUR`
    )),
    safe(() => run(
      `SELECT multiIf(
         lower(${ua}) LIKE '%gptbot%',          'GPTBot (OpenAI)',
         lower(${ua}) LIKE '%claudebot%',        'ClaudeBot (Anthropic)',
         lower(${ua}) LIKE '%anthropic-ai%',     'Anthropic AI',
         lower(${ua}) LIKE '%google-extended%',  'Google-Extended (Gemini)',
         lower(${ua}) LIKE '%perplexitybot%',    'PerplexityBot',
         lower(${ua}) LIKE '%bytespider%',       'Bytespider (ByteDance)',
         lower(${ua}) LIKE '%ccbot%',            'CCBot (Common Crawl)',
         lower(${ua}) LIKE '%facebookbot%',      'FacebookBot (Meta)',
         lower(${ua}) LIKE '%meta-externalagent%', 'Meta-ExternalAgent',
         lower(${ua}) LIKE '%applebot%',         'Applebot (Apple)',
         lower(${ua}) LIKE '%amazonbot%',        'AmazonBot',
         lower(${ua}) LIKE '%bingbot%',          'Bingbot (Microsoft)',
         lower(${ua}) LIKE '%yandexbot%',        'YandexBot',
         lower(${ua}) LIKE '%semrushbot%',       'SemrushBot',
         lower(${ua}) LIKE '%ahrefsbot%',        'AhrefsBot',
         lower(${ua}) LIKE '%diffbot%',          'Diffbot',
         lower(${ua}) LIKE '%cohere-ai%',        'Cohere AI',
         'Other AI/LLM'
       ) AS bot_type,
       ${host} AS hostname,
       count() AS requests,
       uniq(${ip}) AS unique_ips
       FROM ${fqt}
       WHERE reqTimeSec >= now() - INTERVAL 6 HOUR AND ${AI_BOT_FILTER}
       GROUP BY bot_type, hostname ORDER BY requests DESC LIMIT 25`
    )),
  ]);

  res.json({ cdnTraffic, securityEvents, topIPs, topUserAgents, topWafRules, cacheStats, summary, aiBotBreakdown, _schema: { columns, ipCol, uaCol, denCol, hostCol } });
});

app.listen(PORT, () => {
  console.log(`TrafficPeak UI  →  http://localhost:${PORT}`);
});
