#!/usr/bin/env bash
#
# SessionStart hook: Verify HelpScout credentials
# Checks that HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET env vars are set
# so Claude can warn early if the MCP server won't be able to authenticate.
#

# Consume hook input from stdin
cat > /dev/null

missing=()

# The server also accepts HELPSCOUT_CLIENT_ID / HELPSCOUT_CLIENT_SECRET as
# aliases, so only warn when neither spelling is present.
if [[ -z "${HELPSCOUT_APP_ID:-}" && -z "${HELPSCOUT_CLIENT_ID:-}" ]]; then
  missing+=("HELPSCOUT_APP_ID")
fi

if [[ -z "${HELPSCOUT_APP_SECRET:-}" && -z "${HELPSCOUT_CLIENT_SECRET:-}" ]]; then
  missing+=("HELPSCOUT_APP_SECRET")
fi

if [[ ${#missing[@]} -eq 0 ]]; then
  echo "HelpScout credentials: configured"
else
  joined=$(printf '%s, ' "${missing[@]}")
  echo "HelpScout credentials: ${joined%, } not set. See plugin docs for setup."
fi
exit 0
