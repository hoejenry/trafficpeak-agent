import { getTrafficPeakConfig } from '../auth.js';

// TP tools use _tp_account (independent of Akamai _section)

// Parse a MCP HTTP response — handles both JSON and SSE (text/event-stream) formats
async function parseMcpResponse(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();

  // Detect non-MCP responses (HTML auth pages, Grafana SPA 404s, etc.)
  if (!res.ok && !ct.includes('application/json') && !ct.includes('text/event-stream')) {
    throw new Error(`TrafficPeak returned HTTP ${res.status}. Check that the URL and token are correct.`);
  }

  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const d = JSON.parse(payload);
        if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
        if (d.result !== undefined) return d.result;
      } catch (e) {
        if (e.message && !e.message.startsWith('Unexpected token')) throw e;
      }
    }
    return null;
  }

  if (!text) return null;
  try {
    const d = JSON.parse(text);
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.result;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`TrafficPeak returned HTTP ${res.status} with non-JSON response. Check the URL and token.`);
    }
    throw e;
  }
}

// Call a single tool on the TrafficPeak MCP HTTP endpoint.
// Follows the Streamable HTTP transport: initialize → initialized → tools/call.
async function callTP(toolName, args, tpAccount) {
  const { url, token } = getTrafficPeakConfig(tpAccount);
  // Stored URL may already include /mcp — normalise so we never double-append it
  const endpoint = url.replace(/\/mcp\/?$/, '') + '/mcp';

  const headers = {
    'Content-Type': 'application/json',
    'Accept':        'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
  };

  function fetchwith(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  // 1. Initialize session (15s timeout)
  const initRes = await fetchwith(endpoint, {
    method:  'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: '0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities:    {},
        clientInfo:      { name: 'akamai-agent', version: '1.0.0' },
      },
    }),
  }, 15000);

  const sessionId = initRes.headers.get('mcp-session-id');
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  await parseMcpResponse(initRes);

  // 2. Send initialized notification (fire-and-forget)
  fetchwith(endpoint, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }, 5000).catch(() => {});

  // 3. Call the tool (35s — server limit is 30s)
  const callRes = await fetchwith(endpoint, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: '1',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  }, 35000);

  const result = await parseMcpResponse(callRes);

  // MCP tool results wrap content in {content:[{type:"text",text:"..."}]}
  const content = result?.content || [];
  const textItem = content.find(c => c.type === 'text');
  if (textItem) {
    try { return JSON.parse(textItem.text); } catch { return { text: textItem.text }; }
  }
  return result || {};
}

export const trafficpeakTools = [
  {
    name: 'tp_list_databases',
    description: 'List all databases available in the TrafficPeak analytics environment. Use this first to discover what data is available.',
    inputSchema: { type: 'object', properties: {} },
    handler: async ({ _tp_account } = {}) => {
      const result = await callTP('list_databases', {}, _tp_account);
      return {
        ...result,
        howTo: [
          'Use a database name with tp_list_tables to explore its schema.',
          'The default database typically contains traffic logs ingested from Akamai edge servers.',
          'TrafficPeak is built on ClickHouse — all standard SQL analytical functions apply.',
        ],
      };
    },
  },

  {
    name: 'tp_list_tables',
    description: 'List all tables in a TrafficPeak database.',
    inputSchema: {
      type: 'object',
      required: ['database'],
      properties: {
        database: { type: 'string', description: 'Database name (from tp_list_databases).' },
      },
    },
    handler: async ({ database, _tp_account } = {}) => {
      const result = await callTP('list_tables', { database }, _tp_account);
      return {
        ...result,
        howTo: [
          'Use tp_get_table_info to see column names and types for a specific table.',
          'Log tables typically contain: timestamp, clientIP, statusCode, bytes, url, cacheStatus, edgePOP.',
          'Partition keys are often date-based — filter by date first for performance.',
        ],
      };
    },
  },

  {
    name: 'tp_get_table_info',
    description: 'Get the schema (column names and types) for a specific table in TrafficPeak.',
    inputSchema: {
      type: 'object',
      required: ['database', 'table'],
      properties: {
        database: { type: 'string', description: 'Database name (from tp_list_databases).' },
        table:    { type: 'string', description: 'Table name (from tp_list_tables).' },
      },
    },
    handler: async ({ database, table, _tp_account } = {}) => {
      const result = await callTP('get_table_info', { database, table }, _tp_account);
      return {
        ...result,
        howTo: [
          'Column types follow ClickHouse notation: String, UInt64, DateTime, Float64, Nullable(String), etc.',
          'Use this schema to write accurate SELECT queries with tp_run_select_query.',
          'DateTime columns: WHERE timestamp >= now() - INTERVAL 1 HOUR',
          'LowCardinality(String) columns are ideal for GROUP BY.',
        ],
      };
    },
  },

  {
    name: 'tp_run_select_query',
    description: 'Execute a read-only SQL SELECT query against a TrafficPeak database. Use for traffic analysis, cache efficiency, error investigation, and custom analytics on Akamai delivery data. Limit: 100,000 rows, 2 GiB memory, 30-second timeout.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query:    { type: 'string', description: 'A SQL SELECT statement. Only SELECT is permitted.' },
        database: { type: 'string', description: 'Target database. Use tp_list_databases to discover available databases.' },
      },
    },
    handler: async ({ query, _tp_account } = {}) => {
      const result = await callTP('run_select_query', { query }, _tp_account);
      return {
        ...result,
        howTo: [
          'TrafficPeak uses ClickHouse SQL — use functions like toDate(), now(), formatDateTime().',
          'Example — top cache miss URLs: SELECT url, count() as misses FROM logs WHERE cacheStatus = \'miss\' AND date = today() GROUP BY url ORDER BY misses DESC LIMIT 20',
          'Example — error rate by POP: SELECT edgePOP, countIf(statusCode >= 500) / count() * 100 as errorPct FROM logs WHERE date = today() GROUP BY edgePOP ORDER BY errorPct DESC',
          'Always add a WHERE date = ... clause for partition pruning and faster queries.',
        ],
      };
    },
  },
];
