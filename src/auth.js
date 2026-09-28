import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_PATH     = join(homedir(), '.akamai-agent-trafficpeak.json');
const CLAUDE_JSON     = join(homedir(), '.claude.json');
const CLI_SOURCE_TAG  = '__cli__'; // marks accounts read from ~/.claude.json

// Read all TrafficPeak-related MCP servers from ~/.claude.json
function readClaudeCliAccounts() {
  if (!existsSync(CLAUDE_JSON)) return {};
  try {
    const d = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'));
    const accounts = {};
    for (const proj of Object.values(d.projects || {})) {
      for (const [name, cfg] of Object.entries(proj.mcpServers || {})) {
        const url = cfg.url || '';
        if (!url.includes('trafficpeak')) continue;
        const auth  = (cfg.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
        if (!auth) continue;
        accounts[name] = { url: url.replace(/\/mcp\/?$/, ''), token: auth, source: CLI_SOURCE_TAG };
      }
    }
    return accounts;
  } catch {
    return {};
  }
}

export function getTrafficPeakConfig(account = 'default') {
  // Env vars override everything
  if (process.env.TRAFFICPEAK_URL && process.env.TRAFFICPEAK_TOKEN) {
    return {
      url:   process.env.TRAFFICPEAK_URL.replace(/\/$/, ''),
      token: process.env.TRAFFICPEAK_TOKEN,
    };
  }

  // Check the GUI credential file first
  if (existsSync(CONFIG_PATH)) {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const cfg = config[account] || config['default'];
    if (cfg?.url && cfg?.token) {
      return { url: cfg.url.replace(/\/$/, ''), token: cfg.token };
    }
  }

  // Fall back to ~/.claude.json (CLI-registered MCP servers)
  const cliAccounts = readClaudeCliAccounts();
  const cliCfg = cliAccounts[account] || Object.values(cliAccounts)[0];
  if (cliCfg?.url && cliCfg?.token) {
    return { url: cliCfg.url.replace(/\/$/, ''), token: cliCfg.token };
  }

  throw new Error(
    `No TrafficPeak credentials found for account [${account}]. ` +
    `Add an account via Manage Accounts, run "claude mcp add --transport http mcp-trafficpeak <url> --header \\"Authorization: Bearer <token>\\"", ` +
    `or set TRAFFICPEAK_URL and TRAFFICPEAK_TOKEN environment variables.`
  );
}

export function saveTrafficPeakConfig(section, url, token) {
  const config = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  config[section] = { url: url.replace(/\/$/, ''), token };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function deleteTrafficPeakConfig(section) {
  if (!existsSync(CONFIG_PATH)) return;
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  delete config[section];
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function listTrafficPeakAccounts() {
  const saved = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    : {};

  // Merge CLI accounts in; saved GUI accounts take precedence on name collision
  const cli = readClaudeCliAccounts();
  const merged = { ...cli, ...saved };

  return Object.entries(merged).map(([account, c]) => ({
    account,
    url:      c.url,
    hasToken: !!c.token,
    source:   c.source === CLI_SOURCE_TAG ? 'claude-cli' : 'gui',
  }));
}
