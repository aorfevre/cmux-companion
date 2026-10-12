#!/bin/sh
# Node's pipe stdio is a socket on macOS; script requires a real stdin pipe.
# Pass the executable and every argument unchanged, without shell evaluation.
/bin/cat | exec "$@"
