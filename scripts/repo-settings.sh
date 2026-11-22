#!/usr/bin/env bash
# GitHub のリポジトリ設定を issue #49 の形にそろえる。
#
#   scripts/repo-settings.sh            # dry-run。何を変えるかを表示するだけで、何も変えない
#   scripts/repo-settings.sh --apply    # 表示した内容で実際に変える
#   scripts/repo-settings.sh --repo owner/name [--apply]
#
# 変える内容は次の3つ。
#   1. マージ済みの PR の head ブランチを消す（条件は下の delete_candidates を参照）
#   2. delete_branch_on_merge を true にする
#   3. main に ruleset を作る（PR 必須、Build macOS の build ジョブを必須のチェックにする）
#
# 必要なもの: gh（ログイン済み）。macOS 標準の bash 3.2 で動く書き方にしてある。
set -euo pipefail

APPLY=0
REPO=""
RULESET_NAME="protect-main"
# Build macOS（.github/workflows/build-macos.yml）のジョブ id。check run の名前になる。
REQUIRED_CHECK="build"
# check run を出す GitHub Actions の app id。main のコミットの check run で実測した値。
ACTIONS_APP_ID=15368
# gh pr list で取る件数の上限。これに達したら取りこぼしがあるので止める。
PR_LIMIT=1000

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --repo)
      [ $# -ge 2 ] || { echo "--repo には owner/name を渡す" >&2; exit 2; }
      REPO="$2"
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    *) echo "知らない引数: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
[ -n "$REPO" ] || { echo "リポジトリが分からない。--repo owner/name を渡す" >&2; exit 1; }

# 書き込みは必ずここを通す。dry-run では打つはずのコマンドを表示するだけにする。
run() {
  if [ "$APPLY" -eq 1 ]; then
    echo "+ $*"
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

# 読み出しは -X GET を明示する（-f/-F を付けると gh api は黙って POST になるため）。
get() {
  gh api -X GET "$@"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$APPLY" -eq 1 ]; then
  echo "== $REPO の設定を変える（--apply）"
else
  echo "== $REPO の設定を変える予定を表示する（dry-run。何も変えない。変えるときは --apply）"
fi

# 手元にワークフローがあれば、必須にするジョブ名がまだ build のままかを確かめる。
WF=".github/workflows/build-macos.yml"
if [ -f "$WF" ] && ! grep -q "^  ${REQUIRED_CHECK}:" "$WF"; then
  echo "中断: $WF にジョブ '${REQUIRED_CHECK}' が無い。REQUIRED_CHECK を直してから走らせる" >&2
  exit 1
fi

DEFAULT_BRANCH="$(get "repos/$REPO" --jq .default_branch)"
[ -n "$DEFAULT_BRANCH" ] || { echo "中断: default ブランチが取れない" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. マージ済みの PR の head ブランチ
# ---------------------------------------------------------------------------
echo
echo "== 1. マージ済みの PR の head ブランチを消す"

# ブランチ名<TAB>先端の sha
get --paginate "repos/$REPO/branches?per_page=100" --jq '.[] | "\(.name)\t\(.commit.sha)"' \
  | sort > "$TMP/branches"
[ -s "$TMP/branches" ] || { echo "中断: ブランチの一覧が空" >&2; exit 1; }

# 同じリポジトリから出たマージ済みの PR。head 名<TAB>head の sha<TAB>番号<TAB>base 名
gh pr list -R "$REPO" --state merged --limit "$PR_LIMIT" \
  --json number,headRefName,headRefOid,baseRefName,isCrossRepository \
  --jq '.[] | select(.isCrossRepository | not) | "\(.headRefName)\t\(.headRefOid)\t\(.number)\t\(.baseRefName)"' \
  > "$TMP/merged"
if [ "$(wc -l < "$TMP/merged")" -ge "$PR_LIMIT" ]; then
  echo "中断: マージ済みの PR が ${PR_LIMIT} 件以上あり、取りこぼしがある。PR_LIMIT を上げる" >&2
  exit 1
fi

# 開いている PR。番号<TAB>head 名<TAB>base 名
gh pr list -R "$REPO" --state open --limit "$PR_LIMIT" \
  --json number,headRefName,baseRefName \
  --jq '.[] | "\(.number)\t\(.headRefName)\t\(.baseRefName)"' \
  > "$TMP/open"
if [ "$(wc -l < "$TMP/open")" -ge "$PR_LIMIT" ]; then
  echo "中断: 開いている PR が ${PR_LIMIT} 件以上あり、取りこぼしがある。PR_LIMIT を上げる" >&2
  exit 1
fi

# 消してよい条件:
#   - default ブランチではない
#   - 開いている PR の head でも base でもない（消すとその PR が閉じる）
#   - 同じリポジトリのマージ済みの PR があり、ブランチの先端がその PR の head の sha と一致する
#     （squash マージでは main の祖先にならないので、祖先かどうかでは判定しない）
: > "$TMP/delete"
kept=0
while IFS="$(printf '\t')" read -r name sha; do
  [ -n "$name" ] || continue
  if [ "$name" = "$DEFAULT_BRANCH" ]; then
    continue
  fi
  merged_rows="$(awk -F '\t' -v b="$name" '$1 == b' "$TMP/merged")"
  if [ -z "$merged_rows" ]; then
    continue # マージ済みの PR が無いブランチは対象外
  fi
  open_refs="$(awk -F '\t' -v b="$name" '$2 == b { printf "#%s の head ", $1 } $3 == b { printf "#%s の base ", $1 }' "$TMP/open")"
  if [ -n "$open_refs" ]; then
    echo "  残す  ${name}（開いている PR ${open_refs% }になっている）"
    kept=$((kept + 1))
    continue
  fi
  match="$(printf '%s\n' "$merged_rows" | awk -F '\t' -v s="$sha" '$2 == s { printf "#%s → %s", $3, $4; exit }')"
  if [ -z "$match" ]; then
    prs="$(printf '%s\n' "$merged_rows" | awk -F '\t' '{ printf "#%s ", $3 }')"
    echo "  残す  ${name}（マージ済みの PR ${prs% }の後にコミットがある。先端 ${sha:0:7}）"
    kept=$((kept + 1))
    continue
  fi
  case "$name" in
    *[!A-Za-z0-9._/-]*)
      echo "  残す  ${name}（名前に想定外の文字がある。手で確かめて消す）"
      kept=$((kept + 1))
      continue
      ;;
  esac
  printf '%s\t%s\n' "$name" "$match" >> "$TMP/delete"
done < "$TMP/branches"

ndelete="$(wc -l < "$TMP/delete" | tr -d ' ')"
echo "  消す候補 ${ndelete} 本、マージ済みの PR があるが残す ${kept} 本（全ブランチ $(wc -l < "$TMP/branches" | tr -d ' ') 本）"
while IFS="$(printf '\t')" read -r name match; do
  echo "  消す  ${name}（PR $match にマージ済み）"
  run gh api -X DELETE "repos/$REPO/git/refs/heads/$name"
done < "$TMP/delete"

# ---------------------------------------------------------------------------
# 2. delete_branch_on_merge
# ---------------------------------------------------------------------------
echo
echo "== 2. delete_branch_on_merge を true にする"
current="$(get "repos/$REPO" --jq .delete_branch_on_merge)"
if [ "$current" = "true" ]; then
  echo "  すでに true。何もしない"
else
  echo "  いまは $current"
  run gh api -X PATCH "repos/$REPO" -F delete_branch_on_merge=true --silent
fi

# ---------------------------------------------------------------------------
# 3. main の ruleset
# ---------------------------------------------------------------------------
echo
echo "== 3. ${DEFAULT_BRANCH} に ruleset「${RULESET_NAME}」を作る"
# 形は https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset に合わせた。
#   - required_approving_review_count は 0（作者のほかに承認する人がいないため）
#   - strict_required_status_checks_policy は false（積んだ PR が多く、毎回 main を取り込ませないため）
#   - bypass_actors は空。本人も main へ直接 push できなくなる
cat > "$TMP/ruleset.json" <<JSON
{
  "name": "${RULESET_NAME}",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/${DEFAULT_BRANCH}"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "${REQUIRED_CHECK}", "integration_id": ${ACTIONS_APP_ID} }
        ]
      }
    }
  ]
}
JSON

existing="$(get "repos/$REPO/rulesets" --jq ".[] | select(.name == \"${RULESET_NAME}\") | .id")"
if [ -n "$existing" ]; then
  echo "  同じ名前の ruleset がある（id ${existing}）。作らない。中身は gh api repos/$REPO/rulesets/$existing で見る"
else
  echo "  送る JSON:"
  sed 's/^/    /' "$TMP/ruleset.json"
  run gh api -X POST "repos/$REPO/rulesets" --input "$TMP/ruleset.json" --silent
fi

echo
if [ "$APPLY" -eq 1 ]; then
  echo "== 終わり"
else
  echo "== dry-run なので何も変えていない。変えるときは scripts/repo-settings.sh --apply"
fi
