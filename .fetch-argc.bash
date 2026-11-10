# shellcheck shell=bash

# Sourced by setup when argc is not on PATH. Fetches a pinned argc release into the user's data directory and prints the
# resulting binary path.

readonly ARGC_VERSION='1.24.0'
readonly ARGC_INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/kazulejo/bin"
readonly ARGC_LOCAL_BIN="${ARGC_INSTALL_DIR}/argc"

ARGC_TMP_DIR=''

function argc-fetch-fail() {
    printf 'error: %s\n' "$*" >&2
    exit 2
}

function argc-fetch-cleanup() {
    if [[ -n "${ARGC_TMP_DIR:-}" ]]; then
        rm -rf -- "$ARGC_TMP_DIR"
    fi
}

function argc-fetch-target() {
    local machine system
    system=$(uname -s)
    [[ "$system" == 'Linux' ]] \
        || argc-fetch-fail "argc auto-install supports Linux only (found ${system})"

    machine=$(uname -m)

    case "$machine" in
        x86_64|amd64) printf 'x86_64-unknown-linux-musl' ;;
        aarch64|arm64) printf 'aarch64-unknown-linux-musl' ;;
        armv7l|armv7) printf 'armv7-unknown-linux-musleabihf' ;;
        armv6l|arm) printf 'arm-unknown-linux-musleabihf' ;;
        i386|i486|i586|i686) printf 'i686-unknown-linux-musl' ;;
        *) argc-fetch-fail "argc auto-install does not support architecture: ${machine}" ;;
    esac
}

# SHA-256 of argc-v${ARGC_VERSION}-<target>.tar.gz from the GitHub release.
# Update these when bumping ARGC_VERSION.
function argc-fetch-checksum() {
    case "$1" in
        x86_64-unknown-linux-musl)
            printf '%s' '92e2c30ef078e0a66855b5bdd389cefa7ac6ef4c1fe0b177f3f0bf639891aa72'
            ;;
        aarch64-unknown-linux-musl)
            printf '%s' '1493e522be42b83e326750bbd6bd1893b33ed4889ef6d1a03f18c57702159519'
            ;;
        armv7-unknown-linux-musleabihf)
            printf '%s' 'c6b115790096efc14935e6c5594cf35376031b5420f6ec657df8da6b8a4e3803'
            ;;
        arm-unknown-linux-musleabihf)
            printf '%s' '02090efae63645d50a4756031fad5b0b800a7ec0b4e0669c74336c0a57ff612c'
            ;;
        i686-unknown-linux-musl)
            printf '%s' '0f1820b0555cab49783a443b7a880542434c1079749d30125006d300c8147af5'
            ;;
        *) argc-fetch-fail "no checksum for argc target: $1" ;;
    esac
}

function argc-fetch-download() {
    local url=$1 dest=$2

    command -v curl >/dev/null 2>&1 || {
        printf 'error: curl is required to download argc\n' >&2
        return 1
    }

    curl -fsSL --retry 3 --connect-timeout 10 -o "$dest" "$url"
}

function argc-fetch-digest() {
    command -v sha256sum >/dev/null 2>&1 || return 1
    sha256sum "$1" | cut -d' ' -f1
}

function argc-fetch-install() {
    local target expected actual archive tmp url
    local base_url="https://github.com/sigoden/argc/releases/download/v${ARGC_VERSION}"

    target=$(argc-fetch-target)
    expected=$(argc-fetch-checksum "$target")

    mkdir -p "$ARGC_INSTALL_DIR" \
        || argc-fetch-fail "cannot create ${ARGC_INSTALL_DIR}"

    tmp=$(mktemp -d "${ARGC_INSTALL_DIR}/.argc.XXXXXX") \
        || argc-fetch-fail "cannot create a temporary directory in ${ARGC_INSTALL_DIR}"

    ARGC_TMP_DIR=$tmp
    trap argc-fetch-cleanup EXIT

    archive="${tmp}/argc.tar.gz"
    url="${base_url}/argc-v${ARGC_VERSION}-${target}.tar.gz"

    printf '==> Installing argc %s to %s\n' "$ARGC_VERSION" "$ARGC_LOCAL_BIN" >&2

    if ! argc-fetch-download "$url" "$archive"; then
        argc-fetch-fail "failed to download ${url}"
    fi

    actual=$(argc-fetch-digest "$archive") \
        || argc-fetch-fail 'sha256sum is required to verify the argc download'

    if [[ "$actual" != "$expected" ]]; then
        argc-fetch-fail "argc checksum mismatch: expected ${expected}, got ${actual}"
    fi

    if ! tar -xzf "$archive" -C "$tmp" argc; then
        argc-fetch-fail 'cannot extract the argc archive'
    fi

    if [[ ! -x "${tmp}/argc" ]]; then
        argc-fetch-fail 'the argc archive did not contain an executable'
    fi

    if ! mv -f -- "${tmp}/argc" "$ARGC_LOCAL_BIN"; then
        argc-fetch-fail "cannot install argc to ${ARGC_LOCAL_BIN}"
    fi

    rm -rf -- "$tmp"
    ARGC_TMP_DIR=''
    trap - EXIT

    if [[ "$("$ARGC_LOCAL_BIN" --argc-version 2>/dev/null || true)" != "argc ${ARGC_VERSION}" ]]; then
        argc-fetch-fail "installed argc at ${ARGC_LOCAL_BIN} failed verification"
    fi
}

function fetch-argc() {
    if [[ "${KAZULEJO_NO_AUTOFETCH:-}" == '1' ]]; then
        argc-fetch-fail "'argc' is required; install it from https://github.com/sigoden/argc or allow auto-install"
    fi

    if [[ -x "$ARGC_LOCAL_BIN" ]] \
        && [[ "$("$ARGC_LOCAL_BIN" --argc-version 2>/dev/null || true)" == "argc ${ARGC_VERSION}" ]]; then
        printf '%s\n' "$ARGC_LOCAL_BIN"
        return 0
    fi

    argc-fetch-install
    printf '%s\n' "$ARGC_LOCAL_BIN"
}
