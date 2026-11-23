#!/usr/bin/env bash
# Downloads the GGUF files into models/. Resumable: a file is fetched to
# <name>.part and renamed when complete. Arguments: <hf-repo>/<file> ...
set -euo pipefail

mkdir -p models

fetch() {
    local spec="$1"
    local file="${spec##*/}"
    local repo="${spec%/*}"
    if [[ -f "models/$file" ]]; then
        echo "ok      $file"
        return 0
    fi
    echo "fetch   $file"
    curl -fsSL -C - --retry 5 --retry-delay 2 \
        -o "models/$file.part" \
        "https://huggingface.co/$repo/resolve/main/$file"
    mv "models/$file.part" "models/$file"
    echo "done    $file"
}
export -f fetch

printf '%s\n' "$@" | xargs -P 3 -I{} bash -c 'fetch "$1"' _ {}
