const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getJwtConfig } = require('./auth_config');

async function hashPassword(plainTextPassword) {
  if (typeof plainTextPassword !== 'string' || plainTextPassword.length === 0) {
    throw new Error('Password is required.');
  }

  return bcrypt.hash(plainTextPassword, 12);
}

async function verifyPassword(plainTextPassword, passwordHash) {
  if (typeof plainTextPassword !== 'string' || typeof passwordHash !== 'string') {
    return false;
  }

  return bcrypt.compare(plainTextPassword, passwordHash);
}

function getJwtSecret() {
  return getJwtConfig().secret;
}

function createAccessToken(userId) {
  const { secret, expiresIn } = getJwtConfig();
  return jwt.sign({}, secret, { subject: userId, expiresIn });
}

function verifyAccessToken(token) {
  const { secret } = getJwtConfig();
  const payload = jwt.verify(token, secret);

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid token payload.');
  }

  const { sub } = payload;
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new Error('Token subject is required.');
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(sub)) {
    throw new Error('Invalid token subject.');
  }

  return { id: sub };
}

module.exports = {
  hashPassword,
  verifyPassword,
  getJwtSecret,
  createAccessToken,
  verifyAccessToken,
};
