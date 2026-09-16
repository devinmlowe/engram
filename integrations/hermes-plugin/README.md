# Moved

The Hermes memory-provider plugin now lives in [`interfaces/hermes-plugin/`](../../interfaces/hermes-plugin/)
(HTTP transport by default; the stdio provider that used to live here is selectable via `"transport": "stdio"`).
If you symlinked this directory into `$HERMES_HOME/plugins/engram`, re-point the symlink or run `interfaces/hermes-plugin/deploy.sh`.
