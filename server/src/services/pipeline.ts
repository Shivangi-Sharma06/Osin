import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';
import { scoreCluster } from '../scoring/engine.js';
import type { ScoringEvidence, ScoringIdentifier } from '../scoring/types.js';
import { publishProgress } from '../queue/events.js';
import { enabledCollectorsFor } from '../collectors/registry.js';
import type { InputType } from '../collectors/types.js';
import {
  createEntity,
  createMatchCluster,
  attachEvidenceToCluster,
  getInvestigation,
  insertEvidenceSignals,
  updateInvestigationStatus,
  upsertIdentifierForEntity,
} from '../db/repo.js';

/**
 * The worker pipeline: collector → normalizer (upsert) → scoring engine →
 * match_clusters row. Every collector result is scored — nothing unscored
 * is ever persisted as a user-visible result.
 */
export async function runInvestigationPipeline(investigationId: string): Promise<void> {
  const inv = await getInvestigation(investigationId);
  if (!inv) throw new Error(`investigation ${investigationId} not found`);

  const inputType = inv.input_type as InputType;
  const inputValue = inv.input_value;

  await updateInvestigationStatus(investigationId, 'running');
  await recordAudit({
    investigation_id: investigationId,
    actor: 'pipeline',
    action: 'pipeline_started',
    subject: inputValue,
    details: { input_type: inputType },
  });
  await publishProgress(investigationId, {
    type: 'started',
    input_type: inputType,
    input_value: inputValue,
  });

  try {
    const collectorsToRun = enabledCollectorsFor(inputType);
    if (collectorsToRun.length === 0) {
      throw new Error(`no_enabled_collector: no enabled collector for input_type=${inputType}`);
    }

    const entityType = inputType === 'domain' ? 'domain' : 'person';
    const entity = await createEntity(investigationId, entityType, inputValue);

    const scoringIdentifiers: ScoringIdentifier[] = [];
    const scoringEvidence: ScoringEvidence[] = [];
    let foundAny = false;

    for (const collector of collectorsToRun) {
      await publishProgress(investigationId, {
        type: 'collector_started',
        platform: collector.platform,
      });
      try {
        const result = await collector.fetch({
          input_type: inputType,
          input_value: inputValue,
          investigation_id: investigationId,
        });

        if (!result.found) {
          await publishProgress(investigationId, {
            type: 'collector_completed',
            platform: collector.platform,
            found: false,
            reason: result.unavailable_reason ?? null,
          });
          continue;
        }
        foundAny = true;

        for (const draft of result.identifiers) {
          await upsertIdentifierForEntity(entity.id, draft);
          scoringIdentifiers.push({
            identifier_type: draft.identifier_type,
            value: draft.value,
            platform: draft.platform,
            metadata: draft.metadata ?? {},
          });
        }
        await insertEvidenceSignals({
          investigation_id: investigationId,
          entity_id: entity.id,
          collector: result.collector,
          drafts: result.evidence,
        });
        for (const e of result.evidence) {
          scoringEvidence.push({
            signal_type: e.signal_type,
            source_platform: e.source_platform,
            raw_data: e.raw_data ?? {},
          });
        }

        await publishProgress(investigationId, {
          type: 'collector_completed',
          platform: collector.platform,
          found: true,
          identifiers: result.identifiers.length,
        });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        await recordAudit({
          investigation_id: investigationId,
          actor: `collector:${collector.platform}`,
          action: 'collector_error',
          subject: inputValue,
          details: { error: message },
        });
        await publishProgress(investigationId, {
          type: 'collector_error',
          platform: collector.platform,
          error: message,
        });
        // Isolate collector failures — remaining collectors still run.
      }
    }

    if (!foundAny) {
      await updateInvestigationStatus(investigationId, 'completed');
      await recordAudit({
        investigation_id: investigationId,
        actor: 'pipeline',
        action: 'pipeline_completed',
        subject: inputValue,
        details: { found: false },
      });
      await publishProgress(investigationId, { type: 'completed', found: false });
      return;
    }

    await publishProgress(investigationId, { type: 'scoring_started' });
    const scoreResult = scoreCluster({
      input_type: inputType,
      input_value: inputValue,
      reference_metadata: null,
      identifiers: scoringIdentifiers,
      evidence: scoringEvidence,
    });
    await publishProgress(investigationId, {
      type: 'scoring_completed',
      score: scoreResult.score,
    });

    const cluster = await createMatchCluster({
      investigation_id: investigationId,
      primary_entity_id: entity.id,
      score: scoreResult.score,
      explanation: scoreResult.explanation_json,
    });
    await attachEvidenceToCluster(investigationId, cluster.id);
    await publishProgress(investigationId, {
      type: 'cluster_written',
      cluster_id: cluster.id,
      score: scoreResult.score,
    });

    await updateInvestigationStatus(investigationId, 'completed');
    await recordAudit({
      investigation_id: investigationId,
      actor: 'pipeline',
      action: 'pipeline_completed',
      subject: inputValue,
      status_code: 200,
      details: { found: true, score: scoreResult.score, cluster_id: cluster.id },
    });
    await publishProgress(investigationId, {
      type: 'completed',
      found: true,
      score: scoreResult.score,
      cluster_id: cluster.id,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await updateInvestigationStatus(investigationId, 'failed', message);
    await recordAudit({
      investigation_id: investigationId,
      actor: 'pipeline',
      action: 'pipeline_failed',
      subject: inputValue,
      details: { error: message },
    });
    await publishProgress(investigationId, { type: 'failed', error: message });
    throw err;
  }
}
