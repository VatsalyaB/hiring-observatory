#!/usr/bin/env bash
# Secret scanner for the D-009 light gate and the pre-push full protocol.
#
#   scan-secrets.sh              scan the staged diff        (every commit)
#   scan-secrets.sh --history    scan every commit, all refs (before any push)
#   scan-secrets.sh --self-test  prove the scanner can FAIL  (run after editing it)
#
# HISTORY OF THIS FILE'S OWN BUGS — kept because each was found by testing the scanner rather than
# trusting it, and because they are the reason it is shaped this way:
#   1. Matched `token=` but not `token:` → would have missed a leaked token in YAML, which is
#      precisely the format GitHub Actions workflows use.
#   2. Keyword list had `api_key` but not `app_key` → would have missed ADZUNA_APP_KEY, the literal
#      parameter name of the first data source this project integrates.
#   3. Fired on `password: POSTGRES_PASSWORD` — an identifier reference, not a value.
#   4. Entropy layer tested whether the *line* contained a digit rather than the matched *token*,
#      so every file path and URL tripped it. A scanner that cries wolf gets ignored, which is how
#      a real secret walks through.
#   5. Contained literal fake secrets as test fixtures, so it flagged itself and blocked its own
#      commit. Fixtures are now generated at runtime; no secret-shaped literal lives in this file.
#   6. Flagged git commit SHAs. `scripts/canary.mjs` records the commit a heartbeat ran against, so
#      every canary payload carries a 40-hex string — indistinguishable from a token by shape alone.
#      Left alone, `--history` would have reported "possible secrets" on every scheduled run from
#      2026-08-09 onward. That is bug 4 repeating in a new costume: the danger is not the false
#      positive, it is that a scanner which always cries wolf stops being read at all.
#   7. Applied the entropy layer to third-party payloads. The first real day of ingestion — 475 job
#      advertisements — produced 20 hits: Adzuna redirect tokens, base64 tracking parameters, and
#      Microsoft SafeLinks wrappers that recruiters had pasted into job descriptions. All public,
#      none secret, and all of them guaranteed to recur every single day. raw/ is now scanned with
#      LAYER 1 ONLY, and reported separately, because "is this string random-looking?" is a good
#      question about our code and a meaningless one about somebody else's JSON — while "is
#      something named like a credential being assigned a value?" stays meaningful everywhere.
#   8. Excluded lockfiles only in history mode. A fresh public root stages package-lock.json in full,
#      and base64 integrity continuation lines have no filename or `integrity` label left for the
#      text filters to recognize. Staged mode now uses the same pathspec exclusion as history mode.
#
# KNOWN LIMIT, stated rather than hidden: the entropy layer ignores tokens containing "-" or "/",
# because slugs, dates and paths are full of them and the false-positive rate was unusable. A
# hyphenated secret is therefore only caught by layer 1, i.e. only if its variable name is
# recognisable. Prefer non-hyphenated secret formats.
set -uo pipefail

L1='(password|passwd|secret|token|credential|[a-z0-9_-]*key)[[:space:]]*[=:][[:space:]]*['"'"'"]?[A-Za-z0-9/+_=-]{16,}'

# Drop known-benign shapes: template placeholders, env references, documented placeholders.
strip_benign() {
  grep -vE '\$\{|\$\{\{|process\.env|change-me|<your|YOUR_|example|EXAMPLE' \
  | grep -vE 'package-lock\.json|integrity|sha512-|sha1-' \
  | grep -vE "[=:][[:space:]]*[\`'\"]?[A-Z0-9_]+[\`'\"]?([[:space:],;\)\}\`]|$)"
}

# A schema-bound provenance SHA is not a credential. Unlike strip_git_shas below, this rule does
# not depend on the object existing in the local clone: rebases can leave a valid recorded SHA in
# historical test evidence after the object itself becomes unreachable. Keep the exemption to a
# whole JS/JSON `sha` property line so the same 40-hex value still trips anywhere else.
strip_provenance_sha_lines() {
  grep -vE "^[+[:space:]]*[\"']?sha[\"']?[[:space:]]*:[[:space:]]*[\"'][0-9a-f]{40}[\"'][[:space:]]*[,}]?[[:space:]]*$"
}

# Layer 2 judges the TOKEN, not the line: >=32 chars, no - or /, and mixes digits with letters.
entropy_hits() {
  grep -noE '[A-Za-z0-9+_=]{32,}' 2>/dev/null \
  | awk -F: '{ t=$0; sub(/^[0-9]+:/,"",t);
               if (t ~ /[0-9]/ && t ~ /[A-Za-z]/) print }'
}

# A 40-hex string that resolves to a real object in THIS repository is a git SHA, not a secret.
#
# Narrow by construction, and deliberately so. It drops a token only when `git cat-file -e` confirms
# the object exists here, so a random 40-hex credential still trips the scanner. Nothing under raw/
# is blanket-excluded — that would be the dangerous fix, because raw payloads are exactly where a
# credential-bearing URL would land (invariant 8), and excluding the directory would hide the one
# case worth catching.
strip_git_shas() {
  while IFS= read -r line; do
    tok=${line#*:}
    if [[ "$tok" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$tok" 2>/dev/null; then
      continue
    fi
    printf '%s\n' "$line"
  done
}

scan_stream() {
  local input="$1"
  { printf '%s\n' "$input" | grep -nEi "$L1"
    printf '%s\n' "$input" | strip_provenance_sha_lines | entropy_hits
  } 2>/dev/null | strip_benign | strip_git_shas | sort -u
}

# THIRD-PARTY PAYLOADS GET LAYER 1 ONLY — see bug 7.
#
# The entropy layer asks "is this a long random-looking string?", which is a good question about code
# we wrote and a useless one about somebody else's JSON. The first real day of ingestion produced 20
# hits from 475 job advertisements: Adzuna redirect tokens, base64 tracking parameters, and Microsoft
# SafeLinks wrappers pasted into job descriptions by recruiters. All public, none secret, and all of
# them recurring EVERY DAY forever.
#
# Layer 1 is kept, and that is the whole design. It asks a different question — "is something NAMED
# like a credential being assigned a value?" — which stays meaningful in any text. An `api_key=` or
# `token:` appearing inside a raw payload is exactly the invariant 8 leak worth catching, and it
# still is.
#
# Blanket-excluding raw/ would have been the easy fix and the wrong one: raw payloads are precisely
# where a credential-bearing URL would land, so it is the last directory to stop looking at.
scan_payload_stream() {
  local input="$1"
  printf '%s\n' "$input" | grep -nEi "$L1" 2>/dev/null | strip_benign | strip_git_shas | sort -u
}

self_test() {
  local fails=0 t r1 r2 r3 r4 script_path lock_repo
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  t=$(mktemp -d); trap 'rm -rf "$t"' RETURN
  # Generated, never literal — see bug 5 above.
  r1=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  r2=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  r3=$(head -c 30 /dev/urandom | base64 | tr -d '=\n/+-')
  r4=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  # Exactly 40 hex, the same shape as a git SHA, but NOT an object in this repo. This is the guard
  # on the bug-6 fix: it proves the git-SHA exemption is narrow enough to still catch a real
  # credential that happens to be 40 hex characters long.
  r5=$(head -c 20 /dev/urandom | od -An -tx1 | tr -d ' \n')
  real_sha=$(git rev-parse HEAD 2>/dev/null || echo 0000000000000000000000000000000000000000)

  printf 'POSTGRES_PASSWORD=%s\n' "$r1"       > "$t/pos1_named_env"
  printf 'token: %s\n'            "$r3"       > "$t/pos2_yaml_token"
  printf '  ADZUNA_APP_KEY: %s\n' "$r2"       > "$t/pos3_appkey"
  printf 'const w = "%s";\n'      "$r4"       > "$t/pos4_unnamed"
  printf 'const build = "%s";\n'  "$r5"       > "$t/pos5_40hex_not_an_object"

  printf 'const c = new Client({ password: POSTGRES_PASSWORD, db: PG_DB });\n' > "$t/neg1_identifier"
  printf "create role publisher login password '\${PUBLISHER_PASSWORD}';\n"    > "$t/neg2_template"
  printf 'POSTGRES_PASSWORD=change-me-long-random\n'                           > "$t/neg3_placeholder"
  printf '  password: ${{ secrets.PG_PASSWORD }}\n'                            > "$t/neg4_actions"
  printf 'The api_key must never be committed to this repository, ever.\n'     > "$t/neg5_prose"
  printf 'See docs/plans/2026-08-08-m1-infrastructure.md and github.com/VatsalyaB/hiring-observatory\n' > "$t/neg6_paths"
  printf 'backups/observatory-2026-08-09T00-32-34-902Z.dump was restored.\n'   > "$t/neg7_filename"
  # The canary payload shape (scripts/canary.mjs) — a real commit SHA, recorded as provenance.
  printf '  "sha": "%s"\n'        "$real_sha" > "$t/neg8_canary_git_sha"
  # This value deliberately does not need to resolve in the current clone. Rebased-away commits
  # remain legitimate provenance in historical fixtures and must behave identically in CI.
  printf "  sha: '%s',\n"           "$r5"       > "$t/neg9_unreachable_provenance_sha"

  for f in "$t"/pos*; do
    if [ "$(scan_stream "$(cat "$f")" | wc -l)" -eq 0 ]; then
      echo "  MISSED  $(basename "$f")"; fails=1
    else echo "  caught  $(basename "$f")"; fi
  done
  for f in "$t"/neg*; do
    if [ "$(scan_stream "$(cat "$f")" | wc -l)" -gt 0 ]; then
      echo "  FALSE+  $(basename "$f")"; fails=1
    else echo "  quiet   $(basename "$f")"; fi
  done

  # ---- the raw/ path (bug 7). Weakening a scanner needs proof it was not gutted. --------------
  # Real shapes taken from the 2026-08-09 capture: an Adzuna redirect token and a SafeLinks wrapper.
  printf '"redirect_url": "https://www.adzuna.co.nz/land/ad/5806453494?se=%s&utm_medium=api"\n' "$r3" > "$t/raw_neg_url_token"
  printf '"description": "apply via https://eur.safelinks.protection.outlook.com/?url=x&sdata=%s"\n' "$r3" > "$t/raw_neg_safelinks"
  # ...and the leak that MUST still be caught even inside somebody else's JSON (invariant 8).
  printf '"description": "internal portal, api_key=%s do not share"\n' "$r1" > "$t/raw_pos_named_secret"

  for f in "$t"/raw_neg_*; do
    if [ "$(scan_payload_stream "$(cat "$f")" | wc -l)" -gt 0 ]; then
      echo "  FALSE+  $(basename "$f")"; fails=1
    else echo "  quiet   $(basename "$f")"; fi
  done
  for f in "$t"/raw_pos_*; do
    if [ "$(scan_payload_stream "$(cat "$f")" | wc -l)" -eq 0 ]; then
      echo "  MISSED  $(basename "$f")"; fails=1
    else echo "  caught  $(basename "$f")"; fi
  done

  # A fresh public root stages package-lock.json in full. Integrity continuations contain only the
  # base64 digest, so line-based filtering cannot recognize them as lockfile metadata. Exercise the
  # real default scanner in a temporary repository; pathspec exclusion must keep this quiet.
  lock_repo="$t/lock-repository"
  git init -q "$lock_repo"
  printf '{"packages":{},"integrity":"sha512-%s"}\n' "$r3" > "$lock_repo/package-lock.json"
  git -C "$lock_repo" add package-lock.json
  if ! (cd "$lock_repo" && bash "$script_path" >/dev/null); then
    echo "  FALSE+  staged_package_lock"; fails=1
  else echo "  quiet   staged_package_lock"; fi

  [ "$fails" -eq 0 ] && echo "self-test: OK (6 generated secrets caught, 12 lookalikes ignored)" \
                     || echo "self-test: FAILED"
  return "$fails"
}

# WHERE THIRD-PARTY PAYLOADS LIVE. Defined once, because scoping this to a single directory is a
# mistake already made: the first version covered only `raw/`, and the pre-push hook then blocked a
# push over `adapters/fixtures/adzuna-nz.json` — which is the SAME Adzuna payload, saved as a test
# fixture. The rule is about the KIND of content, not the folder it sits in. Any new location that
# stores somebody else's response belongs in this list.
PAYLOAD_PATHS=('raw/' 'adapters/fixtures/')
CODE_EXCLUDE=(':!raw/' ':!adapters/fixtures/')
LOCK_EXCLUDE=(':!package-lock.json' ':!*.lock')

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --history)
    # Lockfiles and raw/ are separated by PATHSPEC, not by a text filter. `git grep -h` strips the
    # filename, so nothing downstream can tell which file a line came from — an earlier version
    # flagged every npm sha512 integrity hash in package-lock.json and blocked the first push, and
    # the same blindness is why third-party payloads need splitting off here rather than later.
    echo "scanning every commit on every ref (lockfiles excluded; raw/ scanned layer-1 only) ..."
    REVS=$(git rev-list --all)
    hits=$(scan_stream "$(git grep -I -h -E "$L1" $REVS -- ':!package-lock.json' ':!*.lock' "${CODE_EXCLUDE[@]}" 2>/dev/null; \
                          git grep -I -h -E '[A-Za-z0-9+_=]{32,}' $REVS -- ':!package-lock.json' ':!*.lock' "${CODE_EXCLUDE[@]}" 2>/dev/null)")
    raw_hits=$(scan_payload_stream "$(git grep -I -h -E "$L1" $REVS -- "${PAYLOAD_PATHS[@]}" 2>/dev/null)")
    ;;
  *)
    hits=$(scan_stream "$(git diff --cached --diff-filter=d -U0 -- "${LOCK_EXCLUDE[@]}" "${CODE_EXCLUDE[@]}")")
    raw_hits=$(scan_payload_stream "$(git diff --cached --diff-filter=d -U0 -- "${PAYLOAD_PATHS[@]}")")
    ;;
esac

# Named-credential hits inside third-party payloads are reported separately and loudly. They mean
# something different from a hit in our own code: not "we committed a secret" but "a source handed us
# one", which under invariant 8 is a private-tier problem rather than a git problem.
if [ -n "${raw_hits:-}" ]; then
  echo "!! NAMED CREDENTIAL PATTERN INSIDE raw/ — a source may have handed us a secret:"
  printf '%s\n' "$raw_hits" | head -10
  exit 1
fi

if [ -n "${hits:-}" ]; then
  echo "!! POSSIBLE SECRETS:"; printf '%s\n' "$hits" | head -20; exit 1
fi
echo "scan-secrets: clean"
