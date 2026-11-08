# Pi Subagents

リポジトリ内の Markdown で定義した子エージェントに、Pi の親セッションから作業を委任する extension です。親は子を待つか、バックグラウンドで実行するかを選べます。子との相談や実行中の追加指示にも対応します。

## 必要な環境

- Pi 1.5.0 で動作を検証しています。
- エージェント定義は作業対象の Git リポジトリに置きます。
- 開発と CI は Node.js 26 LTS を使用します。最低要件は Node.js 22.19 です。

## インストール

GitHub にリポジトリが公開された後は、次のように Pi にインストールできます。

```sh
pi install git:github.com/tesso57/subagents
```

クローン済みの場合は、ローカルからインストールすることもできます。

```sh
pi install /path/to/subagents
```

設定を変更せずに試す場合：

```sh
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

`name` はファイル名と一致させます。`model` には `provider/model` または一意のモデル ID、`tools` には YAML の配列またはカンマ区切りでツール名を指定できます。本文は子への追加システム指示です。子は親の会話履歴を引き継がず、リポジトリの `AGENTS.md` も読み込みます。

`tools` は親で有効なツールの範囲内に指定します。未指定時も親の有効ツールを引き継ぎます。子には、親への相談に使う `contact_parent` が追加されます。

## 使い方

Pi で、例えば「`reviewer` を使って変更をレビューして」と依頼します。親は `subagent_start` を使い、`mode` に `background` または `wait`、`workspace` に `shared` または `worktree` を指定します。skill やプロンプトから同じ指示を与えることもできます。

| ツール | 用途 |
|---|---|
| `subagent_start` | 子の起動 |
| `subagent_wait` | 子の完了や親への相談を待つ |
| `subagent_status` | 子の状態や worktree を確認 |
| `subagent_steer` | 実行中・待機中の子へ追加指示 |
| `subagent_reply` | 子の相談に返答 |
| `subagent_result` | 長い結果を分割して取得 |
| `subagent_stop` | 子の停止を要求 |

子が相談や完了を報告すると、親セッションに通知します。worktree 内の変更は自動でマージ・削除しません。`shared` で同じファイルを並列編集すると変更が競合する可能性があります。

## 設定

リポジトリの `.pi/subagents.json` で同時実行数を設定します。既定値は 4 です。

```json
{
  "maxConcurrent": 4
}
```

worktree 起動時は、リポジトリ内の Pi 設定・エージェント定義・`AGENTS.md` に未コミット変更があると起動を拒否します。その他の未コミット変更は worktree の基点に含まれず、起動結果に警告を返します。

## 開発

```sh
npm ci
npm run typecheck
npm test
```

テストは Pi SDK とモックモデルを使います。実サービスのモデルや、すべての OS・extension の組み合わせを検証するものではありません。CLI の `-e` / `--extension` で指定された extension は子にも読み込みますが、SDK ホストが動的に追加したツールを持たない extension や、親で動的に登録されたすべての状態が引き継がれる保証はありません。親の強制終了時に子が別途起動した OS プロセスの扱いも未検証です。

## ライセンス

[MIT](LICENSE)
