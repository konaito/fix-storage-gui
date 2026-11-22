# Fix Storage GUI

Mac のストレージを圧迫している重いファイル・フォルダを見つけて、安全に「ゴミ箱へ移動」するための GUI アプリです（Tauri v2 / macOS 向け）。
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

1. [Actions](../../actions/workflows/build-macos.yml) の最新の成功した実行から、artifact **`fix-storage-gui-macos-universal-dmg`** をダウンロードして解凍します（GitHub へのログインが必要です）。
2. `.dmg` を開き、`Fix Storage GUI.app` を「アプリケーション」へドラッグします。
3. **未署名・未公証のアプリ** なので、最初は macOS にブロックされます。次のどちらかで開いてください。
   - 一度開こうとしてブロックされたあと、システム設定 → プライバシーとセキュリティ の下の方にある「このまま開く」を押す（古い macOS では Finder で右クリック →「開く」でも開けます）。
   - またはターミナルで: `xattr -dr com.apple.quarantine "/Applications/Fix Storage GUI.app"`
4. 「Mac 全体」をスキャンします。読めないフォルダがある場合は、システム設定 → プライバシーとセキュリティ → フルディスクアクセス でこのアプリを許可すると計測できます。
5. AI 判定を使うなら「Continue with ChatGPT」でサインインし、モデルを選んで「AI で判定」を押します。

## 開発

```bash
npm ci
npm run typecheck && npm test      # フロントエンドの型チェックとテスト
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev                  # macOS で起動
npx tauri build --target universal-apple-darwin --bundles app,dmg
```

GitHub Actions:
- `CI`（ubuntu）: 型チェック、Vitest、`cargo check`、`cargo test`
- `Build macOS`（macos-latest）: universal の `.app` / `.dmg` をビルドし、artifact として保存（署名・公証なし）

## ライセンス

MIT。fix-storage（Copyright (c) 2026 the fix-storage authors）の著作権表示を [LICENSE](./LICENSE) に含めています。
ChatGPT と OpenAI は OpenAI の商標です。このアプリは OpenAI とは関係ありません。
