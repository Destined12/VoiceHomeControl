import Head from 'next/head';
import Link from 'next/link';
import { Mic, Wifi, ShieldCheck, Zap, ArrowRight, Cpu } from 'lucide-react';

export default function Home() {
  return (
    <>
      <Head>
        <title>VoiceHome Control</title>
        <meta name="description" content="Remote voice control for ESP8266 smart home lighting." />
      </Head>
      <main className="landing">
        <nav className="nav shell">
          <div className="brand"><span className="brand-mark">V</span><span>VoiceHome</span></div>
          <Link className="nav-link" href="/login/">Sign in</Link>
        </nav>
        <section className="hero shell">
          <div className="hero-copy">
            <div className="eyebrow"><span className="status-dot" /> Smart home voice control</div>
            <h1>Control your home <span>with your voice.</span></h1>
            <p>Speak from your phone while you are away. VoiceHome turns your command into text, sends it to the backend for room and GPIO resolution, and prepares it for delivery to one ESP8266 controller.</p>
            <div className="hero-actions">
              <Link className="primary-btn" href="/login/">Open dashboard <ArrowRight size={18} /></Link>
              <a className="secondary-btn" href="#how">How it works</a>
            </div>
            <div className="trust-row"><span><ShieldCheck size={17} /> Command logging</span><span><Wifi size={17} /> ESP8266 ready</span><span><Zap size={17} /> Fast control</span></div>
          </div>
          <div className="hero-panel">
            <div className="phone-card">
              <div className="phone-top"><span>VoiceHome Controller</span><span className="live-pill">ESP8266</span></div>
              <div className="mic-orb"><Mic size={34} /></div>
              <div className="wave">{[1,2,3,4,5,6,7,8,9].map(i => <i key={i} />)}</div>
              <div className="sample-command">“Turn on the study room light”</div>
              <div className="route-chip"><Cpu size={14} /> Backend → D1 → Study Room</div>
            </div>
          </div>
        </section>
        <section id="how" className="how shell">
          <div><span className="section-label">01 / Voice</span><h2>Speak naturally.</h2><p>Use the microphone on your phone browser. VoiceHome captures the command and keeps the transcript in your command history.</p></div>
          <div><span className="section-label">02 / Backend</span><h2>Resolve the room.</h2><p>The backend maps a room or alias to the configured GPIO pin. Adding a new room does not require changing the ESP8266 firmware.</p></div>
          <div><span className="section-label">03 / IoT</span><h2>Switch the bulb.</h2><p>The backend delivers the command to the single ESP8266 controller, which executes the GPIO action and reports its heartbeat.</p></div>
        </section>
        <footer className="footer shell">VoiceHome Control · ESP8266 smart lighting platform</footer>
      </main>
    </>
  );
}
