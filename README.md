# Fix Storage GUI

Mac のストレージを圧迫している重いファイル・フォルダを見つけて、安全に「ゴミ箱へ移動」するための GUI アプリです（Tauri v2）。**macOS 専用**です（Apple Silicon / Intel 両対応の universal ビルド）。Windows・Linux には対応していません。
AI 判定は **Sign in with ChatGPT** を使い、あなたの ChatGPT プランの使用量で動きます（API キー不要）。

> **派生元:** このアプリは [govijr/fix-storage](https://github.com/govijr/fix-storage)（MIT License, Copyright (c) 2026 the fix-storage authors）をもとにしています。
> 元はターミナル用の CLI（TypeScript + Ink）で、このリポジトリはそのコアロジックを GUI 向けに再利用・移植したものです。
> 元の著作権表示は [LICENSE](./LICENSE) に残しています。fix-storage 本家とは無関係の非公式プロジェクトです。

## できること

1. **スキャン対象を選ぶ**: 「Mac 全体（元 CLI と同じフォルダ群）」か、任意のフォルダ。
2. **重いもの一覧**: サイズ順に、最終使用日（Spotlight の `kMDItemLastUsedDate`）、更新日、元 CLI のカテゴリと判定を表示。フォルダは「中を見る」で掘り下げられます。
3. **AI 判定**: 「削除していい / 注意 / 消しちゃダメ」と理由を日本語で表示。
4. **ゴミ箱へ移動**: 選んだものを最終確認ダイアログのあとでゴミ箱へ移動します。**完全削除はしません**（Finder の「戻す」で戻せます）。

## 安全のための仕組み

判定の優先順位は **ハードブロック ＞ 元 CLI のルール ＞ AI** です。AI が「削除していい」と言っても、次のものは選択できません。

- 元 CLI の保護フォルダ（`/`、ホーム、`~/Library`、`~/Library/Keychains`、`Preferences`、`Mail`、`Messages` など）と、元 CLI が「システム/ツール管理」と判定したもの（Homebrew、Docker など）
- このアプリで追加したハードブロック: `/System`・`/private`・`/usr` などのシステム領域、キーチェーン、`~/.ssh`・`~/.gnupg`・`~/.aws`・`~/.kube`・`~/.config/gh` などの認証情報、`id_rsa*`・`*.pem`・`*.key`・`*.p12`・`.env` などの鍵や秘密情報らしいファイル、`.git` とその中身、`.git` を含むリポジトリのフォルダ、ホームフォルダと `/Applications` の外側
- AI が「消しちゃダメ」と判定したもの

さらに、元 CLI で写真・ムービー・ミュージックなど個人データのカテゴリに入るものや「使用中のデータ」と判定されたものは、AI が「削除していい」と言っても「注意」に下げます。
ゴミ箱へ移す直前に、Rust 側でもう一度ハードブロックを確認します。

## プライバシー

- スキャン・サイズ計測・日付取得・ゴミ箱移動は、すべてこの Mac の中だけで行います。
- AI に送るのは **メタデータだけ** です: パス、名前、拡張子、ファイル/フォルダの別、サイズ、最終使用日、更新日、元 CLI のカテゴリ・判定・理由。**ファイルの中身は送りません。**
- 送る前に「この情報を OpenAI に送ります」というダイアログで、実際に送る JSON をそのまま確認できます。
- ホームフォルダ（`/Users/あなた` → `~`）とユーザー名（→ `<user>`）を隠すオプションがあり、初期状態でオンです。
- AI 判定のプロバイダは差し替えられる作りです（`src/ai/provider.ts` の `JudgeProvider`）。将来ローカルモデル（MLX / llama.cpp など）を追加できるようにしてあります（今はまだありません）。

## Sign in with ChatGPT について

AI 判定には OpenAI の [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) の「ChatGPT プランの使用量を使う」機能を使っています。公式ドキュメントに書かれている条件は次のとおりです。

- **対象アプリ**: オープンソースのアプリと、ローカルで動く個人プロジェクト（ほかに一部の非公開アプリ）。有料アプリやリモートでホストするアプリで提供したい場合は、OpenAI の申し込みフォーム（ウェイトリスト）が必要です。このアプリはオープンソースで、ローカルで動きます。
- **対象ユーザー**: 公式 Cookbook では「対象となる ChatGPT Plus と Pro のユーザー」と説明されています。利用するかどうかはユーザーがブラウザの同意画面で選べます。許可しなかった場合、AI 判定は使えません（元 CLI のルール判定は使えます）。
- **使用量**: ChatGPT の設定 → 使用量（アプリ内の「使用量を管理」ボタン）で確認・アプリごとの上限設定ができます。ドキュメントによると、Plus の 5 時間ごとの使用上限はこのアプリを含むすべてのアプリで共有され、アプリごとに別枠はありません（Pro には 5 時間上限は適用されません）。
- **プレビュー**: 現在はプレビューで、`store: false` と `stream: true` が必須、画像生成やファイル検索などのツールは使えない、といった制限があります（[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)）。仕様は変わる可能性があります。
- ChatGPT の会話履歴やメモリにはアクセスしません。

### 実装の要点（公式ドキュメントに沿って実装）

- ホストごとの `ext_agent_host_id`（`urn:uuid:` 形式）を最初のサインイン前に作り、アプリのデータフォルダに保存して使い回します。
- 初回は `client_id=dynamic_agent_client` で動的登録し、コールバックで返る発行済み `client_id` を保存。2 回目以降はその `client_id` と `id_token_hint` / `login_hint` で再認可します。
- PKCE（S256）・`state`・`nonce` を毎回生成。コールバックは `http://127.0.0.1:1455/auth/callback`（使用中なら空いているポート、パスは固定）。
- ID トークンは OpenAI の JWKS で署名を検証し、`iss`・`aud`（発行済み client_id）・`exp`・`nonce` を確認。付与スコープに `chatgpt.tokens.use.direct` があるかで、プランの利用可否を判断します。
- トークンは **macOS のキーチェーン** に保存します（Web ビュー側には渡しません）。アカウントの非秘密情報（client_id、メールなど）だけをアプリのデータフォルダに `0600` で保存します。
- 期限が近づいたらリフレッシュ（同時実行しないよう直列化）。サインアウト時は refresh token を失効（revocation）させてからローカルのトークンを消します。
- モデルは `GET /v1/models` で取得して選択（`visibility: "list"` のみ、サーバーの順番のまま）。**モデル名はハードコードしていません。**
- 推論は `POST /v1/responses` に `store: false`・`stream: true` で送り、`response.completed` を受け取ったときだけ成功とします。
- 「ChatGPT プランを使用中」表示と「使用量を管理」ボタン、初回のみの案内ダイアログ、使用量上限（`subscription_sharing_usage_limit_exceeded`）時のダイアログ、同意拒否・プラン未許可・失効（再サインイン）などのエラー処理があります。

公式 DevKit（[openai/sign-in-with-chatgpt-devkit](https://github.com/openai/sign-in-with-chatgpt-devkit)）は **非商用ライセンス（SIGN-IN WITH CHATGPT DEVKIT NONCOMMERCIAL LICENSE）** で、このリポジトリの MIT ライセンスと条件が合わないため、コードやブランド素材は使っていません。ドキュメントを読んで独自に実装しました（「使用量を管理」の URL `https://chatgpt.com/settings/usage` は DevKit に書かれている値を参照しています）。ボタンには OpenAI のロゴを使わず、テキストだけで「Continue with ChatGPT」と表示しています。

## 構成とアーキテクチャ判断

```
src/                 React + TypeScript（Vite）の日本語 UI
  cli-core/          fix-storage の classify.ts / categories.ts をほぼそのまま同梱（Node API だけ shim に置き換え）
  ai/                AI 判定（プロバイダのインターフェース、送信内容の組み立て、応答の解析）
  safety/merge.ts    ハードブロック ＞ 元 CLI ＞ AI の合成ルール
src-tauri/src/
  scan.rs            du / lstat / mdls による計測（fix-storage の scan.ts・browse.ts を移植）
  roots.rs           スキャン対象フォルダとカテゴリ（fix-storage の roots() を移植）
  safety.rs          ハードブロック（fix-storage の保護ルール＋追加ルール）
  trash.rs           ゴミ箱へ移動（/usr/bin/trash、なければ Finder 経由。fix-storage と同じ方法）
  siwc/              Sign in with ChatGPT（OAuth、キーチェーン、モデル一覧、Responses ストリーミング）
```

**Node の sidecar ではなく Rust への移植を選びました。** 理由:

- 元のコアは、計測は `du`・`mdls`・`trash` など macOS のコマンドを呼ぶだけで、残りはパスの規則（カテゴリ・判定・保護リスト）なので、Rust に移しても量が少なく、挙動を同じにしやすい。
- sidecar にすると Node ランタイムをアプリに同梱する必要があり、universal ビルドでは 2 アーキテクチャ分になって大きくなります。署名・公証の対象も増えます。
- トークンの保持、ゴミ箱移動前の最終チェックといった安全に関わる処理を、1 つの小さなネイティブバイナリにまとめられる。
- 一方、元 CLI の判定ロジック（`classify.ts` と `categories.ts`）は副作用のない純粋な関数なので、フロントエンドでそのまま再利用しています。最終的な安全判定は Rust 側のハードブロックが担います。

## Mac で試す

1. [Releases](https://github.com/konaito/fix-storage-gui/releases) の最新版から `fix-storage-gui_<バージョン>_universal.dmg` をダウンロードします（main の最新ビルドは [Actions の Build macOS](https://github.com/konaito/fix-storage-gui/actions/workflows/build-macos.yml) の artifact `fix-storage-gui-macos-universal-dmg` にもあります。こちらは GitHub へのログインが必要です）。
2. `.dmg` を開き、`Fix Storage GUI.app` を「アプリケーション」へドラッグします。
3. 未署名・未公証版の場合は、下の「未署名・未公証アプリの開き方」で開きます。
4. 「Mac 全体」をスキャンします。読めないフォルダがある場合は、システム設定 → プライバシーとセキュリティ → フルディスクアクセス でこのアプリを許可すると計測できます。
5. AI 判定を使うなら「Continue with ChatGPT」でサインインし、モデルを選んで「AI で判定」を押します。

### 未署名・未公証アプリの開き方

Apple の Developer ID 署名と公証をしていない版（ad-hoc 署名のみ）は、最初は macOS にブロックされます。次のどちらかで開いてください。

- 一度開こうとしてブロックされたあと、システム設定 → プライバシーとセキュリティ の下の方にある「このまま開く」を押す（古い macOS では Finder で右クリック →「開く」でも開けます）。
- またはターミナルで: `xattr -dr com.apple.quarantine "/Applications/Fix Storage GUI.app"`

## 開発

```bash
npm ci
npm run typecheck && npm test      # フロントエンドの型チェックとテスト
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev                  # macOS で起動
npx tauri build --target universal-apple-darwin --bundles app,dmg
```

GitHub Actions（どちらも macos-latest）:
- `Build macOS`: main への push ごとにテストと universal の `.app` / `.dmg` ビルドを行い、artifact として保存します（ad-hoc 署名・未公証）。
- `Release`: `v*` タグの push で GitHub Release を作り、universal の `.dmg` を添付します（[tauri-apps/tauri-action](https://github.com/tauri-apps/tauri-action) を使用）。下の Secrets が設定されていれば Developer ID で署名して公証し、なければ ad-hoc 署名（未公証）でビルドします。

### リリースの出し方

`src-tauri/tauri.conf.json`・`src-tauri/Cargo.toml`・`package.json` の `version` を上げてコミットし、同じ番号のタグを push します（タグとバージョンが違うと Release ワークフローは止まります）。

```bash
git tag v0.1.1
git push origin v0.1.1
```

## 公証の有効化手順

[Tauri 公式の macOS 署名ドキュメント](https://v2.tauri.app/distribute/sign/macos/) に沿った手順です。Mac が必要です。

### 1. Apple Developer Program に登録する

署名と公証には有料の Apple Developer アカウント（年 99 ドル）が必要です。無料プランでは公証できません。

### 2. Developer ID Application 証明書を作り、.p12 に書き出す

1. Mac で証明書署名要求（CSR）ファイルを作ります（Apple の「Create a certificate signing request」の手順）。
2. Apple Developer の Certificates, IDs & Profiles で「Create a certificate」を押し、**Developer ID Application** を選んで CSR をアップロードします。Developer ID Application 証明書を作れるのはアカウントの Account Holder だけです。
3. できた証明書をダウンロードし、`.cer` を開いてキーチェーンに入れます（キーチェーンアクセスの「デフォルトキーチェーン」で「ログイン」が選ばれていることを確認）。
4. キーチェーンアクセスの「ログイン」→「自分の証明書」で証明書を展開し、鍵の項目を右クリック →「書き出す」で `.p12` を保存します。このときパスワードを決めます。
5. `.p12` を base64 にします:

   ```bash
   openssl base64 -A -in /path/to/certificate.p12 -out certificate-base64.txt
   ```

### 3. App Store Connect API キーを発行する

1. App Store Connect の Users and Access ページで Integrations タブを開き、Add を押して、名前を付けて **Developer** アクセスを選びます。
2. キー一覧の上に表示される **Issuer ID** と、一覧の **キー ID** を控えます。
3. 秘密鍵（`AuthKey_<キーID>.p8`）をダウンロードします。ダウンロードできるのは 1 回だけで、ボタンはページを再読み込みしたあとに表示されます。

### 4. GitHub Secrets を登録する（konaito の Mac で）

```bash
REPO=konaito/fix-storage-gui
gh secret set APPLE_CERTIFICATE -R $REPO < certificate-base64.txt
gh secret set APPLE_CERTIFICATE_PASSWORD -R $REPO          # .p12 のパスワードを入力
gh secret set KEYCHAIN_PASSWORD -R $REPO --body "$(openssl rand -base64 24)"
gh secret set APPLE_API_ISSUER -R $REPO --body "<Issuer ID>"
gh secret set APPLE_API_KEY -R $REPO --body "<キー ID>"
gh secret set APPLE_API_PRIVATE_KEY -R $REPO < AuthKey_<キーID>.p8
```

| Secret | 入れるもの |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 証明書の `.p12` を base64 にした文字列 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` を書き出したときに決めたパスワード |
| `KEYCHAIN_PASSWORD` | CI 上で一時的に作るキーチェーンのパスワード（任意の文字列） |
| `APPLE_API_ISSUER` | App Store Connect API の Issuer ID |
| `APPLE_API_KEY` | App Store Connect API のキー ID |
| `APPLE_API_PRIVATE_KEY` | ダウンロードした `AuthKey_<キーID>.p8` の中身 |

`APPLE_CERTIFICATE`・`APPLE_CERTIFICATE_PASSWORD`・`KEYCHAIN_PASSWORD`・`APPLE_API_ISSUER`・`APPLE_API_KEY` は Tauri 公式と同じ名前です。Tauri 公式の `APPLE_API_KEY_PATH` は「秘密鍵ファイルのパス」なので、このリポジトリでは鍵の中身を `APPLE_API_PRIVATE_KEY` という Secret で渡し、ワークフローがファイルに書き出して `APPLE_API_KEY_PATH` に設定します。署名に使う `APPLE_SIGNING_IDENTITY` は、取り込んだ証明書からワークフローが自動で設定します。

### 5. タグを切る

Secrets を登録したあと、上の「リリースの出し方」のとおりにタグを push すると、署名・公証済みの `.dmg` が Release に添付されます。証明書の 3 つだけが揃っていて API キーがない場合は、署名のみ（未公証）になります。

## ライセンス

MIT。fix-storage（Copyright (c) 2026 the fix-storage authors）の著作権表示を [LICENSE](./LICENSE) に含めています。
ChatGPT と OpenAI は OpenAI の商標です。このアプリは OpenAI とは関係ありません。
