import { useEffect, useRef, useState } from 'react';
import { createInvestigation, createSelfAudit, getInvestigation } from './api';
import type { InputType, InvestigationResponse, ProgressEventUI } from './types';
import { Results } from './Results';
import { GraphView } from './GraphView';
import { LiveProgress } from './LiveProgress';

const TABS: Array<{ id: InputType; label: string; placeholder: string }> = [
  { id: 'username', label: 'Username', placeholder: 'e.g. torvalds' },
  { id: 'name', label: 'Name', placeholder: 'e.g. Linus Torvalds' },
  { id: 'phone', label: 'Phone', placeholder: 'e.g. 503 555 0100' },
  { id: 'email', label: 'Email', placeholder: 'e.g. person@example.com' },
];

const COUNTRY_CODES = ['+1', '+44', '+61', '+91', '+971'];

type Mode = 'person' | 'domain' | 'self';

function validate(tab: InputType, value: string): string | null {
  if (!value.trim()) return 'Please enter a value first.';
  if (tab === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'That does not look like a valid email address.';
  }
  if (tab === 'phone' && !/^\+?[0-9][0-9\s\-()]{5,20}$/.test(value)) {
    return 'That does not look like a valid phone number.';
  }
  if (
    tab === 'domain' &&
    !/^(?=.{1,253}$)(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,63}(?:\/.*)?$/i.test(value)
  ) {
    return 'That does not look like a valid domain.';
  }
  return null;
}

export default function App() {
  const [mode, setMode] = useState<Mode>('person');
  const [tab, setTab] = useState<InputType>('username');
  const [value, setValue] = useState('');
  const [countryCode, setCountryCode] = useState('+1');
  const [selfAuditText, setSelfAuditText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvestigationResponse | null>(null);
  const [graphEntity, setGraphEntity] = useState<{ id: string; label: string } | null>(null);
  const [progress, setProgress] = useState<ProgressEventUI[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => () => esRef.current?.close(), []);

  const switchTab = (t: InputType): void => {
    setTab(t);
    setError(null);
  };

  const streamInvestigation = (id: string): void => {
    let finished = false;
    const finish = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      esRef.current?.close();
      try {
        setResult(await getInvestigation(id));
      } catch (err) {
        setError((err as Error).message);
      }
      setBusy(false);
    };

    const es = new EventSource(`/api/investigations/${id}/events`);
    esRef.current = es;
    es.addEventListener('progress', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as ProgressEventUI;
      setProgress((p) => [...p, data]);
      if (data.type === 'completed' || data.type === 'failed') void finish();
    });
    es.onerror = () => {
      // Server closes the stream after the terminal event.
    };
  };

  const runAndStream = async (input: string, inputType: InputType): Promise<void> => {
    const id = await createInvestigation(input, inputType);
    streamInvestigation(id);
  };

  const submit = async (): Promise<void> => {
    const inputType = mode === 'domain' ? 'domain' : tab;
    const finalValue = inputType === 'phone' && !value.trim().startsWith('+')
      ? `${countryCode} ${value.trim()}`
      : value.trim();
    const validationError = validate(inputType, finalValue);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setGraphEntity(null);
    setProgress([]);
    esRef.current?.close();

    try {
      await runAndStream(finalValue, inputType);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submitSelfAudit = async (): Promise<void> => {
    const identifiers = selfAuditText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [kind, ...rest] = line.split(':');
        return { input_type: kind as InputType, input: rest.join(':').trim() };
      })
      .filter((row) => ['username', 'name', 'phone', 'email'].includes(row.input_type) && row.input);
    if (identifiers.length === 0) {
      setError('Enter one identifier per line, like username:torvalds or email:name@example.com.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setGraphEntity(null);
    setProgress([]);
    esRef.current?.close();
    try {
      const jobs = await createSelfAudit(identifiers);
      streamInvestigation(jobs[0]!.investigation_id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const active = mode === 'domain'
    ? { id: 'domain' as InputType, label: 'Domain', placeholder: 'e.g. example.com' }
    : (TABS.find((t) => t.id === tab) ?? TABS[0]!);

  return (
    <div className="app">
      <header className="app-header">
        <h1>OSIN</h1>
        <p className="subtitle">
          Correlate public identities with confidence scores — every result is scored and explained.
        </p>
      </header>

      <section className="search-panel">
        <div className="tabs mode-tabs" role="tablist" aria-label="Investigation mode">
          {[
            ['person', 'Person'],
            ['domain', 'Domain'],
            ['self', 'Self-Audit'],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              className={`tab${mode === id ? ' active' : ''}`}
              onClick={() => {
                setMode(id as Mode);
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'person' && (
          <div className="tabs" role="tablist" aria-label="Input type">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`tab${tab === t.id ? ' active' : ''}`}
                onClick={() => switchTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {mode !== 'self' ? (
          <div className="search-row">
            {active.id === 'phone' && (
              <select
                className="country-select"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                disabled={busy}
              >
                {COUNTRY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            )}
            <input
              type={active.id === 'email' ? 'email' : active.id === 'phone' ? 'tel' : 'text'}
              value={value}
              placeholder={active.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void submit();
              }}
              disabled={busy}
            />
            <button className="search-btn" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Scoring...' : 'Search'}
            </button>
          </div>
        ) : (
          <div className="self-audit">
            <textarea
              value={selfAuditText}
              onChange={(e) => setSelfAuditText(e.target.value)}
              placeholder={'username:torvalds\nemail:person@example.com\nphone:+1 503 555 0100'}
              disabled={busy}
            />
            <button
              className="search-btn"
              onClick={() => void submitSelfAudit()}
              disabled={busy}
            >
              {busy ? 'Scoring...' : 'Run self-audit'}
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      {busy && <p className="status">Running collectors and scoring signals…</p>}
      <LiveProgress events={progress} />
      {result && <Results result={result} onOpenGraph={setGraphEntity} />}
      {graphEntity && <GraphView root={graphEntity} onClose={() => setGraphEntity(null)} />}
    </div>
  );
}
