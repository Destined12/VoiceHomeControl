import Head from 'next/head';
import { useEffect, useMemo, useRef, useState } from 'react';
import { startMicSession, type MicSessionController } from '../lib/voice-service';
import {
  Mic,
  MicOff,
  Lightbulb,
  Wifi,
  LogOut,
  Radio,
  Volume2,
  CheckCircle2,
  Clock3,
  Settings2,
  Plus,
  Cpu,
  Activity,
  X,
  Trash2,
  ChevronDown,
  XCircle,
} from 'lucide-react';

async function apiRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ data: T }> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}`);
  }
  if (response.status === 204) {
    return { data: undefined as T };
  }
  const text = await response.text();
  return { data: text ? (JSON.parse(text) as T) : (undefined as T) };
}

const api = {
  get<T = any>(path: string): Promise<{ data: T }> {
    return apiRequest<T>('GET', path);
  },
  post<T = any>(path: string, body?: unknown): Promise<{ data: T }> {
    return apiRequest<T>('POST', path, body);
  },
  delete<T = any>(path: string): Promise<{ data: T }> {
    return apiRequest<T>('DELETE', path);
  },
};

type Command = {
  id?: string;
  text: string;
  device: string;
  action: string;
  status: string;
  created_at: number;
  audio_received?: boolean;
};

type Device = {
  id: string;
  name: string;
  location: string;
  state: boolean;
  online: boolean;
  last_seen: number;
  pin?: string;
};

type Room = {
  id: string;
  name: string;
  deviceName: string;
  pin: string;
  aliases: string;
};

const starterRooms: Room[] = [
  { id: 'sitting-room-bulb', name: 'Sitting Room', deviceName: 'Sitting Room Bulb', pin: 'D2', aliases: 'sitting room, living room, parlour' },
  { id: 'sitting-room-socket', name: 'Sitting Room', deviceName: 'Sitting Room Socket', pin: 'D5', aliases: 'sitting room, living room, parlour' },
  { id: 'master-bedroom-bulb', name: 'Bedroom', deviceName: 'Master Bedroom Bulb', pin: 'D6', aliases: 'bedroom, master bedroom' },
  { id: 'master-bedroom-socket', name: 'Bedroom', deviceName: 'Master Bedroom Socket', pin: 'D7', aliases: 'bedroom, master bedroom' },
];

const starterDevices: Device[] = starterRooms.map(room => ({
  id: room.id,
  name: room.deviceName,
  location: room.name,
  state: false,
  online: true,
  last_seen: Date.now(),
  pin: room.pin,
}));

const gpioPins = ['D1', 'D2', 'D5', 'D6', 'D7'];

function statusLabel(status: string): string {
  switch (status) {
    case 'executed':
      return 'success';
    case 'pending':
    case 'claimed':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    default:
      return status;
  }
}

export default function Dashboard() {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [status, setStatus] = useState('Ready for a voice command');
  const [commands, setCommands] = useState<Command[]>([]);
  const [devices, setDevices] = useState<Device[]>(starterDevices);
  const [rooms, setRooms] = useState<Room[]>(starterRooms);
  const [activeView, setActiveView] = useState<'control' | 'spaces'>('control');
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [roomForm, setRoomForm] = useState({ name: '', deviceName: '', pin: 'D1', aliases: '' });
  const [systemOnline, setSystemOnline] = useState(true);
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);
  const ctrlRef = useRef<MicSessionController | null>(null);
  const busyRef = useRef(false);
  const activeCommandRef = useRef<{ id: string; action: string; device: string; pin?: string } | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refreshInFlightRef = useRef(false);

  const usedPins = useMemo(() => rooms.map(room => room.pin), [rooms]);
  const availablePins = gpioPins.filter(pin => !usedPins.includes(pin) || pin === roomForm.pin);

  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('voicehome_auth') !== 'true') {
      window.location.href = '../login/';
      return;
    }

    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    async function refresh() {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      try {
        const [commandsRes, devicesRes] = await Promise.all([
          api.get<{ commands?: Command[] }>('/api/commands'),
          api.get<{ devices?: Device[] }>('/api/devices'),
        ]);
        if (cancelled) return;
        const fetchedCommands = commandsRes.data.commands || [];
        setCommands(fetchedCommands);
        if (devicesRes.data.devices?.length) setDevices(devicesRes.data.devices);

        const tracked = activeCommandRef.current;
        if (tracked) {
          const trackedCommand = fetchedCommands.find(command => command.id === tracked.id);
          if (trackedCommand) {
            if (trackedCommand.status === 'executed') {
              setStatus(`${tracked.action} · ${tracked.device} — command successful`);
              activeCommandRef.current = null;
            } else if (trackedCommand.status === 'failed') {
              setStatus(`${tracked.action} · ${tracked.device} — command failed`);
              activeCommandRef.current = null;
            } else if (trackedCommand.status === 'expired') {
              setStatus(`${tracked.action} · ${tracked.device} — no controller response (timed out)`);
              activeCommandRef.current = null;
            } else if (trackedCommand.status === 'cancelled') {
              setStatus(`${tracked.action} · ${tracked.device} — command cancelled`);
              activeCommandRef.current = null;
            }
          }
        }

        setSystemOnline(true);
      } catch {
        if (!cancelled) setSystemOnline(false);
      } finally {
        refreshInFlightRef.current = false;
      }
    }

    refreshRef.current = refresh;
    refresh();

    const eventSource = new EventSource('/api/events/');
    eventSource.onopen = () => setSystemOnline(true);
    eventSource.onmessage = event => {
      let payload: { type?: string } = {};
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === 'CONNECTED' || payload.type === 'PING') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, 150);
    };
    eventSource.onerror = () => setSystemOnline(false);

    const fallbackTimer = setInterval(refresh, 30000);

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(fallbackTimer);
      eventSource.close();
      ctrlRef.current?.cancel();
    };
  }, []);

  const hasActiveCommands = commands.some(
    command => command.status === 'pending' || command.status === 'claimed' || command.status === 'queued'
  );

  useEffect(() => {
    if (!hasActiveCommands) return;
    const timer = setInterval(() => {
      void refreshRef.current();
    }, 5000);
    return () => clearInterval(timer);
  }, [hasActiveCommands]);

  function startVoice() {
    if (busyRef.current) return;
    busyRef.current = true;
    setTranscript('');
    setListening(true);
    setStatus('Connecting…');
    try {
      ctrlRef.current = startMicSession({
        onInterim: text => setTranscript(text),
        onFinal: text => {
          setTranscript(text);
          if (text) {
            setStatus('Command captured.');
            void saveCommand(text);
          } else {
            setStatus('Couldn’t hear a command — please try again.');
          }
          busyRef.current = false;
          setListening(false);
          ctrlRef.current = null;
        },
        onStatus: (voiceStatus, message) => {
          if (voiceStatus === 'connecting') {
            setStatus('Connecting…');
          } else if (voiceStatus === 'listening') {
            setListening(true);
            setStatus('Listening… speak your command');
          } else if (voiceStatus === 'finalizing') {
            setStatus('Finalizing transcription…');
          } else if (voiceStatus === 'cancelled') {
            setListening(false);
            setStatus(message || 'Recording cancelled.');
            busyRef.current = false;
            ctrlRef.current = null;
          } else if (voiceStatus === 'error') {
            setListening(false);
            setStatus(message || 'Voice recognition failed.');
            busyRef.current = false;
            ctrlRef.current = null;
          } else if (voiceStatus === 'stopped') {
            setListening(false);
            ctrlRef.current = null;
          }
        },
      });
    } catch {
      busyRef.current = false;
      setListening(false);
      setStatus('Could not start voice recognition.');
    }
  }

  function stopVoice() {
    ctrlRef.current?.stop();
  }

  function cancelVoice() {
    ctrlRef.current?.cancel();
  }

  async function saveCommand(text: string) {
    setStatus('Saving command…');
    try {
      const response = await api.post<{ id: string; status: string; device?: string | null; device_id?: string | null; action?: string; pin?: string | null }>('/api/commands', {
        text,
        audio_received: true,
      });
      const result = response.data;
      const entry: Command = {
        id: result.id,
        text,
        device: result.device ?? 'unknown',
        action: result.action ?? 'UNKNOWN',
        status: result.status,
        created_at: Date.now(),
        audio_received: true,
      };
      setCommands(prev => [entry, ...prev].slice(0, 25));
      if (result.device_id && result.action && result.action !== 'UNKNOWN') {
        activeCommandRef.current = {
          id: result.id,
          action: result.action,
          device: result.device ?? 'unknown',
          pin: result.pin ?? undefined,
        };
        setStatus(`Pending: ${result.action} · ${result.device} · ${result.pin} — device applies within 3s`);
      } else {
        activeCommandRef.current = null;
        setStatus('Could not identify a configured room or action.');
      }
    } catch {
      setStatus('Command captured, but the server could not save it.');
    }
  }

  async function clearLog() {
    if (!window.confirm('Reset all data? This deletes every command and resets rooms/devices to defaults.')) return;
    try {
      await api.post('/api/reset');
      setCommands([]);
      setDevices(starterDevices);
      setRooms(starterRooms);
      activeCommandRef.current = null;
      setStatus('All data reset to defaults.');
    } catch {
      setStatus('Could not reset the data.');
    }
  }

  async function cancelCommand(id?: string) {
    if (!id || cancellingIds.includes(id)) return;
    setCancellingIds(prev => [...prev, id]);
    setStatus('Cancelling command…');
    try {
      const response = await api.post<{ ok: boolean; status: string; error?: string }>(`/api/commands/${id}/cancel/`);
      const result = response.data;
      if (result?.status === 'cancelled') {
        setStatus('Command cancelled.');
      } else {
        setStatus(result?.error || `Command is ${result?.status ?? 'unchanged'} and could not be cancelled.`);
      }
    } catch {
      setStatus('Could not cancel the command.');
    } finally {
      setCancellingIds(prev => prev.filter(item => item !== id));
      void refreshRef.current();
    }
  }

  async function toggleDevice(device: Device) {
    const nextState = !device.state;
    const action = nextState ? 'ON' : 'OFF';
    try {
      const response = await api.post<{ ok: boolean; id?: string }>('/api/device-command', { device_id: device.id, action });
      if (response.data?.id) {
        activeCommandRef.current = { id: response.data.id, action, device: device.name, pin: device.pin };
      } else {
        activeCommandRef.current = null;
      }
      setStatus(`${device.name}: ${action} pending — waiting for controller…`);
    } catch {
      setStatus('Device command could not be delivered.');
    }
  }

  function addRoom(event: React.FormEvent) {
    event.preventDefault();
    if (!roomForm.name.trim() || !roomForm.deviceName.trim() || usedPins.includes(roomForm.pin)) return;

    const id = roomForm.deviceName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (rooms.some(room => room.id === id)) {
      setStatus('A device with this name already exists.');
      return;
    }

    const room: Room = {
      id,
      name: roomForm.name.trim(),
      deviceName: roomForm.deviceName.trim(),
      pin: roomForm.pin,
      aliases: roomForm.aliases.trim(),
    };
    setRooms(prev => [...prev, room]);
    setDevices(prev => [...prev, {
      id: room.id,
      name: room.deviceName,
      location: room.name,
      state: false,
      online: true,
      last_seen: Date.now(),
      pin: room.pin,
    }]);
    api.post('/api/devices', {
      id: room.id,
      name: room.deviceName,
      location: room.name,
      state: false,
      pin: room.pin,
      aliases: room.aliases,
    }).catch(() => {
      setStatus(`${room.name} added locally, but the backend could not save it.`);
    });
    setRoomForm({ name: '', deviceName: '', pin: availablePins[0] || 'D1', aliases: '' });
    setShowAddRoom(false);
    setActiveView('spaces');
    setStatus(`${room.name} added on ${room.pin}.`);
  }

  function logout() {
    localStorage.removeItem('voicehome_auth');
    window.location.href = '../login/';
  }

  return (
    <>
      <Head><title>Dashboard · VoiceHome</title></Head>
      <main className="dashboard">
        <aside className="sidebar">
          <div className="brand"><span className="brand-mark">V</span><span>VoiceHome</span></div>
          <div className="sidebar-nav">
            <button className={activeView === 'control' ? 'side-nav-item active' : 'side-nav-item'} onClick={() => setActiveView('control')}><Activity size={17} /> Control center</button>
            <button className={activeView === 'spaces' ? 'side-nav-item active' : 'side-nav-item'} onClick={() => setActiveView('spaces')}><Settings2 size={17} /> Spaces & GPIO</button>
          </div>
          <div className="side-copy">
            <span className="section-label">ONE CONTROLLER</span>
            <h2>Every room. One ESP8266.</h2>
            <p>Add rooms from the dashboard and map each one to a GPIO pin. Voice routing stays in the backend.</p>
          </div>
          <button className="logout-btn" onClick={logout}><LogOut size={17} /> Sign out</button>
        </aside>

        <section className="dash-main">
          <header className="dash-header">
            <div>
              <span className="section-label">VOICEHOME / DASHBOARD</span>
              <h1>{activeView === 'control' ? 'Home at your command.' : 'Configure your spaces.'}</h1>
              <p>{activeView === 'control' ? 'Speak a command or control a device manually.' : 'Map rooms to the GPIO pins on your single ESP8266 controller.'}</p>
            </div>
            <div className="system-status">
              <span className={systemOnline ? 'green-dot' : 'red-dot'} />
              {systemOnline ? 'System online' : 'Check connection'}
            </div>
          </header>

          {activeView === 'control' ? (
            <>
              <section className="controller-strip">
                <div className="controller-icon"><Cpu size={20} /></div>
                <div><strong>VoiceHome Controller</strong><span>VH-ESP8266-001 · ESP8266</span></div>
                <div className="controller-meta"><span><Wifi size={14} /> Wi-Fi connected</span><span><Activity size={14} /> Heartbeat active</span></div>
              </section>

              <section className="command-card">
                <div className="command-heading">
                  <div><span className="section-label">VOICE COMMAND</span><h2>What would you like to control?</h2></div>
                  <div className={listening ? 'listening-badge active' : 'listening-badge'}><Radio size={15} /> {listening ? 'Listening' : 'Ready'}</div>
                </div>
                <div className="voice-zone">
                  <button className={listening ? 'mic-button active' : 'mic-button'} onClick={listening ? stopVoice : startVoice} aria-label={listening ? 'Stop listening' : 'Start voice command'}>
                    {listening ? <MicOff size={36} /> : <Mic size={36} />}
                  </button>
                  {listening && (
                    <div style={{ marginTop: 12 }}>
                      <button className="outline-btn" onClick={cancelVoice} aria-label="Cancel recording"><X size={15} /> Cancel</button>
                    </div>
                  )}
                  <div className="voice-text">{transcript || 'Try “Turn on the sitting room bulb”'}</div>
                  <div className="wave large-wave">{[1,2,3,4,5,6,7,8,9,10,11].map(i => <i key={i} />)}</div>
                  <div className="status-line"><Volume2 size={15} /> {status}</div>
                </div>
              </section>

              <section className="device-section">
                <div className="section-head">
                  <div><span className="section-label">CONNECTED SPACES</span><h2>Your rooms</h2></div>
                  <button className="outline-btn" onClick={() => setActiveView('spaces')}><Settings2 size={15} /> Manage spaces</button>
                </div>
                <div className="device-grid">
                  {devices.map(device => (
                    <article className="device-card" key={device.id}>
                      <div className={device.state ? 'bulb-icon on' : 'bulb-icon'}><Lightbulb size={25} /></div>
                      <div className="device-info"><h3>{device.name}</h3><span>{device.location} · {device.pin || 'GPIO'} · {device.online ? 'Online' : 'Offline'}</span></div>
                      <button className={device.state ? 'switch on' : 'switch'} onClick={() => toggleDevice(device)} aria-label={`Turn ${device.name} ${device.state ? 'off' : 'on'}`}><span /></button>
                    </article>
                  ))}
                </div>
              </section>

              <section className="system-grid">
                <div className="mini-status"><span className="green-dot" /><div><strong>Web app</strong><span>Operational</span></div></div>
                <div className="mini-status"><span className="green-dot" /><div><strong>Backend API</strong><span>Operational</span></div></div>
                <div className="mini-status"><span className="green-dot" /><div><strong>Database</strong><span>Command storage ready</span></div></div>
                <div className="mini-status"><span className="green-dot" /><div><strong>ESP8266</strong><span>Heartbeat monitored</span></div></div>
              </section>

              <section className="history-section">
                <div className="section-head"><div><span className="section-label">VOICE LOG</span><h2>Recent commands</h2></div><button className="outline-btn" onClick={clearLog} disabled={commands.length === 0}><Trash2 size={15} /> Reset data</button></div>
                <div className="history-list">
                  {commands.length === 0 ? <div className="empty-history"><Clock3 size={20} /> Your voice commands will appear here.</div> : commands.map((command, i) => {
                    const cancellable = command.status === 'pending' || command.status === 'queued';
                    const busy = !!command.id && cancellingIds.includes(command.id);
                    return (
                      <div className="history-row" key={command.id || i}>
                        <div className="history-icon"><Mic size={16} /></div>
                        <div className="history-main"><strong>{command.text}</strong><span>{command.device} · {command.action} · {new Date(command.created_at).toLocaleString()}</span></div>
                        <span className="saved-pill"><CheckCircle2 size={14} /> {statusLabel(command.status)}</span>
                        {cancellable && (
                          <button className="cancel-btn" onClick={() => cancelCommand(command.id)} disabled={busy} aria-label="Cancel command">
                            <XCircle size={13} /> {busy ? 'Cancelling…' : 'Cancel'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          ) : (
            <section className="spaces-panel">
              <div className="controller-card">
                <div className="controller-icon"><Cpu size={20} /></div>
                <div className="controller-copy"><span className="section-label">CONTROLLER</span><h2>VoiceHome Controller</h2><p>VH-ESP8266-001 · One ESP8266 handles every configured room.</p></div>
                <div className="controller-online"><span className="green-dot" /> Online</div>
              </div>

              <div className="section-head spaces-head">
                <div><span className="section-label">ROOM MAPPING</span><h2>Spaces & GPIO pins</h2></div>
                <button className="primary-btn compact" onClick={() => setShowAddRoom(true)}><Plus size={16} /> Add space</button>
              </div>

              <div className="room-table">
                <div className="room-table-head"><span>SPACE</span><span>DEVICE</span><span>GPIO</span><span>VOICE ALIASES</span><span>STATE</span></div>
                {rooms.map(room => {
                  const device = devices.find(d => d.id === room.id);
                  return <div className="room-row" key={room.id}>
                    <div className="room-name"><div className="bulb-icon small"><Lightbulb size={18} /></div><strong>{room.name}</strong></div>
                    <span>{room.deviceName}</span><span className="pin-badge">{room.pin}</span><span className="aliases">{room.aliases || 'Uses room name'}</span><span className={device?.state ? 'state-on' : 'state-off'}>{device?.state ? 'ON' : 'OFF'}</span>
                  </div>;
                })}
              </div>

              <div className="mapping-note"><Cpu size={18} /><div><strong>Backend-controlled voice routing</strong><p>The web app sends the transcript to the backend. The backend resolves the room to its GPIO pin, stores the command, and delivers it to the ESP8266. The ESP8266 does not contain room names.</p></div></div>
            </section>
          )}
        </section>
      </main>

      {showAddRoom && (
        <div className="modal-backdrop" onMouseDown={e => { if (e.currentTarget === e.target) setShowAddRoom(false); }}>
          <form className="room-modal" onSubmit={addRoom}>
            <div className="modal-head"><div><span className="section-label">NEW SPACE</span><h2>Add a room</h2></div><button type="button" className="icon-btn" onClick={() => setShowAddRoom(false)}><X size={18} /></button></div>
            <label>Space name<input required value={roomForm.name} onChange={e => setRoomForm({ ...roomForm, name: e.target.value })} placeholder="Study Room" /></label>
            <label>Device name<input required value={roomForm.deviceName} onChange={e => setRoomForm({ ...roomForm, deviceName: e.target.value })} placeholder="Study Room Bulb" /></label>
            <label>ESP8266 GPIO pin<div className="select-wrap"><select value={roomForm.pin} onChange={e => setRoomForm({ ...roomForm, pin: e.target.value })}>{availablePins.map(pin => <option key={pin} value={pin}>{pin}</option>)}</select><ChevronDown size={16} /></div></label>
            <label>Voice aliases <span className="label-help">optional</span><input value={roomForm.aliases} onChange={e => setRoomForm({ ...roomForm, aliases: e.target.value })} placeholder="study room, office, study" /></label>
            <div className="modal-actions"><button type="button" className="secondary-btn" onClick={() => setShowAddRoom(false)}>Cancel</button><button type="submit" className="primary-btn">Add space</button></div>
          </form>
        </div>
      )}
    </>
  );
}
