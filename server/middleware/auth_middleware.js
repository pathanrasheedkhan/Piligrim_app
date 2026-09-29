const jwt = require('jsonwebtoken');
const authService = require('../auth/auth_service');

function sendAuthenticationRequired(response) {
  return response.status(401).json({ error: 'Authentication required.' });
}

function isJwtAuthenticationFailure(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  const name = typeof error.name === 'string' ? error.name : '';

  return Boolean(
    error instanceof jwt.JsonWebTokenError ||
    error instanceof jwt.TokenExpiredError ||
    name === 'JsonWebTokenError' ||
    name === 'TokenExpiredError' ||
    name === 'NotBeforeError' ||
    message === 'Token subject is required.' ||
    message === 'Invalid token payload.' ||
    message === 'Invalid token subject.'
  );
}

function authMiddleware(request, response, next) {
  const authorizationHeader = request.get('Authorization');

  if (typeof authorizationHeader !== 'string' || authorizationHeader.trim() === '') {
    return sendAuthenticationRequired(response);
  }

  const bearerMatch = /^Bearer\s+([^\s]+)$/.exec(authorizationHeader.trim());
  if (!bearerMatch) {
    return sendAuthenticationRequired(response);
  }

  const token = bearerMatch[1];
  if (!token) {
    return sendAuthenticationRequired(response);
  }

  try {
    const authenticatedUser = authService.verifyAccessToken(token);
    request.user = {
      id: authenticatedUser.id,
    };
    return next();
  } catch (error) {
    if (isJwtAuthenticationFailure(error)) {
      return sendAuthenticationRequired(response);
    }

    return response.status(500).json({ error: 'Authentication unavailable.' });
  }
}

module.exports = authMiddleware;
