# Source with ARM=A or ARM=B set. Builds a throwaway OpenCode 1 environment
# under $BASE_TMP/oc1-mc582/arm$ARM so neither OpenCode, openai-auth nor Magic
# Context can read or write the operator's real config, data or state.
: "${ARM:?set ARM=A or ARM=B}"
BASE_TMP="${BASE_TMP:-${TMPDIR:-/tmp}}"
export ROOT="${BASE_TMP%/}/oc1-mc582/arm$ARM"
export HOME="$ROOT/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
# At startup openai-auth checks whether a local Claustrum credential service is
# running by reading its connection file, <XDG_RUNTIME_DIR>/subc-connection.json.
# Left pointing at the real directory, it reads the operator's live file
# (read-only, but still outside the throwaway root).
export XDG_RUNTIME_DIR="$ROOT/run"
unset CLAUSTRUM_SUBC_CONNECTION
# openai-auth (log, request dumps, sidebar state) and Magic Context (log,
# historian dumps) default those files to the OS temp dir, which follows TMPDIR,
# so point it inside the throwaway root too.
export TMPDIR="$ROOT/tmp"
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
export OPENCODE_TUI_PREFERENCES_FILE="$OPENCODE_CONFIG_DIR/tui-preferences.jsonc"
# openai-auth
export OPENCODE_OPENAI_AUTH_FILE="$OPENCODE_CONFIG_DIR/openai-auth.json"
export OPENCODE_OPENAI_AUTH_STATE_FILE="$OPENCODE_CONFIG_DIR/openai-auth-state.json"
export OPENCODE_OPENAI_AUTH_LOG_FILE="$ROOT/logs/openai-auth.log"
export OPENCODE_OPENAI_AUTH_LOG_LEVEL=debug
export OPENCODE_OPENAI_AUTH_DUMP_DIR="$ROOT/dumps"
export OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE="$ROOT/state/sidebar-state.json"
export OPENCODE_OPENAI_AUTH_RPC_DIR="$ROOT/state/rpc"
export OPENCODE_OPENAI_AUTH_MODELS_CACHE="$XDG_CACHE_HOME/opencode/models.json"
export CLAUSTRUM_OPENCODE_HANDLES="$ROOT/state/claustrum-handles.json"
export CORTEXKIT_OPENAI_AUTH_WEBSOCKETS=1
export CORTEXKIT_OPENAI_AUTH_DUMP=1
unset CORTEXKIT_OPENAI_AUTH_RAW_WS CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT
# Magic Context (only loaded in arm B, but isolate regardless)
export MAGIC_CONTEXT_STORAGE_DIR="$XDG_DATA_HOME/cortexkit/magic-context"
export MAGIC_CONTEXT_LOG_PATH="$ROOT/logs/magic-context.log"
unset OPENCODE_DB OPENCODE_CHANNEL OPENCODE_MODELS_PATH OPENCODE_SERVER_PASSWORD
export PROJECT="$ROOT/project"
