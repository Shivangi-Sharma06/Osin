import { useRef, useState } from 'react';
import { createInvestigation, getInvestigation } from './api';
import type { InputType, InvestigationResponse } from './types';
import { Results } from './Results';

const TABS: Array<{ id: InputType; label: string; placeholder: string }> = [
  { id: 'username', label: 'Username', placeholder: 'e.g. torvalds' },
  { id: 'name', label: 'Name', placeholder: 'e.g. Linus Torvalds' },
  { id: 'phone', label: 'Phone', placeholder: 'e.g. +1 503 555 0100' },
  { id: 'email', label: 'Email', placeholder: 'e.g. person@example.com' },
];

function validate(tab: InputType, value: string): string | null {
  if (!value.trim()) return 'Please enter a value first.';
  if (tab === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'That does not look like a valid email address.';
  }
  if (tab === 'phone' && !/^\+?[0-9][0-9\s\-()]{5,20}$/.test(value)) {
    return 'That does not look like a valid phone number.';
  }
  return null;
}

export default function App() {
  const [tab, setTab] = useState<InputType>('username');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvestigationResponse | null>(null);
  const pollRef = useRef<number | null>(null);

  const switchTab = (t: InputType): void => {
    setTab(t);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    const validationError = validate(tab, value);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    if (pollRef.current) window.clearInterval(pollRef.current);
    try {
      const id = await createInvestigation(value.trim(), tab);
      pollRef.current = window.setInterval(async () => {
        try {
          const inv = await getInvestigation(id);
          if (inv.status === 'completed' || inv.status === 'failed') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setResult(inv);
            setBusy(false);
          }
        } catch {
          // transient poll error — keep polling until it succeeds
        }
      }, 1500);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  return (
    <div className="app">
      <header className="app-header">
        <h1>OSIN</h1>
        <p className="subtitle">
          Correlate public identities with confidence scores — every result is scored and explained.
        </p>
      </header>

      <section className="search-panel">
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
        <div className="search-row">
          <input
            type={tab === 'email' ? 'email' : tab === 'phone' ? 'tel' : 'text'}
            value={value}
            placeholder={active.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void submit();
            }}
            disabled={busy}
          />
          <button className="search-btn" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Scoring…' : 'Search'}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      {busy && <p className="status">Running collectors and scoring signals…</p>}
      {result && <Results result={result} />}
    </div>
  );
}
