import { useCallback, useEffect, useState } from 'react';
import { Download, Printer, ShieldCheck, RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import type { EventReport, IntegrityReport } from '../../api/types';
import { clockTime } from '../../lib/time';
import { Chip, Empty } from '../ui';

/** Mirrors VIOLATION_LABELS on the server (src and server cannot share modules here). */
const pct = (value: number) => `${Math.round(value * 100)}%`;
const minutes = (value: number) => (value >= 60 ? `${Math.floor(value / 60)}時間${Math.round(value % 60)}分` : `${Math.round(value)}分`);
const VIOLATION_LABEL: Record<string, string> = {
  PARTICIPANT_DOUBLE_BOOKED: '選手の二重予約',
  COURT_DOUBLE_BOOKED: 'コートの二重予約',
  DUPLICATE_OPEN_PAIR: '同一カードの重複',
  ORPHAN_REFERENCE: '存在しない参照',
  INVALID_COMPLETED_SCORE: '不正なスコア',
  RESULT_MISMATCH: '勝者とスコアの不一致',
  ORPHAN_RESULT: '結果だけの記録',
  COMPLETED_WITHOUT_RESULT: '結果なしで完了',
  END_BEFORE_START: '終了が開始より前',
  INVALID_REQUEST: '不正な対戦希望',
  REQUEST_MATCHED_TO_NON_MATCH: '希望が別カードと接続',
  COURT_STATE_STALE: 'コート状態の食い違い',
  WINNER_NOT_IN_MATCH: '勝者がカードに不在',
  SCORE_ON_OPEN_MATCH: '未終了カードのスコア',
  BRACKET_SLOT_DUPLICATE: 'トーナメント枠の重複',
  BRACKET_ADVANCE_MISSED: 'トーナメントの次カード未作成',
  BRACKET_FINAL_UNCLOSED: '決勝終了後も開いたドロー',
  BRACKET_SEED_UNKNOWN: 'ドローの勝者が参加者一覧に無い',
  RESULT_UNCONFIRMED: '結果が確定されないまま経過',
  RESULT_DISPUTED: '選手の申告不一致',
};

/**
 * Event report (spec sections 42-44): match counts, waiting time, court utilisation,
 * request fulfilment and fairness on one printable sheet. Every figure is recomputed
 * from stored rows, so the numbers handed to the gym are the ones the system recorded.
 */
export function ReportPanel({ eventId }: { eventId: string }) {
  const [report, setReport] = useState<EventReport | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<'played' | 'waiting' | 'name'>('played');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.report(eventId);
      setReport(data);
      setIntegrity(data.integrity);
    } catch {
      setError('レポートを生成できませんでした。');
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { void load(); }, [load]);

  const runIntegrity = useCallback(async () => {
    setChecking(true);
    try {
      setIntegrity(await api.integrity(eventId));
    } finally {
      setChecking(false);
    }
  }, [eventId]);

  if (loading) return <section className="panel"><div className="panel-body"><Empty>レポートを生成中…</Empty></div></section>;
  if (!report) return <section className="panel"><div className="panel-body"><Empty>{error}</Empty></div></section>;

  const rows = [...report.rows].sort((left, right) => {
    if (sort === 'name') return left.name.localeCompare(right.name, 'ja');
    if (sort === 'waiting') return right.totalWaitingMinutes - left.totalWaitingMinutes || left.name.localeCompare(right.name, 'ja');
    return right.played - left.played || left.name.localeCompare(right.name, 'ja');
  });
  const maxBucket = Math.max(1, ...report.matchCount.histogram.map((entry) => entry.players));

  return (
    <section className="panel report-panel">
      <header className="panel-head">
        <h2>EVENT REPORT</h2>
        <Chip tone="blue">{report.participants.checkedIn}/{report.participants.registered}名 IN</Chip>
        <Chip>{report.matches.completed}試合 完了</Chip>
        <span className="spacer" />
        <span className="hint report-time">生成 {clockTime(report.generatedAt)}</span>
        <button className="btn sm subtle" onClick={() => void load()}><RefreshCw size={12} />再生成</button>
        <a className="btn sm subtle" href={api.reportCsvUrl(report.eventId)}><Download size={12} />CSV</a>
        <button className="btn primary sm" onClick={() => window.print()}><Printer size={12} />印刷</button>
      </header>

      <div className="panel-body report-body">
        <div className="report-title">
          <h3>{report.eventName}</h3>
          <span>{report.eventDate}{report.venue ? ` / ${report.venue}` : ''} ・ {report.eventMode} / {report.phase} / {report.status}</span>
        </div>

        <div className="report-kpis">
          <Kpi label="参加者" value={String(report.participants.registered)} note={`チェックイン ${report.participants.checkedIn}名 / ${report.participants.classes}クラス`} />
          <Kpi label="実施試合数" value={String(report.matches.completed)} note={`総作成 ${report.matches.total} / 取消 ${report.matches.cancelled}`} />
          <Kpi label="1人平均試合数" value={report.matchCount.avg.toFixed(2)} note={`最少 ${report.matchCount.min} 〜 最多 ${report.matchCount.max}（差 ${report.matchCount.spread}）`} tone={report.matchCount.spread >= 4 ? 'warn' : 'ok'} />
          <Kpi label="平均待機" value={minutes(report.waiting.avgMinutes)} note={`最長 ${minutes(report.waiting.maxMinutes)} / いま待機中 ${report.waiting.idlePlayers}名`} tone={report.waiting.maxMinutes >= 30 ? 'warn' : 'ok'} />
          <Kpi label="コート稼働率" value={pct(report.courts.utilization)} note={`稼働 ${minutes(report.courts.busyMinutes)} / 使用可能 ${minutes(report.courts.availableMinutes)}`} />
          <Kpi label="希望充足率" value={pct(report.requests.fulfillmentRate)} note={`${report.requests.matched}/${report.requests.total}件が成立`} tone={report.requests.total > 0 && report.requests.fulfillmentRate < 0.6 ? 'warn' : 'ok'} />
          <Kpi label="ノーショー" value={String(report.noShows.count)} note={`影響 ${report.noShows.affectedPlayers}名 / 比率 ${pct(report.noShows.rate)}`} tone={report.noShows.count > 0 ? 'warn' : 'ok'} />
          <Kpi label="自動採番" value={pct(report.automation.autoShare)} note={`自動 ${report.automation.createdAuto} / 手動 ${report.automation.createdManual}`} />
          <Kpi label="結果の確定率" value={pct(report.confirmations.confirmRate)}
            note={`確定待ち ${report.confirmations.entered + report.confirmations.disputed} / 不一致 ${report.confirmations.disputed}`}
            tone={report.confirmations.disputed > 0 ? 'warn' : report.confirmations.confirmRate >= 0.95 ? 'ok' : 'plain'} />
        </div>

        <div className="report-cols">
          <div className="report-block">
            <h4>試合数の分布</h4>
            {report.matchCount.histogram.map((entry) => (
              <div key={entry.matches} className="report-bar-row">
                <span className="report-bar-label">{entry.matches}試合</span>
                <div className="report-bar-track"><div className="report-bar-fill" style={{ width: `${(entry.players / maxBucket) * 100}%` }} /></div>
                <span className="report-bar-value">{entry.players}名</span>
              </div>
            ))}
            {report.matchCount.zeroMatchPlayers > 0
              ? <p className="report-warn">{report.matchCount.zeroMatchPlayers}名がまだ試合を完了していません（最多 {report.matchCount.max}試 / 平均 {report.matchCount.avg.toFixed(1)}試）。</p>
              : <p className="report-ok">全選手が少なくとも1試合を消化しています。</p>}
          </div>

          <div className="report-block">
            <h4>待機時間</h4>
            <dl className="report-dl">
              <div><dt>平均</dt><dd>{minutes(report.waiting.avgMinutes)}</dd></div>
              <div><dt>最長</dt><dd className={report.waiting.maxMinutes >= 30 ? 'danger' : ''}>{minutes(report.waiting.maxMinutes)}</dd></div>
              <div><dt>90%分位</dt><dd>{minutes(report.waiting.p90Minutes)}</dd></div>
              <div><dt>30分以上待った選手</dt><dd className={report.waiting.over30Players > 0 ? 'danger' : ''}>{report.waiting.over30Players}名</dd></div>
              <div><dt>いま待っている時間</dt><dd className={report.waiting.idleOver30Players > 0 ? 'danger' : ''}>{minutes(report.waiting.longestIdleMinutes)}・{report.waiting.idlePlayers}名</dd></div>
              <div><dt>計測した待機区間</dt><dd>{report.waiting.samples}区間</dd></div>
            </dl>
          </div>

          <div className="report-block">
            <h4>コート別稼働</h4>
            {report.courts.perCourt.map((court) => (
              <div key={court.courtId} className="report-bar-row">
                <span className="report-bar-label">{court.courtName}</span>
                <div className="report-bar-track"><div className="report-bar-fill" style={{ width: `${Math.min(100, court.utilization * 100)}%` }} /></div>
                <span className="report-bar-value">{pct(court.utilization)}・{court.matches}試</span>
              </div>
            ))}
            <p className="muted report-note">稼働率 = コートが埋まっていた時間 / 使用可能時間</p>
          </div>

          <div className="report-block">
            <h4>結果の確定</h4>
            <dl className="report-dl">
              <div><dt>確定済み</dt>
                <dd className={report.confirmations.pendingMatches > 0 ? 'danger' : ''}>
                  {report.confirmations.confirmed + report.confirmations.corrected}/{report.confirmations.total}件</dd></div>
              <div><dt>選手の申告</dt><dd>{report.confirmations.byPlayers}件（うち自動確定 {report.confirmations.autoConfirmed}件）</dd></div>
              <div><dt>相手の確定待ち</dt><dd className={report.confirmations.entered > 0 ? 'danger' : ''}>{report.confirmations.entered}件</dd></div>
              <div><dt>申告の不一致</dt><dd className={report.confirmations.disputed > 0 ? 'danger' : ''}>{report.confirmations.disputed}件</dd></div>
              <div><dt>運営の上書き</dt><dd>{report.confirmations.corrected}件</dd></div>
              <div><dt>申告から確定まで</dt><dd>{report.confirmations.avgConfirmMinutes === null ? '—' : `${report.confirmations.avgConfirmMinutes}分`}</dd></div>
            </dl>
            <p className="muted report-note">
              選手同士の相互確認（または運営の確定）を終えた結果だけを順位とドローに反映します。
              {report.confirmations.pendingMatches > 0
                ? ` 現在 ${report.confirmations.pendingMatches}枚が結果未入力で、コートの稼働中も続いています。`
                : ' 結果未入力のカードはありません。'}
            </p>
          </div>

          {report.tournament.brackets > 0 ? (
            <div className="report-block">
              <h4>トーナメント</h4>
              <dl className="report-dl">
                <div><dt>ドロー</dt><dd>{report.tournament.brackets}組（進行中 {report.tournament.open}・完了 {report.tournament.completed}）</dd></div>
                <div><dt>作成カード</dt><dd>{report.tournament.cards}枚</dd></div>
                <div><dt>結果入力済み</dt><dd className={report.tournament.decided < report.tournament.cards ? 'danger' : ''}>
                  {report.tournament.decided}/{report.tournament.cards}枚</dd></div>
                <div><dt>不戦勝</dt><dd>{report.tournament.walkovers}名</dd></div>
              </dl>
              {report.tournament.byClass.map((entry) => (
                <div key={entry.classId} className="report-bar-row">
                  <span className="report-bar-label">{entry.className}</span>
                  <div className="report-bar-track">
                    <div className="report-bar-fill" style={{ width: entry.status === 'COMPLETED' ? '100%' : '35%' }} />
                  </div>
                  <span className="report-bar-value">
                    {entry.size}ドロー・{entry.rounds}回戦 ・ {entry.status === 'COMPLETED' ? `優勝 ${entry.winner ?? '—'}` : '進行中'}
                  </span>
                </div>
              ))}
              {report.tournament.champion
                ? <p className="report-ok">総合優勝：{report.tournament.champion.name}{report.tournament.champion.className ? `（${report.tournament.champion.className}）` : ''}</p>
                : <p className="muted report-note">決勝が終了していないクラスは「進行中」で集計されています。</p>}
            </div>
          ) : null}

          <div className="report-block">
            <h4>公平性・自動化</h4>
            <dl className="report-dl">
              <div><dt>試合数の標準偏差</dt><dd className={report.fairness.playedStdDev > 1.2 ? 'danger' : ''}>{report.fairness.playedStdDev.toFixed(2)}</dd></div>
              <div><dt>バランススコア</dt><dd>{pct(report.fairness.balanceScore)}</dd></div>
              <div><dt>最多出場</dt><dd>{report.fairness.mostPlayed ?? '-'}</dd></div>
              <div><dt>最少出場</dt><dd>{report.fairness.leastPlayed ?? '-'}</dd></div>
              <div><dt>エンジン自動採番</dt><dd>{report.automation.autoEngine ? 'ON' : 'OFF'}{report.automation.autoCourt ? ' / 自動コート割当 ON' : ''}</dd></div>
              <div><dt>フェーズ内訳</dt><dd>{Object.entries(report.matches.byPhase).map(([phase, total]) => `${phase} ${total}`).join(' / ') || '-'}</dd></div>
            </dl>
          </div>
        </div>

        <div className="report-block">
          <h4>選手別記録 <span className="muted">（{rows.length}名）</span></h4>
          <div className="report-tabs">
            {([['played', '試合数順'], ['waiting', '待機が長い順'], ['name', '名順']] as const).map(([key, label]) => (
              <button type="button" key={key} className={`chip${sort === key ? ' blue' : ''}`} onClick={() => setSort(key)}>{label}</button>
            ))}
          </div>
          <div className="report-table-wrap">
            <table className="grid-table report-table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>選手</th>
                  <th style={{ width: 74 }}>クラス</th>
                  <th style={{ width: 44 }}>試合</th>
                  <th style={{ width: 58 }}>勝-負</th>
                  <th style={{ width: 50 }}>勝率</th>
                  <th style={{ width: 58 }}>得失点</th>
                  <th style={{ width: 62 }}>総待機</th>
                  <th style={{ width: 56 }}>最長</th>
                  <th style={{ width: 56 }}>希望</th>
                  <th style={{ width: 40 }}>欠場</th>
                  <th>所属</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.participantId} className={row.played === 0 ? 'report-row-cold' : undefined}>
                    <td>{row.name}{!row.checkedIn ? <span className="muted"> 未IF</span> : null}</td>
                    <td className="muted">{row.className ?? '-'}</td>
                    <td className="num"><b>{row.played}</b></td>
                    <td className="num">{row.wins}-{row.losses}</td>
                    <td className="num">{row.played > 0 ? pct(row.winRate) : '-'}</td>
                    <td className="num">{row.pointDifference > 0 ? `+${row.pointDifference}` : row.pointDifference}</td>
                    <td className={`num${row.totalWaitingMinutes >= 30 ? ' danger' : ''}`}>{Math.round(row.totalWaitingMinutes)}分</td>
                    <td className="num">{Math.round(row.longestWaitingMinutes)}分</td>
                    <td className="num">{row.requestFulfilled}/{row.requestCount}</td>
                    <td className="num">{row.noShows > 0 ? <span className="danger">{row.noShows}</span> : '-'}</td>
                    <td className="muted">{row.club || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="report-cols">
          {report.standings.map((table) => (
            <div className="report-block" key={table.className ?? 'all'}>
              <h4>成績上位 {table.className ? `・ ${table.className}` : ''}</h4>
              {table.rows.length === 0 ? <p className="muted report-note">記録がありません。</p> : (
                <table className="grid-table report-table">
                  <thead><tr><th style={{ width: 34 }}>位</th><th>選手</th><th style={{ width: 44 }}>試合</th><th style={{ width: 44 }}>勝</th><th style={{ width: 58 }}>得失点</th></tr></thead>
                  <tbody>
                    {table.rows.map((entry) => (
                      <tr key={`${table.className}-${entry.rank}-${entry.name}`}>
                        <td className="num">{entry.rank}</td>
                        <td>{entry.name}</td>
                        <td className="num">{entry.played}</td>
                        <td className="num">{entry.wins}</td>
                        <td className="num">{entry.pointDifference > 0 ? `+${entry.pointDifference}` : entry.pointDifference}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>

        <div className="report-block report-qa">
          <header className="report-qa-head">
            <h4>データ整合性チェック</h4>
            {integrity ? (integrity.clean
              ? <Chip tone="ok"><ShieldCheck size={12} />{integrity.checks}項目すべて合格</Chip>
              : <Chip tone="urgent"><ShieldCheck size={12} />{integrity.violations.reduce((total, item) => total + item.count, 0)}件の不整合</Chip>) : null}
            <button onClick={() => void runIntegrity()} disabled={checking}><ShieldCheck size={12} />{checking ? '検査中…' : integrity ? '再検査' : '検査を実行'}</button>
          </header>
          <p className="muted report-note">
            二重予約・重複カード・結果のない完了・孤立した結果など、大会記録としてあってはならない状態を{integrity?.checks ?? report.integrity.checks}項目で検査します。
            {integrity ? ` 最終検査 ${clockTime(integrity.checkedAt)}。` : ''}
          </p>
          {integrity && integrity.violations.length > 0 && (
            <ul className="report-qa-list">
              {integrity.violations.map((violation) => (
                <li key={violation.code}>
                  <Chip tone={violation.severity === 'CRITICAL' ? 'urgent' : 'warn'}>{violation.severity}</Chip>
                  <b>{VIOLATION_LABEL[violation.code] ?? violation.code}</b>
                  <span className="muted">{violation.count}件</span>
                  {violation.sample ? <code>{violation.sample}</code> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Kpi({ label, value, note, tone = 'plain' }: { label: string; value: string; note?: string; tone?: 'plain' | 'ok' | 'warn' }) {
  return (
    <div className={`report-kpi${tone === 'warn' ? ' is-warn' : ''}${tone === 'ok' ? ' is-ok' : ''}`}>
      <span className="report-kpi-label">{label}</span>
      <span className="report-kpi-value">{value}</span>
      {note ? <span className="report-kpi-note">{note}</span> : null}
    </div>
  );
}
