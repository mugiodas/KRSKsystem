import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Smartphone } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useSession } from '../auth/session';

interface DemoAccount { role: string; email: string; password: string; label: string }

export function LoginPage() {
  const { signIn, session } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('owner@krsk.local');
  const [password, setPassword] = useState('krsk-demo');
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.demoAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    if (session) navigate(session.role === 'PARTICIPANT' ? '/m' : '/', { replace: true });
  }, [session, navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const value = await signIn(email.trim(), password);
      navigate(value.role === 'PARTICIPANT' ? '/m' : '/', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ログインに失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <header className="login-head">
          <h1>KRSK SYSTEM</h1>
          <p>バドミントン練習試合 運用システム</p>
        </header>
        <div className="login-body">
          {error ? <div className="notice error">{error}</div> : null}
          <div className="field">
            <label>メールアドレス</label>
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
          </div>
          <div className="field">
            <label>パスワード</label>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </div>
          <button className="btn primary block" type="submit" disabled={busy} style={{ height: 34 }}>
            {busy ? <Loader2 size={14} /> : null}ログイン
          </button>

          {accounts.length > 0 ? (
            <div className="demo-list">
              <div style={{ fontSize: 10.5, color: 'var(--ink-500)', letterSpacing: '0.04em' }}>デモ用アカウント（クリックで入力）</div>
              {accounts.map((account) => (
                <button
                  key={account.email} type="button" className="demo-row"
                  onClick={() => { setEmail(account.email); setPassword(account.password); }}
                >
                  <span className="chip blue">{account.role}</span>
                  <span className="who">{account.label}</span>
                  <span className="spacer" />
                  <span className="pw">{account.email} / {account.password}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ink-500)' }}>
            <Smartphone size={12} /> 参加者はスマートフォン画面から自分の次試合と対戦希望を確認できます。
          </div>
        </div>
      </form>
    </div>
  );
}
