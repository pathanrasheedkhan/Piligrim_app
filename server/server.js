// Load PORT and other local settings from .env when present.
require('dotenv').config();

const cors = require('cors');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const GroupService = require('./services/group_service');
const registerGroupSocketHandlers = require('./sockets/group_socket_handlers');

const app = express();
app.use(cors({ origin: '*' }));

// This endpoint confirms that the HTTP server is running.
app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'pilgrim-tracking-server' });
});

// Socket.IO shares the same HTTP server and accepts local Flutter Web clients.
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

registerGroupSocketHandlers(io, new GroupService());

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // A small event pair verifies that clients can send and receive Socket.IO events.
  socket.on('ping_server', () => {
    socket.emit('pong_server');
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const port = Number(process.env.PORT) || 3000;

httpServer.listen(port, () => {
  console.log(`Pilgrim Tracking server listening on port ${port}`);
});