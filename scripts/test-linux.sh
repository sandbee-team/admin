#!/usr/bin/env bash
# Runs the whole suite on Linux exactly like the server would: as root inside a
# node:22 container with Docker's DEFAULT capabilities, from a COPY of this
# checkout (mounted read-only, so the copy is root-owned 0755 and the real
# .local/ and .env, if present, are in it: tests must never read them), then
# `npm ci`, `npm run build`, `npm test`. Prints the summary and EVERY failing
# test name (no truncation); the exit code is the test run's.
#   usage:  npm run test:linux      (from the repository root)
set -u
docker run --rm -v "$PWD":/src:ro node:22-bookworm bash -c '
set -u
cp -a /src /app && cd /app && rm -rf node_modules \
  && npm ci --no-audit --no-fund >/tmp/ci.log 2>&1 || { tail -20 /tmp/ci.log; exit 1; }
npm run build >/tmp/build.log 2>&1 || { tail -20 /tmp/build.log; exit 1; }
npm test >/tmp/test.log 2>&1
code=$?
echo "---- failing tests ----"
grep -E "^[[:space:]]*not ok" /tmp/test.log || echo "(none)"
echo "---- summary ----"
grep -E "^# (tests|suites|pass|fail|cancelled|skipped|todo)" /tmp/test.log
exit $code
'
