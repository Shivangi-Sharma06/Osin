import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { getEntityGraph } from '../db/repo.js';

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
};
