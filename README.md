# KRSK SYSTEM

バドミントン練習会の **自律進行マッチ管理システム**。「運営が毎回カードを書く」のではなく、
空いているコートと待っている選手をシステムが突き合わせて次の1試合を決め、
結果入力と同時に次の匹配をやり直す、という流れを成立させるためのアプリです。

- 起動: `npm install && npm run dev` → http://localhost:5173（API は 3001、Vite が `/api` をプロキシ）
- 本番: `npm run build && npm start`（`dist` を API が一緒に配信します）
- 確認用アカウント: `owner@krsk.local` / `admin@krsk.local` / `viewer@krsk.local`、パスワード `krsk-demo`
  選手は `p01@demo.local` … `p20@demo.local`（パスワード `demo`）。一覧は `GET /api/demo/accounts`
- デモ大会（20名・2クラス・4コート）が初回起動時に自動投入され、そのまま全操作できます

## 画面

| 画面 | 路径 | 内容 |
| --- | --- | --- |
| 運営ダッシュボード | `/events/:eventId` | ALERT → COURT LIVE → MATCH QUEUE → PARTICIPANT STATUS の4ブロック。リーグ生成プレビュー、エンジン手動実行と説明、結果入力、手動上書き、設定、操作ログ、対戦希望、お知らせ配信、大会レポート |
| 選手スマホ | `/m` | PC画面の縮約ではなく「次の1試合」を主役にした別設計。つぎの試合 / 対戦希望 / 本日 / 連絡 のタブ、結果入力の共有 |
| 大会レポート | ダッシュボード内タブ | 印刷前提の1枚もの。SVG不要・CSV同梱（下記） |

## マッチングエンジン（心臓部）

```
MatchScore = RequestPriority + WaitingScore + MatchCountBalance + UnplayedBonus
           + RatingCompatibility + RemainingTimeFit
           − RecentMatchPenalty − RepeatPenalty
```

- 硬式条件（同一選手の二重予約、コートの占有、終了時刻の保護、休憩時間、クラス/性別条件）を先に通過したものだけを採点します
- 8つの重みは大会ごとに設定可能（ダッシュボード → 設定、または `PATCH /api/events/:id`）
- 待機時間は 45分 で頭打ち、試合数バランスと未対戦ボーナスで「出ていない選手」を引き上げます
- `source = AUTO / MANUAL` を全カードに記録し、手動上書きは自動生成の比率集計から除外されます
- 終了時刻保護: `default_match_minutes + result_input_grace_minutes + safety_margin_minutes` に収まらないカードは作成も割当もしません

## 大会レポート（Phase 6）

`GET /api/events/:eventId/report` が保存済みの行だけを集計して返します（推定値は混ぜません）。

| 区分 | 内容 |
| --- | --- |
| participants | 登録 / 活性 / チェックイン / クラス数 |
| matchCount | 総試合数・平均・最少・最多・散布度・0試の選手・試合数ヒストグラム |
| waiting | 平均・最長・90%分位・30分超の選手数・計測区間数、**レポート時点での待機時間**（直近の試合終了から終了時刻（または現在）まで） |
| courts | コート別試合数・稼働分・稼働率（稼働分 / 使用可能分） |
| requests | 総件数・成立・取消・失効・充足率 |
| fairness | 試合数の標準偏差、バランススコア（0〜1にクランプ）、最多/最少出場 |
| automation | 自動採番と手動作成の内訳、自動比率 |
| noShows | 件数・影響を受けた選手数・比率 |
| integrity | 後述の整合性チェック結果を常時同梱 |
| rows / standings | 選手別1行（試合・勝負・得点・待機・希望・欠場）とクラス別上位10名 |

- `GET /api/events/:eventId/report.csv` — BOM付き・CRLF。表計算ソフトでそのまま開けます（OWNER / ADMIN / VIEWERのみ）
- 待機時間は「前の試合が終わってから、**実際に始まった**次の試合まで」。これから始まる予定試合までの時間は含みません（そちらはライブ画面側の数字です）

## データ整合性チェック

同じ規則を3箇所（QAエンドポイント・レポート・ストレステスト）が共有しています。

```
GET  /api/events/:eventId/integrity     # OWNER / ADMIN
npm run integrity                       # CLI。CRITICAL があれば exit code 1
npm run integrity -- --event evt_demo_krsk --json
```

検査項目（14）: 選手の二重予約 / コートの二重予約 / 同一カードの重複 / 存在しないレコードへの参照 /
スコアが不正な完了試合 / 勝者とスコアの不一致 / 試合のない結果記録 / 結果がないまま完了 /
終了が開始より古い / 不正な対戦希望 / 希望が別カードと接続 / コート状態の食い違い /
勝者がカードに不在 / 未終了カードにスコア。

加えて DB 側に UNIQUE 制約（同一大会内の同名選手、開いているカードの pair_key）と
CHECK 制約（スコア範囲・同点不可・状態遷移の語彙）を置き、アプリ側の検証をすり抜けた
幽霊データそのものを起こりにくくしています。

## パフォーマンス（実測・100名/8コート相当）

| 項目 | Before | After |
| --- | --- | --- |
| ダッシュボード1回の polling | 6リクエスト / 42ms | 1リクエスト / 18〜36ms |
| engine状態 | 候補採点込み 25ms | (light) 4〜8ms（採点はモーダル起動時のみ） |
| 転送量（スナップショット） | 175 kB | gzip 18.7 kB（約89%減） |
| 選手一覧の読み込み 400名/270試合 | 45.3ms | 12.4ms（相関サブクエリ → 集計1回） |

- `GET /api/events/:eventId/snapshot` が event / courts / matches / allMatches / participants / requests / engine を1回で返します（`Cache-Control: no-store`）
- スナップショットの engine は light 版（`evaluatedPairs = null`）。候補スコアはエンジン確認ダイアログが必要ときだけ計算します
- `server/gzip.ts` は `node:zlib` のみを使う自作ミドルウェア（依存追加なし・小さなレスポンスは圧縮しない）

## テスト

```
npm test     # 11ファイル / 74 tests（API・UI・ストレステスト）
npm run check
npm run build
```

- サーバー側: event / participant / match・result / request / league / matching / stress / report / snapshot
- ストレッサーは 10・20・40・60・100名で大会を最後まで進行させ、**各時点で整合性チェックが 0 件**であることを検証します
- フロント: jsdom 上で実コンポーネントを描画（運用ボード・選手スマホ・大会レポート）し、live API との形状ずれを検出します

## 構成

```
server/
  db.ts            schema + 整合性トリガ + 設定デフォルト（node:sqlite）
  app.ts / http.ts / auth.ts / gzip.ts / seed.ts
  routes/          core · matches · requests · engine · announcements · participant · report · snapshot
  services/        matching · league · ranking · autoEngine · integrity · report · engineState
src/
  pages/           DashboardPage · participant/ParticipantHome · 認証
  components/      dashboard/（12個） participant/（5個） ui.tsx
  api/ client.ts + types.ts（API の camelCase ミラー）
  state/ useEventSnapshot（polling 1回 = リクエスト1本）· useNow
tests/             helpers.ts とサーバー側スイート
scripts/           reset-demo.mjs（デモDBのリセット）
```

## 已知の割り切り

- 大会モード C（LEAGUE → **TOURNAMENT** → REQUEST）は、フェーズ管理と手動カード作成まで。自動トーナメント表の生成は未実装です（仕様の低優先項目）
- 選手自身の結果入力は即座に COMPLETED になります（ENTERED → 確認 の2段運用はしていません）
- 体育館掲示用（大型スクリーン専用ビュー）はありません。印刷用レポートとCSVで代替します
