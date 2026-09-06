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
#   9. Flagged accepted SHA-256 evidence digests in prose. Their 64-hex shape overlaps real tokens,
#      so the shape cannot be exempted. Only exact reviewed digest values may be listed in
#      .secret-scan-entropy-allowlist, and only the entropy layer consults it; a named credential
#      assignment using the same value remains a blocker.
#  10. Flagged Supabase `sb_publishable_` browser keys as secrets. Those keys are public by design,
#      so only their bounded self-identifying format is removed; `sb_secret_`, service-role keys,
#      generic credentials, and malformed/overlong publishable values still reach both layers.
#
#
# KNOWN LIMIT, stated rather than hidden: the entropy layer ignores tokens containing "-" or "/",
# because slugs, dates and paths are full of them and the false-positive rate was unusable. A
# hyphenated secret is therefore only caught by layer 1, i.e. only if its variable name is
# recognisable. Prefer non-hyphenated secret formats.
set -uo pipefail

L1='(password|passwd|secret|token|credential|[a-z0-9_-]*key)[[:space:]]*[=:][[:space:]]*['"'"'"]?[A-Za-z0-9/+_=-]{16,}'
SCANNER_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
ENTROPY_ALLOWLIST_PATH="$SCANNER_ROOT/.secret-scan-entropy-allowlist"

validate_entropy_allowlist() {
  if [ -L "$ENTROPY_ALLOWLIST_PATH" ]; then
    echo "invalid entropy allowlist: symlinks are not accepted" >&2
    return 1
  fi
  if [ ! -e "$ENTROPY_ALLOWLIST_PATH" ]; then
    return 0
  fi
  if [ ! -f "$ENTROPY_ALLOWLIST_PATH" ]; then
    echo "invalid entropy allowlist: expected a regular file" >&2
    return 1
  fi

  local invalid duplicates
  invalid=$(grep -nEv '^[[:space:]]*(#.*)?$|^[0-9a-f]{64}$' "$ENTROPY_ALLOWLIST_PATH" || true)
  if [ -n "$invalid" ]; then
    echo "invalid entropy allowlist: expected exact lowercase SHA-256 values" >&2
    printf '%s\n' "$invalid" >&2
    return 1
  fi
  duplicates=$(grep -E '^[0-9a-f]{64}$' "$ENTROPY_ALLOWLIST_PATH" | sort | uniq -d || true)
  if [ -n "$duplicates" ]; then
    echo "invalid entropy allowlist: duplicate values" >&2
    printf '%s\n' "$duplicates" >&2
    return 1
  fi
}

validate_entropy_allowlist || exit 2

# Drop known-benign shapes: template placeholders, env references, documented placeholders.
strip_benign() {
  grep -vE '\$\{|\$\{\{|process\.env|change-me|<your|YOUR_|example|EXAMPLE' \
  | grep -vE 'package-lock\.json|integrity|sha512-|sha1-' \
  | grep -vE "[=:][[:space:]]*[\`'\"]?[A-Z0-9_]+[\`'\"]?([[:space:],;\)\}\`]|$)"
}

# Replace only the exact inert literals used to prove evaluation-artifact privacy. Keep the rest
# of each line visible so a second, real secret on the same line still blocks the push.
strip_known_test_sentinels() {
  sed -e 's/credential=diagnostic-secret/TEST_SENTINEL/g' \
      -e 's/client_secret=synthetic-secret/TEST_SENTINEL/g' \
      -e 's/password=synthetic-secret/TEST_SENTINEL/g' \
      -e "s/key: 'post-v5-baseline-' + index/TEST_SENTINEL/g"
}

# Normalize only the public project identifier and inert auth values in their exact feedback-test
# contexts. The rest of each line remains visible so another secret still blocks the push.
strip_public_feedback_fixtures() {
  sed -E \
      -e "s/((targetKey|target_key)[[:space:]]*[=:][[:space:]]*['\"])hiring-observatory(['\"])/\1PUBLIC_TARGET\3/g" \
      -e "s/(type[[:space:]]*:[[:space:]]*['\"]project['\"][[:space:]]*,[[:space:]]*key[[:space:]]*:[[:space:]]*['\"])hiring-observatory(['\"])/\1PUBLIC_TARGET\2/g" \
      -e "s/(refresh_token[[:space:]]*:[[:space:]]*['\"])supabase-refresh(['\"])/\1TEST_TOKEN\2/g" \
      -e "s/(provider_token[[:space:]]*:[[:space:]]*['\"])provider-access-token(['\"])/\1TEST_TOKEN\2/g" \
      -e "s/(provider_token[[:space:]]*:[[:space:]]*['\"])nested-github-access(['\"])/\1TEST_TOKEN\2/g"
}

# Supabase publishable keys are intentionally public browser configuration. The bounded suffix and
# token boundaries keep this from becoming a generic `sb_` or assignment-name exemption.
strip_public_publishable_keys() {
  sed -E 's/(^|[^A-Za-z0-9_-])sb_publishable_[A-Za-z0-9_-]{20,128}([^A-Za-z0-9_-]|$)/\1PUBLIC_KEY\2/g'
}

# This exact alphabet is public codec data. Keep the exemption in layer 2 so a credential-named
# assignment still reaches layer 1, and require token boundaries so longer values are never hidden.
PUBLIC_ALPHANUMERIC_ALPHABET=ABCDEFGHIJKLMNOPQRSTUVWXYZ
PUBLIC_ALPHANUMERIC_ALPHABET+=abcdefghijklmnopqrstuvwxyz
PUBLIC_ALPHANUMERIC_ALPHABET+=0123456789
strip_public_alphanumeric_alphabet() {
  sed -E "s/(^|[^A-Za-z0-9+_=])${PUBLIC_ALPHANUMERIC_ALPHABET}([^A-Za-z0-9+_=]|$)/\1PUBLIC_ALPHABET\2/g"
}


# A schema-bound provenance SHA is not a credential. Unlike strip_git_shas below, this rule does
# not depend on the object existing in the local clone: rebases can leave a valid recorded SHA in
# historical evidence after the object itself becomes unreachable. Normalize only whole JS/JSON
# `sha` properties, the head/base fields of the strict branch-cleanup audit table, and backtick-
# wrapped SHAs on lines explicitly naming Git provenance. Other tokens on those lines remain visible
# to entropy detection.
strip_provenance_sha_lines() {
  grep -vE "^[+[:space:]]*[\"']?sha[\"']?[[:space:]]*:[[:space:]]*[\"'][0-9a-f]{40}[\"'][[:space:]]*[,}]?[[:space:]]*$" \
  | sed -E \
      -e 's/^([+]?\|[[:space:]]+(origin\/)?codex\/[A-Za-z0-9._\/-]+[[:space:]]+)[0-9a-f]{40}([[:space:]]+\|[[:space:]]+[0-9]+\/[0-9]+[[:space:]]+\|)/\1GIT_SHA\3/' \
      -e '/^[+]?\|[[:space:]]+(origin\/)?codex\/[A-Za-z0-9._\/-]+[[:space:]]+GIT_SHA[[:space:]]+\|[[:space:]]+[0-9]+\/[0-9]+[[:space:]]+\|/ s/(base[[:space:]]+)[0-9a-f]{40}/\1GIT_SHA/' \
      -e '/(HEAD|origin\/|commit|branch)/ s/`[0-9a-f]{40}`/`GIT_SHA`/g'
}

# Layer 2 judges the TOKEN, not the line: >=32 chars, no - or /, and mixes digits with letters.
entropy_hits() {
  grep -noE '[A-Za-z0-9+_=]{32,}' 2>/dev/null \
  | awk -F: '{ t=$0; sub(/^[0-9]+:/,"",t);
               if (t ~ /[0-9]/ && t ~ /[A-Za-z]/) print }'
}

# Suppress only explicitly accepted evidence values, and only after entropy detection. Layer 1
# still reports the same value when it is assigned to a credential-shaped name.
strip_accepted_evidence_digests() {
  local line token
  while IFS= read -r line; do
    token=${line#*:}
    if [[ "$token" =~ ^[0-9a-f]{64}$ ]] &&
       [ -f "$ENTROPY_ALLOWLIST_PATH" ] &&
       grep -Fxq "$token" "$ENTROPY_ALLOWLIST_PATH"; then
      continue
    fi
    printf '%s\n' "$line"
  done
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
  input=$(printf '%s\n' "$input" | strip_known_test_sentinels | strip_public_publishable_keys | strip_public_feedback_fixtures)
  { printf '%s\n' "$input" | grep -nEi "$L1"
    printf '%s\n' "$input" | strip_provenance_sha_lines | strip_public_alphanumeric_alphabet | entropy_hits | strip_accepted_evidence_digests
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
  printf '%s\n' "$input" | strip_public_publishable_keys | grep -nEi "$L1" 2>/dev/null | strip_git_shas | sort -u
}

scan_historical_payload_stream() {
  local input="$1"
  printf '%s\n' "$input" | strip_public_publishable_keys | grep -nEi "$L1" 2>/dev/null | strip_benign | strip_git_shas | sort -u
}

quarantine_staged_payloads() {
  local path matches quarantined=0
  while IFS= read -r -d '' path; do
    matches=$(scan_payload_stream "$(git show ":$path" 2>/dev/null)")
    if [ -n "$matches" ]; then
      git restore --staged -- "$path" || return 2
      echo "quarantined staged source payload: $path (named credential pattern; content suppressed)"
      quarantined=$((quarantined + 1))
    fi
  done < <(git diff --cached --name-only --diff-filter=A -z -- "${PAYLOAD_PATHS[@]}")

  if [ "$quarantined" -ne 0 ]; then
    echo "quarantined $quarantined unsafe staged source payload(s); content suppressed"
    return 1
  fi
  echo "staged source payload quarantine: clean"
}

self_test() {
  local fails=0 t r1 r2 r3 r4 r5 r6 public_alphabet public_target synthetic_refresh synthetic_provider synthetic_nested_provider real_sha accepted_digest_1 accepted_digest_2 script_path lock_repo history_repo history_tree history_parent i
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
  # Exactly 64 hex, the shape of a SHA-256 evidence digest and some real credentials. Exempt only
  # explicitly accepted evidence values, never the shape as a class.
  r6=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  public_alphabet=$(printf '%s%s%s' 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz' '0123456789')
  public_target=$(printf '%s%s' 'hiring-' 'observatory')
  synthetic_refresh=$(printf '%s%s' 'supabase-' 'refresh')
  synthetic_provider=$(printf '%s%s%s' 'provider-' 'access-' 'token')
  synthetic_nested_provider=$(printf '%s%s' 'nested-' 'github-access')
  real_sha=$(git rev-parse HEAD 2>/dev/null || echo 0000000000000000000000000000000000000000)
  accepted_digest_1=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  accepted_digest_2=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  ENTROPY_ALLOWLIST_PATH="$t/accepted-digests"
  printf '%s\n%s\n' "$accepted_digest_1" "$accepted_digest_2" > "$ENTROPY_ALLOWLIST_PATH"
  if ! validate_entropy_allowlist; then
    echo "  MISSED  valid_entropy_allowlist"; return 1
  fi

  printf 'POSTGRES_PASSWORD=%s\n' "$r1"       > "$t/pos1_named_env"
  printf 'token: %s\n'            "$r3"       > "$t/pos2_yaml_token"
  printf '  ADZUNA_APP_KEY: %s\n' "$r2"       > "$t/pos3_appkey"
  printf 'const w = "%s";\n'      "$r4"       > "$t/pos4_unnamed"
  printf 'const build = "%s";\n'  "$r5"       > "$t/pos5_40hex_not_an_object"
  printf 'const OTHER_SHA256 = "%s";\n' "$r6" > "$t/pos6_unaccepted_sha256"
  printf 'api_key=%s\n' "$accepted_digest_1" > "$t/pos7_allowlisted_named"
  printf '| codex/test-provenance %s | 0/1 | base %s; extra %s | SAFE (test) |\n' "$r5" "$r5" "$r6" > "$t/pos8_audit_extra_token"
  printf 'real branch HEAD remained `%s`; extra %s\n' "$r5" "$r6" > "$t/pos9_markdown_extra_token"
  printf 'SUPABASE_SECRET_KEY=sb_secret_%s\n' "$r1" > "$t/pos11_supabase_secret"
  printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "$r2" > "$t/pos12_service_role_secret"
  printf 'SUPABASE_PUBLISHABLE_KEY=sb_publishable_%s%s%s\n' "$r1" "$r1" "$r1" > "$t/pos13_overlong_publishable"
  printf 'api_key=%s\n' "$public_alphabet" > "$t/pos14_named_public_alphabet"
  printf 'const alphabet = "%s"; const secret = "%s";\n' "$public_alphabet" "$r6" > "$t/pos15_alphabet_plus_secret"
  printf 'api_key=%s\n' "$public_target" > "$t/pos16_repo_value_as_credential"
  printf 'targetKey: "%s"; const secret = "%s";\n' "$public_target" "$r6" > "$t/pos17_target_plus_secret"
  printf "api_key='%s'\n" "$synthetic_refresh" > "$t/pos18_refresh_as_key"
  printf "api_key='%s'\n" "$synthetic_provider" > "$t/pos19_provider_as_key"
  printf "refresh_token: '%s'; const secret = '%s'\n" "$synthetic_refresh" "$r6" > "$t/pos20_token_plus_secret"
  printf "api_key='%s'\n" "$synthetic_nested_provider" > "$t/pos21_nested_as_key"

  printf 'const c = new Client({ password: POSTGRES_PASSWORD, db: PG_DB });\n' > "$t/neg1_identifier"
  printf "create role publisher login password '\${PUBLISHER_PASSWORD}';\n"    > "$t/neg2_template"
  printf 'POSTGRES_PASSWORD=change-me-long-random\n'                           > "$t/neg3_placeholder"
  printf '  password: ${{ secrets.PG_PASSWORD }}\n'                            > "$t/neg4_actions"
  printf 'The api_key must never be committed to this repository, ever.\n'     > "$t/neg5_prose"
  printf 'See docs/plans/2026-08-08-m1-infrastructure.md and github.com/VatsalyaB/hiring-observatory\n' > "$t/neg6_paths"
  printf 'backups/observatory-2026-08-09T00-32-34-902Z.dump was restored.\n'   > "$t/neg7_filename"
  # The canary payload shape (scripts/canary.mjs) — a real commit SHA, recorded as provenance.
  printf 'credential=diagnostic-secret api_key=%s\n' "$r1" > "$t/pos10_sentinel_plus_real"
  printf 'credential=diagnostic-secret\n' > "$t/neg14_test_sentinel"
  printf 'SUPABASE_PUBLISHABLE_KEY=sb_publishable_%s\n' "$r1" > "$t/neg15_publishable_env"
  printf "  supabasePublishableKey: 'sb_publishable_%s',\n" "$r1" > "$t/neg16_feedback_config"
  printf '  "sha": "%s"\n'        "$real_sha" > "$t/neg8_canary_git_sha"
  # This value deliberately does not need to resolve in the current clone. Rebased-away commits
  # remain legitimate provenance in historical fixtures and must behave identically in CI.
  printf "  sha: '%s',\n"           "$r5"       > "$t/neg9_unreachable_provenance_sha"
  printf 'documented evidence digest `%s`.\n' "$accepted_digest_1" > "$t/neg10_accepted_sha256_1"
  printf 'documented evidence digest `%s`.\n' "$accepted_digest_2" > "$t/neg11_accepted_sha256_2"
  printf '| codex/test-provenance %s | 0/1 | base %s; audit evidence | SAFE (test evidence) |\n' "$r5" "$r5" > "$t/neg12_audit_git_shas"
  printf 'real branch HEAD remained `%s`\n' "$r5" > "$t/neg13_markdown_git_sha"
  printf 'const alphabet = "%s";\n' "$public_alphabet" > "$t/neg17_public_alphabet"
  printf "targetKey: '%s'\n" "$public_target" > "$t/neg18_public_target_camel"
  printf "target_key: '%s'\n" "$public_target" > "$t/neg19_public_target_snake"
  printf "{ type: 'project', key: '%s' }\n" "$public_target" > "$t/neg20_public_project_key"
  printf "refresh_token: '%s'\n" "$synthetic_refresh" > "$t/neg21_synthetic_refresh_token"
  printf "provider_token: '%s'\n" "$synthetic_provider" > "$t/neg22_synthetic_provider_token"
  printf "nested: { provider_token: '%s', kept: true }\n" "$synthetic_nested_provider" > "$t/neg23_nested_provider"

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
  printf '"description": "example internal portal, api_key=%s do not share"\n' "$r1" > "$t/raw_pos_named_secret"

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

  # History work must scale with changed content, not commit count. A large unchanged blob behind
  # many empty commits reproduces the repeated-tree scan that exhausted the CI job's 25-minute
  # budget while keeping the fixture itself small on disk.
  history_repo="$t/history-repository"
  git init -q "$history_repo"
  git -C "$history_repo" config user.email scanner@example.invalid
  git -C "$history_repo" config user.name scanner
  yes 'safe value' | head -n 400000 > "$history_repo/unchanged.txt"
  git -C "$history_repo" add unchanged.txt
  history_tree=$(git -C "$history_repo" write-tree)
  history_parent=$(printf 'root\n' | git -C "$history_repo" commit-tree "$history_tree")
  for i in $(seq 1 400); do
    history_parent=$(printf 'empty %s\n' "$i" | git -C "$history_repo" commit-tree "$history_tree" -p "$history_parent")
  done
  git -C "$history_repo" update-ref refs/heads/main "$history_parent"
  if ! (cd "$history_repo" && timeout 8s bash "$script_path" --history >/dev/null); then
    echo "  SLOW/FAIL  history_changed_content_budget"; fails=1
  else echo "  bounded  history_changed_content_budget"; fi

  git -C "$history_repo" symbolic-ref HEAD refs/heads/main
  printf 'token: %s\n' "$r1" > "$history_repo/deleted-secret.txt"
  git -C "$history_repo" add deleted-secret.txt
  git -C "$history_repo" commit -qm 'add generated historical leak'
  git -C "$history_repo" rm -q deleted-secret.txt
  git -C "$history_repo" commit -qm 'remove generated historical leak'
  if (cd "$history_repo" && bash "$script_path" --history >/dev/null 2>&1); then
    echo "  MISSED  deleted_history_secret"; fails=1
  else echo "  caught  deleted_history_secret"; fi

  [ "$fails" -eq 0 ] && echo "self-test: OK (22 generated secrets caught, 26 lookalikes ignored)" \
                     || echo "self-test: FAILED"
  return "$fails"
}

# WHERE THIRD-PARTY PAYLOADS LIVE. Defined once, because scoping this to a single directory is a
# mistake already made: the first version covered only `raw/`, and the pre-push hook then blocked a
# push over `adapters/fixtures/adzuna-nz.json` — which is the SAME Adzuna payload, saved as a test
# fixture. The rule is about the KIND of content, not the folder it sits in. Any new location that
# stores somebody else's response belongs in this list.
PAYLOAD_PATHS=('raw/' 'adapters/fixtures/')
CODE_EXCLUDE=(':!raw/' ':!adapters/fixtures/' ':!.secret-scan-entropy-allowlist')
LOCK_EXCLUDE=(':!package-lock.json' ':!*.lock')

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --quarantine-staged-payloads) quarantine_staged_payloads; exit $? ;;
  --history)
    # Lockfiles and raw/ are separated by PATHSPEC, not by a text filter. `git grep -h` strips the
    # filename, so nothing downstream could tell which file a line came from — an earlier version
    # flagged every npm sha512 integrity hash in package-lock.json and blocked the first push, and
    # the same blindness is why third-party payloads need splitting off here rather than later.
    echo "scanning every commit on every ref (lockfiles excluded; raw/ scanned layer-1 only) ..."
    # A line only needs scanning when history adds or deletes it. Grepping every complete tree once
    # per commit repeatedly rescanned unchanged blobs and exhausted CI's 25-minute job budget.
    # --no-renames makes moves visible under both paths; stripping diff markers restores file text.
    hits=$(scan_stream "$(git log --all --format= --root --no-renames --unified=0 -p -- \
                          . ':!package-lock.json' ':!*.lock' "${CODE_EXCLUDE[@]}" 2>/dev/null \
                          | sed -n -e '/^+++ /d' -e '/^--- /d' -e 's/^[+-]//p')")
    raw_hits=$(scan_historical_payload_stream "$(git log --all --format= --root --no-renames --unified=0 -p -- \
                                                "${PAYLOAD_PATHS[@]}" 2>/dev/null \
                                                | sed -n -e '/^+++ /d' -e '/^--- /d' -e 's/^[+-]//p')")
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
  raw_hit_count=$(printf '%s\n' "$raw_hits" | wc -l | tr -d ' ')
  echo "!! NAMED CREDENTIAL PATTERN INSIDE raw/ — $raw_hit_count match(es); content suppressed"
  exit 1
fi

if [ -n "${hits:-}" ]; then
  hit_count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  echo "!! POSSIBLE SECRETS — $hit_count match(es); content suppressed"
  exit 1
fi
echo "scan-secrets: clean"
