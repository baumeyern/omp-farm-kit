#!/usr/bin/env bash
# Install the omp-portable-kit templates into ~/.omp (macOS/Linux).
#
#   ./install.sh [--owner NAME] [--home DIR] [--force]
#
# - Checks prerequisites and prints how to install anything missing. Installs nothing itself.
# - Copies kit/home/.omp/** into <home>/.omp/**, replacing {{HOME}} and {{OWNER}} in the text
#   templates. Existing files are kept unless --force; with --force every replaced file is first
#   backed up to <home>/.omp/_kit-backup/<timestamp>/.
# - Creates ~/.omp/wt/_logs, ~/.omp/wt/_compact and ~/.omp/secrets.
# - Downloads the impeccable engine binary for this OS/arch from its official GitHub release,
#   pinned to skills/impeccable/scripts/VERSION and checked against the release's .sha256 sidecar.
# - Prints the post-install checklist.
# OMP_KIT_HOME=<dir> is the same as --home <dir> (rehearse against a throwaway home).
set -euo pipefail

OWNER="Owner"
TARGET_HOME="${OMP_KIT_HOME:-$HOME}"
FORCE=0
while [ $# -gt 0 ]; do
	case "$1" in
		--owner) OWNER="${2:?--owner needs a value}"; shift 2 ;;
		--home) TARGET_HOME="${2:?--home needs a value}"; shift 2 ;;
		--force) FORCE=1; shift ;;
		-h|--help) sed -n '2,14p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
if ! printf '%s' "$OWNER" | grep -Eq '^[[:alnum:] ._-]{1,40}$'; then
	echo "--owner must be 1-40 letters, digits, spaces, '.', '_' or '-'" >&2; exit 2
fi

KIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$KIT_ROOT/home/.omp"
[ -d "$SRC" ] || { echo "kit layout broken: $SRC not found" >&2; exit 1; }
mkdir -p "$TARGET_HOME"
TARGET_HOME="$(cd "$TARGET_HOME" && pwd)"
DEST="$TARGET_HOME/.omp"

echo "omp-portable-kit installer"
echo "  kit:    $KIT_ROOT"
echo "  target: $DEST"
echo "  owner:  $OWNER"
echo
echo "Prerequisites (nothing is installed for you):"
ok=1
tool() { # name hint optional
	if command -v "$1" >/dev/null 2>&1; then
		printf '  ok       %-10s %s\n' "$1" "$("$1" --version 2>/dev/null | head -n 1 || true)"
	elif [ "${3:-}" = optional ]; then
		printf '  optional %-10s %s\n' "$1" "$2"
	else
		printf '  MISSING  %-10s %s\n' "$1" "$2"; ok=0
	fi
}
tool node "Node.js 20+: brew install node / your distro's nodejs (or https://nodejs.org)"
tool git "brew install git / apt install git"
tool gh "GitHub CLI: brew install gh / https://cli.github.com, then gh auth login"
tool omp "oh-my-pi: see https://github.com/can1357/oh-my-pi (install, then open a new shell)"
tool playwright "browser smoke tests: npm i -g playwright; npx playwright install chromium" optional
tool ffmpeg "video/frame tools: brew install ffmpeg / apt install ffmpeg" optional
tool blender "3D asset work: https://www.blender.org/download" optional
[ "$ok" = 1 ] || printf '\nSome required tools are missing; templates are installed anyway. Install them before the first session.\n'
echo

# ------------------------------------------------------------------ copy templates
esc() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
HOME_ESC="$(esc "$TARGET_HOME")"
OWNER_ESC="$(esc "$OWNER")"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DEST/_kit-backup/$STAMP"
created=0; unchanged=0; keptn=0; replaced=0; kept_list=""
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

echo "Templates:"
while IFS= read -r -d '' f; do
	rel="${f#"$SRC"/}"
	target="$DEST/$rel"
	case "$rel" in
		agent/skills/impeccable/*|agent/skills/skill-creator/*) cp "$f" "$tmp" ;;
		*.md|*.yml|*.yaml|*.json) sed -e "s|{{HOME}}|$HOME_ESC|g" -e "s|{{OWNER}}|$OWNER_ESC|g" "$f" > "$tmp" ;;
		*) cp "$f" "$tmp" ;;
	esac
	if [ -f "$target" ]; then
		if cmp -s "$tmp" "$target"; then unchanged=$((unchanged + 1)); continue; fi
		if [ "$FORCE" != 1 ]; then keptn=$((keptn + 1)); kept_list="$kept_list    kept existing: $rel"$'\n'; continue; fi
		mkdir -p "$(dirname "$BACKUP/$rel")"
		cp -p "$target" "$BACKUP/$rel"
		cp "$tmp" "$target"
		replaced=$((replaced + 1))
		echo "  replaced $rel (backup in _kit-backup/$STAMP)"
		continue
	fi
	mkdir -p "$(dirname "$target")"
	cp "$tmp" "$target"
	case "$rel" in *.sh|*.mjs) chmod +x "$target" ;; esac
	created=$((created + 1))
done < <(find "$SRC" -type f -print0)
mkdir -p "$DEST/wt/_logs" "$DEST/wt/_compact" "$DEST/secrets"
chmod 700 "$DEST/secrets"
echo "  $created created, $unchanged unchanged, $keptn kept (differ; use --force to replace), $replaced replaced"
printf '%s' "$kept_list"
echo "  dirs: .omp/wt/_logs, .omp/wt/_compact, .omp/secrets"
echo

# ------------------------------------------------------------------ impeccable engine
# The skill's launcher (scripts/impeccable) runs bin/<os>-<arch>/impeccable when present and
# otherwise downloads into ~/.impeccable on first use. Fetch it now so the skill works offline later.
imp_scripts="$DEST/agent/skills/impeccable/scripts"
imp_version="$(tr -d '[:space:]' < "$imp_scripts/VERSION")"
case "$(uname -s)" in Darwin) imp_os=darwin ;; Linux) imp_os=linux ;; MINGW*|MSYS*|CYGWIN*) imp_os=windows ;; *) imp_os="" ;; esac
case "$(uname -m)" in arm64|aarch64) imp_arch=arm64 ;; x86_64|amd64) imp_arch=x64 ;; *) imp_arch="" ;; esac
# There is no windows-arm64 asset; Windows on ARM runs the x64 binary.
[ "$imp_os" = windows ] && imp_arch=x64
imp_exe=""; [ "$imp_os" = windows ] && imp_exe=".exe"
imp_asset="impeccable-$imp_os-$imp_arch$imp_exe"
imp_url="https://github.com/pbakaus/impeccable/releases/download/engine-v$imp_version/$imp_asset"
imp_bin="$imp_scripts/bin/$imp_os-$imp_arch/impeccable$imp_exe"
imp_manual() {
	echo "  The skill downloads it on first use instead. To install it by hand, save"
	echo "  $imp_url"
	echo "  as $imp_bin and chmod +x it (release page: https://github.com/pbakaus/impeccable/releases/tag/engine-v$imp_version)"
}
sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
echo "impeccable engine:"
if [ -z "$imp_os" ] || [ -z "$imp_arch" ]; then
	echo "  skipped: no prebuilt engine for $(uname -s)/$(uname -m); see https://impeccable.style"
elif [ -f "$imp_bin" ]; then
	echo "  present  $imp_bin"
elif ! command -v curl >/dev/null 2>&1; then
	echo "  not fetched: curl is not installed"; imp_manual
else
	mkdir -p "$(dirname "$imp_bin")"
	part="$imp_bin.part"
	expected="$(curl -fsSL --retry 2 "$imp_url.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
	if ! curl -fsSL --retry 2 -o "$part" "$imp_url"; then
		rm -f "$part"; echo "  not fetched: download failed ($imp_url)"; imp_manual
	elif [ -z "$expected" ] || [ "$(sha256_of "$part")" != "$expected" ]; then
		rm -f "$part"; echo "  not fetched: could not verify the download against $imp_url.sha256"; imp_manual
	else
		mv "$part" "$imp_bin"; chmod +x "$imp_bin"
		echo "  fetched  engine v$imp_version (sha256 verified) -> $imp_bin"
	fi
fi
echo

cat <<EOF
Next steps (full detail in README.md):
  1. omp login <provider> for each subscription you have (anthropic, openai-codex, cursor, ...); omp usage
  2. Edit $DEST/agent/config.yml: modelRoles + retry.fallbackChains for the providers you have
  3. Edit $DEST/agent/agents/*-worker.md: model: lines (omp models <provider>)
  4. Edit $DEST/farm.config.json: "repo" = your project's main checkout (+ refs, setupCommands)
  5. Edit $DEST/agent/APPEND_SYSTEM.md: the <FILL: ...> lines (routing, datastores, build limit)
  6. MCP: set "enabled": true in $DEST/agent/mcp.json for the servers you use, then /mcp in omp
     gmail: (cd $DEST/agent/mcp-servers/gmail && npm ci); put GMAIL_* keys in $DEST/secrets/gmail.env
  7. Clone the project, install deps, write its CLAUDE.md from repo-template/CLAUDE.md
  8. node $DEST/farm-add-worker.mjs <Name> claude   (one per worker), then start omp in the repo
EOF
