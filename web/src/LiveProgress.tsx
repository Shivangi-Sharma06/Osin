import type { ProgressEventUI } from './types';

function describe(e: ProgressEventUI): string {
  switch (e.type) {
    case 'started':
      return `Investigation started for ${e.input_value ?? 'input'}`;
    case 'collector_started':
      return `Collector started: ${e.platform ?? '?'}`;
    case 'collector_completed':
      return e.found
        ? `Collector finished: ${e.platform} — profile found (${e.identifiers ?? 0} identifiers)`
        : `Collector finished: ${e.platform} — ${e.reason ?? 'not found'}`;
    case 'collector_error':
      return `Collector error: ${e.platform} — ${e.error ?? 'unknown'}`;
    case 'scoring_started':
      return 'Scoring signals…';
    case 'scoring_completed':
      return `Scoring finished — confidence ${e.score ?? '?'}%`;
    case 'cluster_written':
      return 'Scored result cluster written';
    case 'completed':
      return e.found === false ? 'Completed: no public traces found' : 'Completed';
    case 'failed':
      return `Failed: ${e.error ?? 'unknown error'}`;
    default:
      return e.type;
  }
}

export function LiveProgress({ events }: { events: ProgressEventUI[] }) {
  if (events.length === 0) return null;
  return (
    <section className="progress-panel">
      <h2>Live progress</h2>
      <ul className="progress-list">
        {events.map((e, i) => (
          <li key={i} className={`progress-item stage-${e.type}`}>
            <span className="progress-time">{(e.at ?? '').slice(11, 19)}</span>
            <span>{describe(e)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
