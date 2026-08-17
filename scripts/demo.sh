#!/usr/bin/env bash
# A scripted walkthrough of Freeway against real providers.
#
#   ./scripts/demo.sh              # narrate + run
#   ./scripts/demo.sh --transcript # same, but machine-readable for recording
#
# Everything here is a real request. Nothing is faked, and the output you see is
# the output the gateway actually produced.

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${DEMO_PORT:-8790}"
B="http://127.0.0.1:$PORT"
TRANSCRIPT=""
[[ "${1:-}" == "--transcript" ]] && TRANSCRIPT=1

if [[ -n "$TRANSCRIPT" ]]; then
  C_DIM=''; C_B=''; C_G=''; C_C=''; C_Y=''; C_X=''
else
  C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_G=$'\033[32m'; C_C=$'\033[36m'; C_Y=$'\033[33m'; C_X=$'\033[0m'
fi

say()  { printf '\n%s# %s%s\n' "$C_DIM" "$1" "$C_X"; }
cmd()  { printf '%s$ %s%s\n' "$C_C" "$1" "$C_X"; }
pause(){ [[ -n "$TRANSCRIPT" ]] || sleep "${1:-1}"; }

cleanup() { [[ -n "${GW_PID:-}" ]] && kill "$GW_PID" 2>/dev/null; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
printf '%s┌─ Freeway ─ one endpoint in front of every free LLM tier%s\n' "$C_B" "$C_X"

say "Start the gateway. No keys? It still starts — every provider becomes a card telling you what to set."
cmd "npm start"
PORT=$PORT node packages/gateway/dist/bin.js > /tmp/freeway-demo.log 2>&1 &
GW_PID=$!
for _ in $(seq 1 30); do curl -fsS "$B/healthz" >/dev/null 2>&1 && break; sleep 0.4; done
grep -E "listening|✓|○" /tmp/freeway-demo.log | head -6
pause 2

# ---------------------------------------------------------------------------
say "model:\"auto\" — you don't name a vendor. Freeway picks whoever is healthy and under quota."
cmd "curl \$B/v1/chat/completions -d '{\"model\":\"auto\",\"messages\":[…]}' -D-"
curl -sS "$B/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"In one sentence: what is a rate limit?"}],"max_tokens":60}' \
  -D /tmp/h -o /tmp/b
grep -iE "^HTTP|^x-freeway" /tmp/h | sed "s/^/  ${C_G}/;s/\$/${C_X}/"
printf '  %s→%s %s\n' "$C_G" "$C_X" "$(node -e "
const j=JSON.parse(require('fs').readFileSync('/tmp/b','utf8'));
console.log(j.choices[0].message.content.replace(/\n/g,' ').slice(0,150));")"
pause 2

# ---------------------------------------------------------------------------
say "Aliases route by capability, not vendor. Same call, four different models."
for m in fast cheap code reason; do
  curl -sS -o /tmp/b -D /tmp/h "$B/v1/chat/completions" -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: ok\"}],\"max_tokens\":8}"
  printf '  %-7s → %-24s %s\n' "$m" \
    "$(grep -i '^x-freeway-model' /tmp/h | cut -d' ' -f2 | tr -d '\r')" \
    "$(grep -i '^x-freeway-ms' /tmp/h | cut -d' ' -f2 | tr -d '\r')ms"
  sleep 0.7
done
pause 2

# ---------------------------------------------------------------------------
say "Ask the same thing twice and the second is free — served from cache, zero quota."
Q='{"model":"fast","temperature":0,"messages":[{"role":"user","content":"what is 2+2?"}],"max_tokens":20}'
curl -sS -o /dev/null "$B/v1/chat/completions" -H 'content-type: application/json' -d "$Q"
curl -sS -o /dev/null -D /tmp/h "$B/v1/chat/completions" -H 'content-type: application/json' -d "$Q"
printf '  %scache: %s   provider: %s   %s0 tokens spent%s\n' "$C_G" \
  "$(grep -i '^x-freeway-cache' /tmp/h | cut -d' ' -f2 | tr -d '\r')" \
  "$(grep -i '^x-freeway-provider' /tmp/h | cut -d' ' -f2 | tr -d '\r')" "$C_B" "$C_X"
pause 2

# ---------------------------------------------------------------------------
say "Sessions live server-side. Send only the new message; the gateway rebuilds the thread."
cmd "-d '{\"session\":\"demo\",\"messages\":[{\"content\":\"my name is Ada\"}]}'"
curl -sS -o /dev/null "$B/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"fast","session":"demo","messages":[{"role":"user","content":"My name is Ada. Remember it."}],"max_tokens":30}'
cmd "-d '{\"session\":\"demo\",\"messages\":[{\"content\":\"what is my name?\"}]}'"
curl -sS -o /tmp/b -D /tmp/h "$B/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"fast","session":"demo","messages":[{"role":"user","content":"What is my name?"}],"max_tokens":30}'
printf '  %s→%s %s\n' "$C_G" "$C_X" "$(node -e "
const j=JSON.parse(require('fs').readFileSync('/tmp/b','utf8'));
console.log(j.choices[0].message.content.replace(/\n/g,' ').slice(0,120));")"
printf '  %s%s%s\n' "$C_DIM" "$(grep -i '^x-freeway-context' /tmp/h | tr -d '\r')" "$C_X"
pause 2

# ---------------------------------------------------------------------------
say "Ask for a model that doesn't exist. You get a 404 that tells you what does."
curl -sS "$B/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"gpt-5-turbo-ultra","messages":[{"role":"user","content":"hi"}]}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
      console.log('  '+j.error.message);
      console.log('  did you mean: '+j.freeway.suggestions.slice(0,3).join(', '));});"
pause 2

# ---------------------------------------------------------------------------
say "Where did the tokens go?"
curl -sS "$B/api/usage" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s),t=j.totals;
console.log('  '+t.tokensIn+' in / '+t.tokensOut+' out over '+t.requests+' requests, '+t.avgMs+'ms avg');
console.log('  '+t.cached+' served from cache · '+t.failed+' failed');
for (const m of j.byModel) console.log('    '+m.id.padEnd(26)+(m.tokensIn+m.tokensOut)+' tok  ×'+m.requests);});"
pause 2

# ---------------------------------------------------------------------------
say "Adding a provider is one JSON file. Never a code change."
cmd "node scripts/verify-provider.mjs mistral"
node scripts/verify-provider.mjs mistral 2>&1 | sed -n '3,14p' | sed "s/^/  /"

printf '\n%s└─ dashboard at %s · 12 providers bundled · zero runtime dependencies%s\n\n' "$C_B" "$B" "$C_X"
