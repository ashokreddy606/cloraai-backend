const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const Redis = require('ioredis');

let io;

/**
 * Initialize Socket.io Server
 * @param {Object} httpServer - The HTTP/HTTPS server instance
 */
const initSocket = async (httpServer) => {
  try {
    io = new Server(httpServer, {
      pingTimeout: 60000,
      pingInterval: 25000,
      connectTimeout: 45000,
      cors: {
        origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : '*',
        methods: ['GET', 'POST'],
        credentials: true
      },
      transports: ['websocket', 'polling']
    });

    // Support for horizontal scaling using Redis Adapter
    if (process.env.REDIS_URL) {
      const pubClient = new Redis(process.env.REDIS_URL);
      const subClient = pubClient.duplicate();
      
      pubClient.on('error', (err) => logger.error('SOCKET:REDIS_PUB', err.message));
      subClient.on('error', (err) => logger.error('SOCKET:REDIS_SUB', err.message));

      io.adapter(createAdapter(pubClient, subClient));
      logger.info('SOCKET', 'Redis Adapter initialized for horizontal scaling.');
    } else {
      logger.warn('SOCKET', 'REDIS_URL not found. Socket.io running with in-memory adapter (single-instance only).');
    }

    // Authentication Middleware
    io.use((socket, next) => {
      // In Socket.io 4.x, auth can be in handshake.auth or handshake.query
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      
      if (!token) {
        logger.warn('SOCKET:AUTH', 'Connection rejected: Token missing', { id: socket.id });
        return next(new Error('Authentication error: Token missing'));
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = decoded;
        next();
      } catch (err) {
        logger.error('SOCKET:AUTH', 'Connection rejected: Invalid token', { id: socket.id, error: err.message });
        return next(new Error('Authentication error: Invalid token'));
      }
    });

    io.on('connection', (socket) => {
      const userId = socket.user?.id || socket.user?._id || socket.user?.sub;
      
      if (!userId) {
        logger.error('SOCKET', 'User connected but no userId found in token payload', { socketId: socket.id });
        return socket.disconnect();
      }

      logger.info('SOCKET', `User connected: ${userId} (Socket: ${socket.id})`);

      // Join a private room for targeted events
      socket.join(`user:${userId}`);

      // Basic error handling for this socket
      socket.on('error', (err) => {
        logger.error('SOCKET:CLIENT_ERROR', `Socket error for user ${userId}`, { error: err.message });
      });

      socket.on('disconnect', (reason) => {
        logger.info('SOCKET', `User disconnected: ${userId} (Reason: ${reason})`);
      });
    });

    logger.info('SERVER', '✅ Socket.IO system initialized successfully.');
    return io;
  } catch (error) {
    logger.error('SOCKET:INIT_FATAL', 'Failed to initialize Socket.io', { error: error.message });
    throw error;
  }
};

/**
 * Get the Socket.io instance
 */
const getIO = () => {
  if (!io) {
    logger.error('SOCKET:GET', 'Attempted to get IO before initialization');
    return null; // Return null instead of throwing to prevent crashing downstream calls
  }
  return io;
};

/**
 * Emit event to a specific user
 * @param {string} userId - Target user ID
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
const emitToUser = (userId, event, data) => {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  } else {
    logger.warn('SOCKET:EMIT', 'Cannot emit event, IO not initialized', { userId, event });
  }
};

module.exports = { initSocket, getIO, emitToUser };

