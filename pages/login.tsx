import { FormEvent, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { LockKeyhole, UserRound, ArrowLeft, Mic } from 'lucide-react';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (username === 'user' && password === 'user123') {
      localStorage.setItem('voicehome_auth', 'true');
      window.location.href = '../dashboard/';
      return;
    }
    setError('Invalid username or password.');
  }

  return (
    <>
      <Head>
        <title>Sign in · VoiceHome</title>
      </Head>
      <main className="auth-page">
        <div className="auth-art">
          <Link href="../" className="back-link">
            <ArrowLeft size={17} /> Back home
          </Link>
          <div className="auth-art-content">
            <span className="brand-mark large">V</span>
            <h1>
              Your home,
              <br />
              within your voice.
            </h1>
            <p>Securely access your smart lighting dashboard from anywhere.</p>
          </div>
        </div>
        <div className="auth-panel">
          <div className="auth-box">
            <div className="auth-icon">
              <Mic size={24} />
            </div>
            <span className="section-label">VoiceHome Control</span>
            <h2>Welcome back</h2>
            <p className="muted">Sign in to control your connected home.</p>
            <form onSubmit={submit}>
              <label>
                Username
                <div className="input-wrap">
                  <UserRound size={18} />
                  <input
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="Enter username"
                  />
                </div>
              </label>
              <label>
                Password
                <div className="input-wrap">
                  <LockKeyhole size={18} />
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter password"
                  />
                </div>
              </label>
              {error && <div className="error-box">{error}</div>}
              <button className="primary-btn full" type="submit">
                Sign in
              </button>
            </form>
            <div className="demo-box">
              <strong>Demo access</strong>
              <span>
                Username: <b>user</b>
              </span>
              <span>
                Password: <b>user123</b>
              </span>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
