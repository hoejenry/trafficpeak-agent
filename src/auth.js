import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_PATH     = join(homedir(), '.akamai-agent-trafficpeak.json');
const CLAUDE_JSON     = join(homedir(), '.claude.json');
const CLI_SOURCE_TAG  = '__cli__'; // marks accounts read from ~/.claude.json

// Read all TrafficPeak-related MCP servers from ~/.claude.json (Claude Code CLI format)
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

// Read TrafficPeak MCP servers from Claude Desktop config (mcp-remote args format)
function readClaudeDesktopAccounts() {
  const desktopPath = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (!existsSync(desktopPath)) return {};
  try {
    const d = JSON.parse(readFileSync(desktopPath, 'utf8'));
    const accounts = {};
    for (const [name, cfg] of Object.entries(d.mcpServers || {})) {
      const args = cfg.args || [];
      // Handle: npx -y mcp-remote <url> --transport http-only --header "Authorization: Bearer <token>"
      const mcpIdx = args.findIndex(a => a === 'mcp-remote');
      if (mcpIdx === -1) continue;
      const url = args[mcpIdx + 1] || '';
      if (!url.includes('trafficpeak')) continue;
      const hdrIdx = args.findIndex(a => a === '--header');
      if (hdrIdx === -1) continue;
      const token = (args[hdrIdx + 1] || '').replace(/^Authorization:\s*Bearer\s+/i, '');
      if (!token) continue;
      accounts[name] = { url: url.replace(/\/mcp\/?$/, ''), token, source: CLI_SOURCE_TAG };
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
      return { url: normalizeUrl(cfg.url), token: cfg.token };
    }
  }

  // Fall back to ~/.claude.json (CLI) then Claude Desktop config
  const cliAccounts = { ...readClaudeDesktopAccounts(), ...readClaudeCliAccounts() };
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

function normalizeUrl(url) {
  url = url.trim().replace(/\/mcp\/?$/, '').replace(/\/$/, '');
  if (url && !url.startsWith('http')) url = 'https://' + url;
  return url;
}

export function saveTrafficPeakConfig(section, url, token) {
  const config = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  config[section] = { url: normalizeUrl(url), token: token.trim() };
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

  // Merge Desktop + CLI accounts in; saved GUI accounts take precedence on name collision
  const cli = { ...readClaudeDesktopAccounts(), ...readClaudeCliAccounts() };
  const merged = { ...cli, ...saved };

  return Object.entries(merged).map(([account, c]) => ({
    account,
    url:      c.url,
    hasToken: !!c.token,
    source:   c.source === CLI_SOURCE_TAG ? 'claude-cli' : 'gui',
  }));
}
