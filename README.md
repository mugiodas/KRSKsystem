# KRSK SYSTEM

バドミントン練習会の **自律進行マッチ管理システム**。「運営が毎回カードを書く」のではなく、
空いているコートと待っている選手をシステムが突き合わせて次の1試合を決め、
結果入力と同時に次の匹配をやり直す、という流れを成立させるためのアプリです。

- 起動: `npm install && npm run dev` → http://localhost:5173（API は 3001、Vite が `/api` をプロキシ）
- 本番: `npm run build && npm start`（`dist` を API が一緒に配信します）
- 確認用アカウント: `owner@krsk.local` / `admin@krsk.local` / `viewer@krsk.local`、パスワード `krsk-demo`
  選手は `p01@demo.local` … `p20@demo.local`（パスワード `demo`）。一覧は `GET /api/demo/accounts`
- デモ大会が初回起動時に自動投入され、そのまま全操作できます
  - `KRSK SYSTEM DEMO EVENT` — モードA（20名・2クラス・4コート、リーグ戦進行中）
  - `KRSK SYSTEM DEMO トーナメント` — モードC（8名・1クラス・2コート、カード未作成。トーナメント表のプレビューから生成までを試せます）
  - 選手アカウント `t01@demo.local` … `t08@demo.local`（パスワード `demo`）はトーナメント側の大会に属します

## 画面

| 画面 | 経路 | 内容 |
| --- | --- | --- |
| 運営ダッシュボード | `/events/:eventId` | ALERT → COURT LIVE → MATCH QUEUE → PARTICIPANT STATUS の4ブロック。リーグ生成プレビュー（消化状況と未消化選手つき）、トーナメント表（モードC）、エンジン手動実行と説明、結果入力、選手の申告の上書き・確定、設定（会場スクリーンのURL発行・無効化を含む）、操作ログ、対戦希望、ワンクリック配信を含むお知らせ配信、大会レポート |
| 選手スマホ | `/m` | PC画面の縮約ではなく「次の1試合」を主役にした別設計。つぎの試合 / 対戦希望 / 本日 / 連絡 のタブ、結果申告と**相手からの申告の確定**（相互確認） |
| 大会レポート | ダッシュボード内タブ | 印刷前提の1枚もの。SVG不要・CSV同梱（下記） |
| 会場スクリーン | `/screen/:eventId?t=…` | 大型表示向け・読み取り専用。ログイン不要のトークンURL（下記） |

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

## トーナメント表（大会モード C: LEAGUE → TOURNAMENT → REQUEST）

`server/services/tournament.ts` が単敗淘汰のドローを組み、ダッシュボードの「トーナメント表」タブで
プレビュー → 確定 → 進行を操作します。

- 対象はチェックイン済み・active の参加者。人数から **2の冪のドローサイズ**を求め、不足枠は上位シードの不戦勝にします（不戦勝は試合行を作りません）
- シードは順位表（勝利数 → 得失点 → レート）から自動付与。標準的なブラケット配置を使うので、不戦勝は必ず上位シード側に落ちます
- Generate は「**両側の供給元が確定したカードだけ**」を実行テーブルに載せます。不戦勝が連鎖して決まる枠も見逃さないよう、カード作成は「供給元が2つ揃ったか」で駆動します
- カードは `phase = TOURNAMENT`・`source = AUTO`・`priority_score = 600 + (最終ラウンド - 何回目) × 10`。通常エンジンが既存キューと同じ列でコートを割当めますが、ドローが開いている間は新しい希望対戦カードを作りません（`skippedReasons.BRACKET_OPEN`）
- 結果入力と同じトランザクションで次ラウンドへ進めます。決勝が決まればドローを `COMPLETED`、大会フェーズを `REQUEST` に戻します
- 安全装置:
  - 終了時刻に収まる見込みがなければ `409 TOURNAMENT_WONT_FIT`（プレビューにも理由と所要見込を表示）
  - 同じクラスに進行中の表があれば `409 BRACKET_EXISTS`
  - ドローのカードは `CANCEL` / `NO_SHOW` 不可（`409 BRACKET_CARD_LOCKED`）。不戦勝扱いにしたい場合は 21-0 などの結果を入力します
  - 勝者が既に次のラウンドで呼出済みなら、その前の結果は書き換えられません（`409 BRACKET_ADVANCED`）
  - 削除は未消化カードだけを取り消します。プレイ中のカードがあれば `409 BRACKET_IN_PLAY` で拒否
- 整合性チェックはドロー用の4項目を追加。表が途切れたときは「進行を直す」（rebalance）で作成漏れのカードを復元します
- API: `GET /api/events/:eventId/tournament/preview`・`GET /api/events/:eventId/tournament`・
  `POST /api/events/:eventId/tournament/generate`・`POST /api/events/:eventId/tournament/:bracketId/rebalance`・
  `DELETE /api/events/:eventId/tournament/:bracketId`

## 結果の相互確認（ENTERED → CONFIRMED）

選手がスコアを入力しただけでは確定扱いにしません。もう一方の選手（または運営）が確認して
初めて順位・ドロー・レポートに反映されます。`server/services/results.ts` が状態機を担い、
`results.status` が単一の真実です。

```
ENTERED    どちらかが申告した。相手か運営の確定待ち（試合は RESULT_PENDING、コートは稼働中のまま）
DISPUTED   両者の申告が食い違った。運営だけが確定できる
CONFIRMED  一致・運営入力・期限切れ自動確定のいずれかで確定 → matches = COMPLETED
CORRECTED  確定後に運営が書き換えた（上書きと同時に確定）
```

- 一致判定はスコア2点のみ（同点なら別申告）。一致そのものが相互確認なので、運営の操作は不要です
- `POST /api/events/:eventId/matches/:matchId/result` は常に **201** を返し、`resultStatus` / `confirmed` /
  `bracketAdvance` を添えます。確定時のみ `completeMatch` が走り、コート解放・対戦希望の MATCHED・
  トーナメントの次カード作成が同じトランザクションで連動します
- 自分で自分の申告は確定できません（`409 SELF_CONFIRM`）。対戦相手以外も `403 FORBIDDEN`、
  確定済みの書き直し要求は `409 RESULT_ALREADY_CONFIRMED`、不一致の自己解決は `409 DISPUTE_REQUIRES_STAFF`
- `events.result_confirm_timeout_minutes`（既定3分、0で即時確定＝従来の運営単独運用）で自動確定までを管理。
  経過分はエンジン起動前と30秒周期のスイープで吸収し、`POST /api/events/:eventId/results/sweep` で手動実行もできます
- 大会終了後（終了時刻経過・終了/取消）は放置せず、申告不一致も先頭の申告で自動確定して記録を閉じます
- 並行入力は `matches.row_version` で守ります（後の1件は `409 VERSION_CONFLICT`）
- 運営側 UI: COURT LIVE のカードに「相手の確定待ち」「申告不一致」の表示と申告スコア、
  「確定」/「上書き・確定」ボタン。結果入力モーダルは選手申告と同一値なら送信即確定、
  違いがあれば不一致になった旨を明示。設定モーダルに自動確定の分数入力
- 選手側 UI: 次の1試合カードに相手の申告内容と「この内容で確定」「スコアが違う」（自分の申告を送信 → 運営確認へ）、
  不一致中は運営対応の案内のみ。入力シートは相手申告との一致/不一致でボタン文言が変わり、メモ（任意）を添えられます
- アラート: 申告があって未確定のまま期限を過ぎたカードは IMPORTANT / URGENT（不一致は URGENT）で「結果が確定されていません」。
  申告自体がゼロの RESULT_PENDING は従来どおり「結果未入力」

## リーグ消化の警告（計画 vs 実績）

リーグ戦は「組み終わってからが本番」なので、`server/services/league.ts` が *計画そのもの* を
保存せず毎回組み直して比較します（`league_type` / `league_match_count` でスライスした
ラウンドロビン＝Generate と同じ切り方。奇数クラスの不戦勝は特定選手に固まるため、
`min(試合数, 人数-1)` のような公式では正確な計画になりません）。

```
GET /api/events/:eventId/league/progress      # 集計は全員、未消化選手リストは OWNER / ADMIN / VIEWER のみ
```

- 消化対象は `phase = LEAGUE` のカードのみ。**キャンセルは計画に戻る**が、ノーショー（不戦勝）は
  両者に約束された1枚として計上します（没収試合も「もらえた試合」なので）
- 予定・呼び出し中・プレー中・結果待ちのカードは `scheduled` として計上するので、
  同じ不足に対してアラートが二重になりません
- `status`: `NOT_APPLICABLE`（モードB）/ `ON_TRACK` / `BEHIND` / `WONT_FIT`
  （`WONT_FIT` = 残りの回数を今のコート数・1回戦あたり分数で回すと終了時刻に届かない）
- 必要分数はクラス順に直列で積算（Generate の `globalRoundOffset` と同じ前提）
- `GET /api/events/:eventId` と snapshot に `league` 集計を同載（名前入りリストは載せず）、
  `GET /api/events/:eventId/participants` の各行に `leagueTarget / leaguePlayed / leagueScheduled / leagueShortfall`
- アラート（`LEAGUE_BEHIND`）: 大会 **RUNNING 中**のみ。BEHIND は IMPORTANT、WONT_FIT は URGENT。
  リーグ計画がないイベントだけ従来の「45分経過で未消化0試」ルールにフォールバックします
- 画面: リーグ戦プレビューの冒頭に消化バー（完了/計画・回戦・1回戦あたり分数）と未消化選手リスト、
  PARTICIPANT STATUS に「リーグ」列（`消化/計画 +予定`）と「消化不足」ソート、レポートに
  「リーグ消化」ブロック＋ CSV 2行（`リーグ消化` / `リーグ未消化`）と未消化選手の明細
- 整合性チェックには含めません（消化不足はデータ破損ではなく進行状況なので、WARNING 扱いの
  `RESULT_UNCONFIRMED` とは位置づけが違います）

## ワンクリック配信（終了時刻・結果待ちの告知）

大会の終盤に運営がいちばん多く打つ手は、コートの上へ声をかけることなので、`ANNOUNCEMENTS` パネルでは
文章を打たずに配信できる。本文は実行中のボードから作るため、**配信される数字が画面と食い違わない**。

| 告知 | 出る条件 | 本文に自動で入る数字 |
| --- | --- | --- |
| 終了時刻が迫っています | 終了時刻まで30分以内（`CLOSING_NOTICE_WINDOW_MINUTES`）で、まだコートを確保したカードがある | 残り分数（ボードと同じ時計） |
| 結果の入力をお願いします | 申告のない `RESULT_PENDING` のカードがある | 件数とコート名（3面まで、残りは「他N面」） |
| 結果の確定をお願いします | 相手確定待ち（`ENTERED`）のカードがある | 件数とコート名 |

- 各行に本文の全文と現在の件数が出ており、**「配信」ボタン1つで参加者へ届く**（書く欄はない）
- ALERT の該当カード（終了時刻保護 / 結果未入力 / 確定されない結果）には同じ配信のショートカットが付く。
  押すと本文まで埋まった状態でお知らせ画面が開くが、**配信は運営がボタンを押した時だけ**走る（誤クリックで全场に飛ばない）
- 残り30分を切っていてもエンジンが終了時刻保護に入ると「終了時刻保護のため…」ALERT が同じ配信を受け持つので、
  2つの条件の間に告知が出ない隙間はない
- 参加者にはスマホ画面「連絡」へ即座に反映（URGENT はタブにバッジ）。取り下げは「非表示」＝ `active = 0`（履歴は残る）
- サーバー側の制約は既存の `POST /api/events/:eventId/announcements` そのもの（タイトル80字・本文600字、OWNER / ADMIN のみ、監査ログあり）

## 会場スクリーン（`/screen/:eventId`）

体育館のプロジェクター向けの読み取り専用ボードです。操作要素・クリック・ログインを前提にせず、
10m 先から読めるサイズ（`clamp()` で 720p／1080p どちらでも自動調整）でコートごとに
**対戦者・スコア・経過・残り分数**を出します。

```
/screen/:eventId?t=<トークン>          # ブラウザで開くだけ（TV・ signage box どちらでも）
GET  /api/public/screen/:eventId?t=…   # 認証なし。トークンが一致したときだけ 200
GET  /api/events/:eventId/screen        # 運営プレビュー（token / path も返す）
POST /api/events/:eventId/screen/token   # OWNER / ADMIN。発行・作り直し（古いURLは即失効）
DELETE /api/events/:eventId/screen/token # 無効化（NULL にする＝リンクを踏んでも 403）
```

- **誰がいつ作り直したかは操作ログ**（`entity_type = SCREEN`）に残ります
- トークンは sha-256 を `timingSafeEqual` で比較。イベントID未知／トークン不一致は**同じ 403**を返し、
  イベントIDの存在確認に使われないようにしています。`DRAFT` の大会は 409 で拒否（開始前に名簿を出さない）
- 表示データは専用の射影（`server/services/screen.ts`）で、**参加者ID・所属・レーティング・連絡先・設定・
  整合性検査は含みません**（会場では名前とスコアだけが必要、という前提）。テストで JSON に
  `participantId` / `email` / `rating` / `token` が出ないことを検証しています
- 3秒ポーリング（`cache-control: no-store`）。通信が切れても**最後の表示を出し続け**、フッターに「最新化を再試行中」
- 結果は**確定したものだけ**を速報欄に出します（選手の申告中のスコアはコート面に「結果確認中」として出し、点数は伏せます）
- 右レール: まもなく（呼出順・ETA）／直近の結果／リーグ消化バー／クラス別順位（複数クラスは10秒ローテ）／
  トーナメント状況／お知らせ。`F` キーで全画面
- デモイベントは最初からリンクが発行済み: `/screen/evt_demo_krsk?t=krsk-demo-screen`、
  トーナメントデモは `/screen/evt_demo_tournament?t=krsk-demo-draw`

## 大会レポート（Phase 6）

`GET /api/events/:eventId/report` が保存済みの行だけを集計して返します（推定値は混ぜません）。

| 区分 | 内容 |
| --- | --- |
| participants | 登録 / 活性 / チェックイン / クラス数 |
| matchCount | 総試合数・平均・最少・最多・散布度・0試の選手・試合数ヒストグラム |
| league | リーグ計画（予定試数・消化・回戦・1人平均／最少／最多・未消化選手と不足試数・必要分数と残り分数） |
| waiting | 平均・最長・90%分位・30分超の選手数・計測区間数、**レポート時点での待機時間**（直近の試合終了から終了時刻（または現在）まで） |
| courts | コート別試合数・稼働分・稼働率（稼働分 / 使用可能分） |
| requests | 総件数・成立・取消・失効・充足率 |
| fairness | 試合数の標準偏差、バランススコア（0〜1にクランプ）、最多/最少出場 |
| automation | 自動採番と手動作成の内訳、自動比率 |
| noShows | 件数・影響を受けた選手数・比率 |
| confirmations | 確定済み / 選手の申告数 / 自動確定数 / 確定待ち・不一致 / 運営上書き / 申告から確定までの平均分 / 確定率 |
| tournament | ドロー数・作成/消化カード・不戦勝数・クラス別状況・総合優勝（モードC以外は 0 埋め） |
| integrity | 後述の整合性チェック結果を常時同梱 |
| rows / standings | 選手別1行（試合・勝負・得点・待機・希望・欠場）とクラス別上位10名 |

- `GET /api/events/:eventId/report.csv` — BOM付き・CRLF。表計算ソフトでそのまま開けます（OWNER / ADMIN / VIEWERのみ）。
  「結果の確定」「確定待ち」の2行を含みます
- 待機時間は「前の試合が終わってから、**実際に始まった**次の試合まで」。これから始まる予定試合までの時間は含みません（そちらはライブ画面側の数字です）

## データ整合性チェック

同じ規則を3箇所（QAエンドポイント・レポート・ストレステスト）が共有しています。

```
GET  /api/events/:eventId/integrity     # OWNER / ADMIN
npm run integrity                       # CLI。CRITICAL があれば exit code 1
npm run integrity -- --event evt_demo_krsk --json
```

検査項目（20）: 選手の二重予約 / コートの二重予約 / 同一カードの重複 / 存在しないレコードへの参照 /
スコアが不正な完了試合 / 勝者とスコアの不一致 / 試合のない結果記録 / 結果がないまま完了 /
終了が開始より古い / 不正な対戦希望 / 希望が別カードと接続 / コート状態の食い違い /
勝者がカードに不在 / 未終了カードにスコア / トーナメント枠の重複 / トーナメントの次カード未作成 /
決勝終了後も開いたドロー / ドローの勝者が参加者一覧に不在 /
結果が確定されないまま経過（WARNING） / 選手の申告不一致（WARNING）。

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
| 同上 + リーグ計画（97名/8クラス/40カード） | — | snapshot 10.0ms・league progress 3.6ms・report 6.9ms（計画は都度再計算だが保存しない分だけ軽い） |

- `GET /api/events/:eventId/snapshot` が event / courts / matches / allMatches / participants / requests / engine を1回で返します（`Cache-Control: no-store`）
- スナップショットの engine は light 版（`evaluatedPairs = null`）。候補スコアはエンジン確認ダイアログが必要ときだけ計算します
- `server/gzip.ts` は `node:zlib` のみを使う自作ミドルウェア（依存追加なし・小さなレスポンスは圧縮しない）

## テスト

```
npm test     # 13ファイル / 92 tests（API・UI・ストレステスト）
npm run check
npm run build
```

- サーバー側: event / participant / match・result / request / league / matching / tournament / stress / report / snapshot
- トーナメントは API レベルで全通過検証（生成プレビュー、ドライブ通し、勝者修正の追従、停止ガード、整合性）
- ストレッサーは 10・20・40・60・100名で大会を最後まで進行させ、**各時点で整合性チェックが 0 件**であることを検証します
- フロント: jsdom 上で実コンポーネントを描画（運用ボード・選手スマホ・大会レポート）し、live API との形状ずれを検出します

## 構成

```
server/
  db.ts            schema + 整合性トリガ + 設定デフォルト（node:sqlite）
  app.ts / http.ts / auth.ts / gzip.ts / seed.ts
  routes/          core · matches · requests · engine · announcements · participant · report · snapshot · tournament
  services/        matching · league · tournament · ranking · autoEngine · integrity · report · engineState
src/
  pages/           DashboardPage · participant/ParticipantHome · 認証
  components/      dashboard/（14個） participant/（5個） ui.tsx
  api/ client.ts + types.ts（API の camelCase ミラー）
  state/ useEventSnapshot（polling 1回 = リクエスト1本）· useNow
tests/             helpers.ts とサーバー側スイート
scripts/           reset-demo.mjs（デモDBのリセット）
```

## 既知の割り切り

- トーナメント表は単敗淘汰のみ（3位決定戦・ダブルス・クラス横断ドロー・シードの手動並べ替えは未対応）
- リーグ消化の必要分数は「クラスを順に・1回戦はコート数で均等割当」の概算です。エンジン実測の前後ずらし（休憩・希望・レーティング差）は読み込まないため、`WONT_FIT` は目安として見てください
- 選手のスマホにはリーグ計画を出していません（運営側の警告とレポートが主目的のため）
