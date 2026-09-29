// Load PORT and other local settings from .env when present.
require('dotenv').config();

const cors = require('cors');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const GroupService = require('./services/group_service');
const registerGroupSocketHandlers = require('./sockets/group_socket_handlers');
const database = require('./db/database');
const authService = require('./auth/auth_service');
const authMiddleware = require('./middleware/auth_middleware');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

function parseSocketToken(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const trimmedToken = token.trim();
  if (trimmedToken === '') {
    return null;
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmedToken);
  return bearerMatch ? bearerMatch[1].trim() : trimmedToken;
}

function handleSocketAuthentication(socket, next) {
  const token = parseSocketToken(socket.handshake?.auth?.token);

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const authenticatedUser = authService.verifyAccessToken(token);
    socket.userId = authenticatedUser.id;
    socket.user = { id: authenticatedUser.id };
    return next();
  } catch (_error) {
    return next(new Error('Authentication required'));
  }
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function validateRegistrationInput({ name, email, password }) {
  const normalizedName = normalizeName(name);
  const normalizedEmail = normalizeEmail(email);

  if (typeof name !== 'string' || normalizedName.length === 0) {
    return { valid: false, message: 'Name is required.' };
  }
  if (normalizedName.length > 120) {
    return { valid: false, message: 'Name is too long.' };
  }

  if (typeof email !== 'string' || normalizedEmail.length === 0) {
    return { valid: false, message: 'Email is required.' };
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(normalizedEmail)) {
    return { valid: false, message: 'Email is invalid.' };
  }

  if (typeof password !== 'string' || password.trim().length === 0) {
    return { valid: false, message: 'Password is required.' };
  }
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, message: 'Password is too long.' };
  }

  return {
    valid: true,
    name: normalizedName,
    email: normalizedEmail,
    password,
  };
}

function validateLoginInput({ email, password }) {
  const normalizedEmail = normalizeEmail(email);

  if (typeof email !== 'string' || normalizedEmail.length === 0) {
    return { valid: false, message: 'Email is required.' };
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(normalizedEmail)) {
    return { valid: false, message: 'Email is invalid.' };
  }

  if (typeof password !== 'string' || password.trim().length === 0) {
    return { valid: false, message: 'Password is required.' };
  }

  return { valid: true, email: normalizedEmail, password };
}

app.post('/auth/register', async (request, response) => {
  const validation = validateRegistrationInput(request.body || {});
  if (!validation.valid) {
    return response.status(400).json({ error: validation.message });
  }

  const { name, email, password } = validation;

  try {
    const passwordHash = await authService.hashPassword(password);
    const result = await database.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, created_at, updated_at`,
      [name, email, passwordHash],
    );

    const user = result.rows[0];
    return response.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    });
  } catch (error) {
    if (error && error.code === '23505') {
      return response.status(409).json({
        error: 'An account with that email already exists.',
      });
    }

    return response.status(500).json({
      error: 'Unable to register user at this time.',
    });
  }
});

app.post('/auth/login', async (request, response) => {
  const validation = validateLoginInput(request.body || {});
  if (!validation.valid) {
    return response.status(400).json({ error: validation.message });
  }

  try {
    const result = await database.query(
      `SELECT id, name, email, password_hash
       FROM users
       WHERE email = $1`,
      [validation.email],
    );
    const user = result.rows[0];
    if (!user || !(await authService.verifyPassword(validation.password, user.password_hash))) {
      return response.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = authService.createAccessToken(user.id);
    return response.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (_error) {
    return response.status(500).json({
      error: 'Unable to log in at this time.',
    });
  }
});

app.get('/auth/me', authMiddleware, (request, response) => {
  response.json({
    user: {
      id: request.user.id,
    },
  });
});

// This endpoint confirms that the HTTP server is running.
app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'pilgrim-tracking-server' });
});

app.get('/health/db', async (_request, response) => {
  try {
    const currentTime = await database.healthCheck();
    response.json({ status: 'ok', database: 'reachable', currentTime });
  } catch (_error) {
    response.status(503).json({
      status: 'error',
      database: 'unavailable',
      message: 'Database unavailable',
    });
  }
});

function createSocketServer(httpServerInstance) {
  const io = new Server(httpServerInstance, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket, next) => handleSocketAuthentication(socket, next));

  registerGroupSocketHandlers(io, new GroupService());

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id} as ${socket.userId}`);

    socket.emit('authenticated_user', { userId: socket.userId });

    socket.on('ping_server', () => {
      socket.emit('pong_server');
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

// Socket.IO shares the same HTTP server and accepts local Flutter Web clients.
const httpServer = http.createServer(app);
const io = createSocketServer(httpServer);

const port = Number(process.env.PORT) || 3000;

if (require.main === module) {
  httpServer.listen(port, () => {
    console.log(`Pilgrim Tracking server listening on port ${port}`);
  });
}

module.exports = { app, createSocketServer };