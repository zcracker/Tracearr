/**
 * Platform Statistics Route
 *
 * GET /platforms - Plays by platform
 * Uses prepared statement for 10-30% query plan reuse speedup (when no server filter)
 */

import type { FastifyPluginAsync } from 'fastify';
import { statsQuerySchema } from '@tracearr/shared';
import { playsByPlatformSince } from '../../db/prepared.js';
import { resolveDateRange } from './utils.js';
import { validateServerAccess, buildServerFilterFragment } from '../../utils/serverFiltering.js';
import { queryPlatforms } from './queries.js';

export const platformsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /platforms - Plays by platform
   * Uses prepared statement for better performance when no server filter
   */
  app.get('/platforms', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildServerFilterFragment(serverId, authUser);
    const needsServerFilter = serverId || authUser.role !== 'owner';

    // For 'all' period (no start date) OR when server filtering is needed, use shared query
    // Prepared statements don't support dynamic server filtering
    if (!dateRange.start || needsServerFilter) {
      const data = await queryPlatforms({ rangeStart: dateRange.start, serverFilter });
      return { data };
    }

    // No server filter needed and has date range - use prepared statement for performance
    const platformStats = await playsByPlatformSince.execute({ since: dateRange.start });
    return { data: platformStats };
  });
};
