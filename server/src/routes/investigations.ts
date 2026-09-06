import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';
import { enqueueInvestigation } from '../queue/queues.js';
import { enabledCollectorsFor } from '../collectors/registry.js';
import type { InputType } from '../collectors/types.js';
import {
  createInvestigation,
  getInvestigation,
  getInvestigationResults,
  listInvestigations,
} from '../db/repo.js';

const INPUT_TYPES: InputType[] = ['username', 'name', 'phone', 'email', 'domain'];
const MAX_INPUT_LENGTH = 200;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s\-()]{5,20}$/;

function validateInput(inputType: InputType, value: string): string | null {
  if (inputType === 'email' && !EMAIL_RE.test(value)) return 'input is not a valid email address';
  if (inputType === 'phone' && !PHONE_RE.test(value)) return 'input is not a valid phone number';
  return null;
}

export const investigationRoutes: FastifyPluginAsync = async (app) => {
  /** Async by contract: creates the job and returns immediately. */
  app.post('/investigations', async (request, reply) => {
    const body = (request.body ?? {}) as { input?: unknown; input_type?: unknown };
    const inputType = typeof body.input_type === 'string' ? body.input_type : '';
    const inputValue = typeof body.input === 'string' ? body.input.trim() : '';

    if (!INPUT_TYPES.includes(inputType as InputType)) {
      reply.code(400);
      return { error: 'invalid_input_type', message: `input_type must be one of: ${INPUT_TYPES.join(', ')}` };
    }
    if (!inputValue || inputValue.length > MAX_INPUT_LENGTH) {
      reply.code(400);
      return { error: 'invalid_input', message: `input must be a non-empty string of at most ${MAX_INPUT_LENGTH} chars` };
    }
    const shapeError = validateInput(inputType as InputType, inputValue);
    if (shapeError) {
      reply.code(400);
      return { error: 'invalid_input', message: shapeError };
    }

    const available = enabledCollectorsFor(inputType as InputType);
    if (available.length === 0) {
      reply.code(422);
      return {
        error: 'no_enabled_collector',
        message: `No enabled collector for input_type=${inputType} yet. Enable one via OSIN_COLLECTOR_* config.`,
      };
    }

    const inv = await createInvestigation(inputType, inputValue, 'queued');
    await enqueueInvestigation(inv.id);
    await recordAudit({
      investigation_id: inv.id,
      actor: 'api',
      action: 'job_enqueued',
      subject: inputValue,
      details: { input_type: inputType, collectors: available.map((c) => c.platform) },
    });

    reply.code(202);
    return { investigation_id: inv.id, status: 'queued' };
  });

  app.get<{ Params: { id: string } }>('/investigations/:id', async (request, reply) => {
    const { id } = request.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      reply.code(400);
      return { error: 'invalid_id' };
    }
    const inv = await getInvestigation(id);
    if (!inv) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const results =
      inv.status === 'completed' ? await getInvestigationResults(id) : null;
    return {
      id: inv.id,
      input_type: inv.input_type,
      input_value: inv.input_value,
      status: inv.status,
      error: inv.error,
      created_at: inv.created_at,
      updated_at: inv.updated_at,
      results,
    };
  });

  app.get('/investigations', async () => {
    return { investigations: await listInvestigations(50) };
  });
};

// Referenced so config stays a visible dependency of the route module.
void config;
