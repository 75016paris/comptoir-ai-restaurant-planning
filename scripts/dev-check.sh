#!/usr/bin/env bash
# Check health of all local dev services.
# Usage: bun dev:check  or  ./scripts/dev-check.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

check() {
  local name=$1 url=$2 port=$3
  if curl -sf --max-time 2 "$url" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} ${name} — ${url}"
  else
    echo -e "  ${RED}✗${NC} ${name} — not responding on :${port}"
    echo -e "    ${YELLOW}→ Start with:${NC} $4"
    MISSING+=("$name")
  fi
}

echo ""
echo "Comptoir dev services:"
echo ""

MISSING=()
check "API"      "http://localhost:3000/api/health" 3000 "bun dev:api"
check "Web"      "http://localhost:5173"            5173 "bun dev:web"
check "WhatsApp" "http://localhost:3002/health"     3002 "bun dev:wa"

# Ollama (optional — only needed for LLM-path testing)
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
if curl -sf --max-time 3 "$OLLAMA_URL/api/tags" > /dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Ollama — ${OLLAMA_URL}"
else
  echo -e "  ${YELLOW}~${NC} Ollama — not reachable at ${OLLAMA_URL} (needed for LLM tests only)"
fi

echo ""
if [ ${#MISSING[@]} -eq 0 ]; then
  echo -e "${GREEN}All services running.${NC}"
else
  echo -e "${RED}${#MISSING[@]} service(s) down: ${MISSING[*]}${NC}"
  echo ""
  echo "Start everything: bun dev"
fi
echo ""
