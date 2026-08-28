#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)"
v=$(npx vitest run --reporter=json 2>/dev/null | tail -1 | jq -r '.numPassedTests // 0')
p=0
if [ -d integrations/hermes-plugin/tests ]; then
  p=$(cd integrations/hermes-plugin && pytest -q 2>/dev/null | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
fi
echo $(( ${v:-0} + ${p:-0} ))
