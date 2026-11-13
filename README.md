# Pi Subagents

リポジトリ内の Markdown で定義した子エージェントに、Pi の親セッションから作業を委任する extension です。親は子を待つか、バックグラウンドで実行するかを選べます。子との相談や実行中の追加指示にも対応します。

## 必要な環境

- Pi 1.5 系以降の 1.x を対象とし、Pi 1.5.0 で動作を検証しています。Pi の Git インストール時には、このバージョン条件は自動検証されません。
- Pi で利用するモデルを設定し、必要なプロバイダー認証を済ませてください。Pi の `/login` と `/model` から確認できます。
- エージェント定義は作業対象の Git リポジトリに置きます。Pi のプロジェクト信頼設定が有効な場合に起動できます。
- 開発と CI は `.nvmrc` で指定した Node.js 26.13.0 LTS を使用します。Node.js 22.19 以降の 22 系、または 24.11 以降に対応します。

## インストール

GitHub にリポジトリが公開された後は、次のように Pi にインストールできます。

```sh
pi install git:github.com/tesso57/subagents
```

クローン済みの場合は、まずそのディレクトリで依存関係をインストールし、ローカルから Pi に登録できます。

```sh
cd /path/to/subagents
npm ci
pi install /path/to/subagents
```

`npm ci` の後、設定を変更せずに試す場合は、作業対象リポジトリへ移動して `-e` を指定します。

```sh
cd /path/to/project
pi -e /path/to/subagents
```

## エージェントを定義する

作業対象の Git リポジトリに `.pi/agents/reviewer.md` を作成します。

```markdown
---
name: reviewer
description: コードをレビューする
---
問題点を調査し、根拠とともに親へ報告してください。
```

`name` はファイル名と一致させます。`model` には `provider/model` または一意のモデル ID、`tools` には YAML の配列またはカンマ区切りでツール名を指定できます。本文は子への追加システム指示です。子は親の会話履歴を引き継がず、親がコンテキストファイルの読み込みを無効にしていなければ、親が読み込んだ `AGENTS.md` などの内容を子にも渡します。親のシステムプロンプトと追加指示も引き継ぎます。

親の `before_agent_start` で変更された context file の一覧も、親が実際に受け取った内容と照合して引き継ぎます。worktree 内の実ファイルは対応する内容を照合してパスを変換し、`synthetic://` のような非 file URI は表示用の名前としてそのまま渡します。

同じ hook で変更された、モデルに見せる skill の一覧も引き継ぎます。これは Pi に登録された `/skill:` コマンドの一覧とは別で、runtime の一覧に追加しただけではコマンドは増えません。worktree では対象 skill のパスと内容を照合します。起動時の静的な skill 可視性を取得できない場合（`resources_discover` で後から追加された skill など）は、その静的な可視性の一致は検証できません。モデルに渡す runtime の可視性は別途検証します。

親の extension が実行時にシステムプロンプト全体を置き換え、子向けに安全に分離できないと検出した場合は、子の起動を拒否します。ただし、この extension より後に動く `context_with_system` handler が system message を追加・削除・差し替えた場合などは検出できず、子へ引き継がれない場合があります。

子については、各モデル要求の前に引き継いだ指示を検査し、子側の extension によって欠落・変更された場合は要求を中止します。プロバイダー固有の送信データを後から変更する handler までは検査できません。

親の `before_agent_start` で追加された独自の system prompt セクションは、そのまま子へ渡します。本文中のパスは変換しないため、worktree を使う場合も親リポジトリを指す絶対パスはそのままです。`tools` や `cwd` など Pi の組み込みセクションの上書きは、安全に引き継げないため子の起動を拒否します。

`tools` は親で有効なツールの範囲内に指定します。未指定時も親の有効ツールを引き継ぎます。子には、親への相談に使う `contact_parent` が追加されます。

## skill 内のエージェント定義

`subagent_start` の `agent` には、従来の名前に加えて、作業対象リポジトリ内の Markdown ファイルのパスを指定できます。たとえば、skill とその担当者を次のようにまとめられます。

```text
.pi/skills/factory/
├── SKILL.md
└── agents/
    ├── plan.md
    ├── implementer.md
    └── review.md
```

各ファイルは `.pi/agents` と同じ frontmatter を使い、`name` をファイル名と一致させます。`SKILL.md` には、例えば次のように書きます。

```markdown
---
name: factory
description: 計画担当に作業を依頼する
---
subagent_start を使い、この SKILL.md と同じディレクトリにある
agents/plan.md の絶対パスを agent に指定してください。
mode は wait、workspace は shared にしてください。
依頼の目的と必要な文脈を task に含めてください。
```

パスはリポジトリルートからの相対パス（例：`.pi/skills/factory/agents/plan.md`）またはリポジトリ内の絶対パスです。名前だけの `plan` は従来どおり `.pi/agents/plan.md` を読みます。同じ名前の定義が複数あっても自動選択せず、パスで指定したファイルを読みます。リポジトリ外を通過するシンボリックリンクは使えません。プロジェクトの信頼設定も従来どおり必要です。

`shared` は指定時のファイルを読み、`worktree` は指定した定義がコミット済みの基点と一致することを確認し、作成した worktree 内の対応ファイルを再確認します。定義ファイル以外の任意の参照先まで同一と保証するものではありません。子に親の会話履歴は渡らないため、必要な情報は task に含めてください。現在はリポジトリ外に置いた skill の agent 定義を直接指定できません。

## 使い方

Pi で、例えば「`reviewer` を使って変更をレビューして」と依頼します。親は `subagent_start` を使い、`mode` に `background` または `wait`、`workspace` に `shared` または `worktree` を指定します。skill やプロンプトから同じ指示を与えることもできます。

例えば、`.pi/skills/review-changes/SKILL.md` に次の skill を置くと、`/skill:review-changes` から `reviewer` に依頼できます。

```markdown
---
name: review-changes
description: reviewer エージェントに変更のレビューを依頼する
---
subagent_start を使い、agent に reviewer、mode に wait、workspace に shared を指定してください。
ユーザーが指定した対象をレビューするよう依頼し、子から質問があれば対応してください。
子が完了したら、結果を確認してユーザーに報告してください。
```

`pi install` で登録済みの場合は、エージェント定義と skill を置いた作業対象リポジトリへ移動し、Pi を起動します。一時利用の場合は、前述の `pi -e /path/to/subagents` で起動してください。

```sh
cd /path/to/project
pi
```

Pi の入力欄で `/skill:review-changes 現在の変更をレビュー` と入力します。Pi の起動後に skill を追加・編集した場合は、先に `/reload` を実行してください。skill は親への指示であり、子を起動するのは親が呼び出す `subagent_start` です。

| ツール | 用途 |
|---|---|
| `subagent_start` | 子の起動 |
| `subagent_wait` | 子の完了や親への相談を待つ |
| `subagent_status` | 子の状態や worktree を確認 |
| `subagent_steer` | 実行中・待機中の子へ追加指示 |
| `subagent_reply` | 子の相談に返答 |
| `subagent_result` | 長い結果を分割して取得 |
| `subagent_stop` | 子の停止を要求 |

`subagent_result` の `offset` / `next` は UTF-16 の位置です。返された `next` をそのまま次の取得に使ってください。サロゲートペアの途中で分割しないため、`limit: 1` でもペアはまとめて返します。

子が相談や完了を報告すると、親セッションに通知します。停止要求から後片付け完了までは `stopping` と表示し、未消化の追加指示は終了イベントに記録します。指示の受付が終了処理と競合した場合は、配信を確認できない旨を返します。作成済みの worktree の場所とブランチは子の終了結果に含まれます。worktree 内の変更は自動でマージ・削除しません。`shared` で同じファイルを並列編集すると変更が競合する可能性があります。

子が失敗または停止した場合に返る結果は、最後に確認できた途中出力です。完了した回答とは限りません。

Git の worktree 作成コマンドが失敗しても、作成前は未登録で、失敗後に場所・ブランチ・基点が一致する登録を確認できた場合、終了結果には `creation: "unverified"` が付きます。登録は確認できますが、今回の操作で作成されたかは確定できないため、内容を確認してください。作成中にプロセスが強制終了すると、Git の共通ディレクトリに同じ ID の `.claim` ファイルが残る場合があります。

## 設定

リポジトリの `.pi/subagents.json` で同時実行数を設定します。既定値は 4 です。

```json
{
  "maxConcurrent": 4
}
```

worktree 起動時は、リポジトリ内の Pi 設定・エージェント定義・skill・コンテキストファイルに未コミット変更があると起動を拒否します。自動発見される skill のシンボリックリンクが、worktree 外を参照する場合や親側と異なる内容を読む場合も起動を拒否します。プロジェクト設定で読み込む extension と、その import / require を解析できる範囲で比較します。参照先を静的に特定できない動的 import / require を検出した場合は worktree 起動を拒否します。Pi が extension を読み込んでからスナップショットを取るまでの変更、外部パッケージの推移的な依存、実行時の任意のファイル読み取りは、同一性を保証できません。worktree はセキュリティ上のサンドボックスではなく、子は権限の範囲内で親側のファイルやネットワークにもアクセスできます。その他の未コミット変更は worktree の基点に含まれず、起動結果に警告を返します。

MCP を使う場合、親の起動後に `mcp.json` や `settings.json` の extension 設定が変更されると、子の起動を拒否します。親の Pi を `/reload` してから再度実行してください。ただし、設定内の環境変数やコマンドの展開結果、MCP サーバーの実行ファイルや依存関係は比較していません。特に worktree の子は、親の作業ツリーとは異なる内容のサーバーを起動する可能性があります。

## 開発

```sh
npm ci
npm run typecheck
npm test
npm run check:package
```

テストは Pi SDK とモックモデルを使います。実サービスのモデルや、すべての OS・extension の組み合わせを検証するものではありません。CLI の `-e` / `--extension` で指定された extension は子にも読み込みますが、SDK ホストが動的に追加したツールを持たない extension や、親で動的に登録されたすべての状態が引き継がれる保証はありません。親プロセスが `SIGKILL` で強制終了された場合、子が実行中だった bash コマンドは残ることがあります。macOS で再現を確認しています。

Pi の `-e builtin:llama.cpp` は現在子に読み込めないため、子の作成前に起動を拒否します。

子の起動中に停止した場合、すでに実行中の extension の初期化は強制中断できません。初期化が戻った後に起動を中止し、`session_start` 前に中止した場合は `session_shutdown` も呼ばれません。

子の終了時、先行する extension の終了処理が長時間戻らない場合は、Pi 組み込み MCP の接続終了を別途試みます。実行中のツールが停止要求を無視して戻らない場合は、この終了処理にも到達できません。第三者 extension の処理や、それが起動したプロセスの強制終了を保証するものではありません。

## ライセンス

[MIT](LICENSE)
