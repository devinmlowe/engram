#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)"
npx vitest run >/dev/null 2>&1 || exit 1
npm run lint >/dev/null 2>&1 || exit 1
if [ -d integrations/hermes-plugin/tests ]; then
  (cd integrations/hermes-plugin && pytest -q >/dev/null) || exit 1
fi
exit 0
