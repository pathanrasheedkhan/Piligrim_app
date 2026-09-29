const DEFAULT_JWT_EXPIRES_IN = '1h';

function getJwtConfig() {
  const secret = process.env.JWT_SECRET;
  if (!secret || !String(secret).trim()) {
    throw new Error('JWT_SECRET environment variable is required for authentication.');
  }

  return {
    secret: String(secret).trim(),
    expiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_JWT_EXPIRES_IN,
  };
}

module.exports = {
  DEFAULT_JWT_EXPIRES_IN,
  getJwtConfig,
};
