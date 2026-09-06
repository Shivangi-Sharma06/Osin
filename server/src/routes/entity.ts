import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { getEntityGraph } from '../db/repo.js';
import { getClusterForSummary, getEntityTimeline, saveClusterSummary } from '../db/repo.js';
import { summarizeCluster } from '../ai/groq.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const entityRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Evidence graph for one entity. Depth-limited recursive CTE — direct
   * connections only by default; never returns the whole dataset.
   */
  app.get<{ Params: { id: string }; Querystring: { depth?: string; limit?: string } }>(
    '/entity/:id/graph',
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        reply.code(400);
        return { error: 'invalid_id' };
      }
      const depth = Math.min(Math.max(Number(request.query.depth ?? 1) || 1, 1), 3);
      const limit = Math.min(Math.max(Number(request.query.limit ?? 40) || 40, 1), 40);

      const graph = await getEntityGraph(id, depth, limit);
      return {
        ...graph,
        confidence_threshold: config.edgeVisibilityThreshold,
      };
    },
  );

  /**
   * AI reasoning summary for one finalized cluster (Task 8). The model is
   * constrained to reason only over explanation_json. Summaries are cached
   * on the cluster row; pass ?refresh=1 to regenerate.
   */
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/clusters/:id/summary',
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        reply.code(400);
        return { error: 'invalid_id' };
      }
      const cluster = await getClusterForSummary(id);
      if (!cluster) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const refresh = request.query.refresh === '1';
      if (cluster.ai_summary && !refresh) {
        return {
          cluster_id: id,
          summary: cluster.ai_summary,
          model: cluster.ai_summary_model,
          cached: true,
          error: null,
        };
      }

      const result = await summarizeCluster({
        input_type: cluster.input_type,
        input_value: cluster.input_value,
        score: cluster.score,
        explanation: cluster.explanation,
      });
      if (result.summary) {
        await saveClusterSummary(id, result.summary, result.model ?? config.groqModel);
      }
      return {
        cluster_id: id,
        summary: result.summary,
        model: result.model,
        cached: false,
        error: result.error,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/entity/:id/timeline', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      reply.code(400);
      return { error: 'invalid_id' };
    }
    const timeline = await getEntityTimeline(id);
    if (!timeline) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return {
      ...timeline,
      note:
        'Historical coverage depends on public platform support. Current observations are stored from the first OSIN scan onward.',
    };
  });
};
