#!/usr/bin/env bash
# security-check.sh — static security audit for a git repository
# Usage: ./scripts/security-check.sh [path/to/repo]
#   Defaults to the current directory if no path is given.

set -euo pipefail

TARGET="${1:-.}"
PASS=0
WARN=0
FAIL=0

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YEL='\033[0;33m'; GRN='\033[0;32m'
CYN='\033[0;36m'; BLD='\033[1m'; RST='\033[0m'

pass() { echo -e "  ${GRN}✔${RST}  $*"; PASS=$((PASS+1)); }
warn() { echo -e "  ${YEL}⚠${RST}  $*"; WARN=$((WARN+1)); }
fail() { echo -e "  ${RED}✖${RST}  $*"; FAIL=$((FAIL+1)); }
hdr()  { echo -e "\n${CYN}${BLD}── $* ──${RST}"; }

# ── Validate target ───────────────────────────────────────────────────────────
if [ ! -d "$TARGET/.git" ]; then
  echo -e "${RED}Error:${RST} '$TARGET' is not a git repository." >&2
  exit 1
fi

cd "$TARGET"
REPO=$(basename "$(pwd)")
echo -e "\n${BLD}Security check: ${CYN}${REPO}${RST}  ($(pwd))\n"

# ── 1. Hidden files tracked by git ───────────────────────────────────────────
hdr "Hidden files tracked by git"
HIDDEN=$(git ls-files | grep -E '(^|/)\.[^/]+$' || true)
if [ -z "$HIDDEN" ]; then
  pass "No hidden files tracked"
else
  while IFS= read -r f; do
    case "$f" in
      .gitignore|.gitattributes|.editorconfig|.eslintrc*|.prettierrc*|.npmrc|.nvmrc|.node-version|.env.example)
        pass "OK (expected):  $f" ;;
      .env|.env.*)
        fail "Committed .env file: $f" ;;
      *)
        warn "Hidden file tracked: $f" ;;
    esac
  done <<< "$HIDDEN"
fi

# ── 2. Embedded binaries ──────────────────────────────────────────────────────
hdr "Embedded binaries"
BINS=$(find . -type f \( -name '*.so' -o -name '*.dll' -o -name '*.dylib' \
       -o -name '*.exe' -o -name '*.pyc' \) \
       -not -path './.git/*' -not -path './node_modules/*' || true)
if [ -z "$BINS" ]; then
  pass "No embedded binaries found"
else
  while IFS= read -r f; do fail "Binary: $f"; done <<< "$BINS"
fi

# ── 3. Dangerous execution primitives ────────────────────────────────────────
hdr "Dangerous execution primitives"
DANGER=$(grep -rnE 'eval\(|exec\(|os\.system|shell=True|child_process\.exec[^F]|new Function\(' \
         --exclude-dir=.git --exclude-dir=node_modules --exclude='*.sh' . 2>/dev/null || true)
if [ -z "$DANGER" ]; then
  pass "No dangerous execution primitives found"
else
  while IFS= read -r line; do warn "$line"; done <<< "$DANGER"
fi

# ── 4. Unexpected external network calls ─────────────────────────────────────
hdr "External network egress"
# Allow fetch/axios calls to localhost/relative paths — flag external URLs
EXT=$(grep -rnE "fetch\(['\"]https?://" \
      --exclude-dir=.git --exclude-dir=node_modules . 2>/dev/null \
      | grep -vE 'localhost|127\.0\.0\.1|cdn\.jsdelivr\.net|unpkg\.com' || true)
if [ -z "$EXT" ]; then
  pass "No unexpected external fetch calls"
else
  while IFS= read -r line; do warn "External fetch: $line"; done <<< "$EXT"
fi

WGET=$(grep -rnE '\bwget\b|\bcurl\b' \
       --exclude-dir=.git --exclude-dir=node_modules \
       --include='*.js' --include='*.ts' --include='*.py' --include='*.sh' \
       --exclude='security-check.sh' . 2>/dev/null || true)
if [ -z "$WGET" ]; then
  pass "No curl/wget in source files"
else
  while IFS= read -r line; do warn "curl/wget in code: $line"; done <<< "$WGET"
fi

# ── 5. Sensitive path access ─────────────────────────────────────────────────
hdr "Sensitive path access"
PATHS=$(grep -rnE '\.ssh/|\.aws/|\.netrc|\.pgpass' \
        --exclude-dir=.git --exclude-dir=node_modules --exclude='*.sh' . 2>/dev/null || true)
if [ -z "$PATHS" ]; then
  pass "No sensitive path access"
else
  while IFS= read -r line; do fail "Sensitive path: $line"; done <<< "$PATHS"
fi

# ── 6. Environment variable harvesting ───────────────────────────────────────
hdr "Environment variable usage"
ENVS=$(grep -rnE 'process\.env\.|os\.environ' \
       --exclude-dir=.git --exclude-dir=node_modules . 2>/dev/null || true)
ENV_COUNT=$(echo "$ENVS" | grep -c . || true)
if [ -z "$ENVS" ]; then
  pass "No environment variable access"
elif [ "$ENV_COUNT" -le 10 ]; then
  pass "Env var access present ($ENV_COUNT occurrences — review manually):"
  while IFS= read -r line; do echo "       $line"; done <<< "$ENVS"
else
  warn "Many env var accesses ($ENV_COUNT) — review for unexpected harvesting"
fi

# ── 7. Hardcoded secrets ─────────────────────────────────────────────────────
hdr "Hardcoded secrets (patterns)"
SECRETS=$(grep -rnE \
  'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{48}|xox[bp]-[0-9A-Za-z\-]{10,}|glsa_[A-Za-z0-9]{32}|-----BEGIN .*PRIVATE KEY|eyJ[A-Za-z0-9_\-]{40,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}' \
  --exclude-dir=.git --exclude-dir=node_modules --exclude='security-check.sh' . 2>/dev/null || true)
if [ -z "$SECRETS" ]; then
  pass "No hardcoded secret patterns found"
else
  while IFS= read -r line; do fail "Possible secret: $line"; done <<< "$SECRETS"
fi

# ── 8. Secrets in git history ────────────────────────────────────────────────
hdr "Secrets in git history"
HIST=$(git log -p --all 2>/dev/null \
  | grep -E 'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{48}|-----BEGIN .*PRIVATE KEY|glsa_[A-Za-z0-9]{32}' \
  | head -20 || true)
if [ -z "$HIST" ]; then
  pass "No secret patterns found in git history"
else
  fail "Secret pattern found in git history — rotate immediately:"
  while IFS= read -r line; do echo "       $line"; done <<< "$HIST"
fi

# ── 9. .gitignore hygiene ────────────────────────────────────────────────────
hdr ".gitignore hygiene"
if [ ! -f ".gitignore" ]; then
  warn "No .gitignore file found"
else
  for pat in '.env' 'node_modules' '*.log' '.DS_Store'; do
    if grep -q "$pat" .gitignore 2>/dev/null; then
      pass ".gitignore covers: $pat"
    else
      warn ".gitignore missing: $pat"
    fi
  done
fi

# ── 10. Credential files on disk ─────────────────────────────────────────────
hdr "Credential files committed to repo"
CREDS=$(git ls-files | grep -iE '\.(pem|key|p12|pfx|jks|keystore|crt|cer)$' || true)
CREDS2=$(git ls-files | grep -iE '(credentials|secrets|private[-_]key)' || true)
if [ -z "$CREDS" ] && [ -z "$CREDS2" ]; then
  pass "No credential files tracked"
else
  for f in $CREDS $CREDS2; do fail "Credential file: $f"; done
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "\n${BLD}────────────────────────────────────────${RST}"
echo -e "  ${GRN}✔ Pass${RST}  $PASS"
echo -e "  ${YEL}⚠ Warn${RST}  $WARN"
echo -e "  ${RED}✖ Fail${RST}  $FAIL"
echo -e "${BLD}────────────────────────────────────────${RST}\n"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}${BLD}FAILED${RST} — $FAIL issue(s) require immediate attention.\n"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo -e "${YEL}${BLD}WARNINGS${RST} — $WARN item(s) need manual review.\n"
  exit 0
else
  echo -e "${GRN}${BLD}PASSED${RST} — no issues found.\n"
  exit 0
fi
