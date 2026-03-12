/**
 * Socket.io WebSocket server setup
 */

import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import type { ServerToClientEvents, ClientToServerEvents, AuthUser } from '@tracearr/shared';
import { WS_EVENTS, REDIS_KEYS } from '@tracearr/shared';
import type { Redis } from 'ioredis';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface SocketData {
  user: AuthUser;
}

let io: TypedServer | null = null;
let redis: Redis | null = null;

/**
 * Verify JWT token for WebSocket connections
 */
function verifyToken(token: string): AuthUser {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }

  const decoded = jwt.verify(token, secret) as AuthUser;
  return decoded;
}

export function initializeWebSocket(
  httpServer: HttpServer,
  basePath = '',
  redisClient?: Redis
): TypedServer {
  if (redisClient) {
    redis = redisClient;
  }
  io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || true,
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    // When basePath is set, Socket.io must listen on the prefixed path.
    // Socket.io runs on the raw HTTP server (not Fastify), so rewriteUrl doesn't apply.
    ...(basePath && { path: `${basePath}/socket.io` }),
  });

  // Authentication middleware
  io.use((socket: TypedSocket, next) => {
    try {
      const token = socket.handshake.auth.token as string | undefined;

      if (!token) {
        next(new Error('Authentication required'));
        return;
      }

      // Verify JWT and attach user to socket
      const user = verifyToken(token);

      // Check if this mobile device's token has been blacklisted (revoked)
      if (user.mobile && user.deviceId && redis) {
        redis
          .get(REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(user.deviceId))
          .then((blacklisted) => {
            if (blacklisted) {
              next(new Error('Session has been revoked'));
            } else {
              (socket.data as SocketData).user = user;
              next();
            }
          })
          .catch((err: unknown) => {
            console.error('[WebSocket] Blacklist check error:', err);
            // Allow connection on Redis failure (fail-open for availability)
            (socket.data as SocketData).user = user;
            next();
          });
        return;
      }

      (socket.data as SocketData).user = user;
      next();
    } catch (error) {
      console.error('[WebSocket] Auth error:', error);
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: TypedSocket) => {
    const user = (socket.data as SocketData).user;
    console.log(
      `[WebSocket] Client connected: ${socket.id} (user: ${user?.username ?? 'unknown'})`
    );

    // Join user-specific room for targeted messages
    if (user?.userId) {
      void socket.join(`user:${user.userId}`);
    }

    // Join device-specific room for mobile clients (enables targeted disconnect)
    if (user?.mobile && user?.deviceId) {
      void socket.join(`mobile:${user.deviceId}`);
    }

    // Join server rooms for server-specific messages
    if (user?.serverIds) {
      for (const serverId of user.serverIds) {
        void socket.join(`server:${serverId}`);
      }
    }

    // Auto-subscribe to sessions on connect
    void socket.join('sessions');

    // Handle session subscriptions
    socket.on(WS_EVENTS.SUBSCRIBE_SESSIONS as 'subscribe:sessions', () => {
      void socket.join('sessions');
      console.log(`[WebSocket] ${socket.id} subscribed to sessions`);
    });

    socket.on(WS_EVENTS.UNSUBSCRIBE_SESSIONS as 'unsubscribe:sessions', () => {
      void socket.leave('sessions');
      console.log(`[WebSocket] ${socket.id} unsubscribed from sessions`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WebSocket] Client disconnected: ${socket.id}, reason: ${reason}`);
    });
  });

  console.log('[WebSocket] Server initialized');
  return io;
}

export function getIO(): TypedServer {
  if (!io) {
    throw new Error('WebSocket server not initialized');
  }
  return io;
}

export function broadcastToSessions<K extends keyof ServerToClientEvents>(
  event: K,
  ...args: Parameters<ServerToClientEvents[K]>
): void {
  if (io) {
    (io.to('sessions').emit as (event: K, ...args: Parameters<ServerToClientEvents[K]>) => void)(
      event,
      ...args
    );
  }
}

export function broadcastToServer<K extends keyof ServerToClientEvents>(
  serverId: string,
  event: K,
  ...args: Parameters<ServerToClientEvents[K]>
): void {
  if (io) {
    (
      io.to(`server:${serverId}`).emit as (
        event: K,
        ...args: Parameters<ServerToClientEvents[K]>
      ) => void
    )(event, ...args);
  }
}

/**
 * Force-disconnect a specific mobile device's sockets.
 * Scans all connected sockets rather than relying on room membership.
 */
export function disconnectMobileDevice(deviceId: string): void {
  if (!io) return;
  for (const [, socket] of io.sockets.sockets) {
    const user = (socket.data as SocketData).user;
    if (user?.mobile && user.deviceId === deviceId) {
      socket.disconnect(true);
    }
  }
}

/**
 * Force-disconnect all mobile sockets for a user.
 */
export function disconnectAllMobileDevices(userId: string): void {
  if (!io) return;
  for (const [, socket] of io.sockets.sockets) {
    const user = (socket.data as SocketData).user;
    if (user?.mobile && user.userId === userId) {
      socket.disconnect(true);
    }
  }
}

export function broadcastToAll<K extends keyof ServerToClientEvents>(
  event: K,
  ...args: Parameters<ServerToClientEvents[K]>
): void {
  if (io) {
    (io.emit as (event: K, ...args: Parameters<ServerToClientEvents[K]>) => void)(event, ...args);
  }
}
