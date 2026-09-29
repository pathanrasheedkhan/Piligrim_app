# Pilgrim Tracking Server

## Current Status

This backend is now in the final authenticated backend integration phase. The durable source of truth remains PostgreSQL, and the canonical application identity is the verified JWT subject mapped to `socket.userId` for Socket.IO flows and `req.user.id` for HTTP flows.

The identity chain is:

```text
users.id
    ↓
JWT sub
    ↓
socket.userId / req.user.id
    ↓
authenticated group operations
```

The server deliberately does not trust client-controlled user IDs, usernames, or creator payload fields for authorization. Group creation, membership, meeting-point authorization, restart/rejoin restoration, and socket authentication all derive identity from the verified JWT subject and the persisted `users` table.

## Requirements

Install Node.js 18 or newer. From this directory, install the dependencies:

```sh
npm install
```

## Environment file

The local `.env` file in the `server` directory contains the server port, PostgreSQL settings, and JWT configuration:

```env
PORT=3000
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=pilgrim_tracking
DATABASE_USER=postgres
DATABASE_PASSWORD=your_local_postgres_password
JWT_SECRET=replace_with_a_secure_local_secret
JWT_EXPIRES_IN=1h
```

If `PORT` is omitted, the server defaults to port `3000`.
Set `DATABASE_PASSWORD` to the password configured for your local PostgreSQL user. The `.env` file is ignored by Git. The JWT secret must be supplied through the environment and must not be hard-coded or committed.

Check PostgreSQL connectivity without starting the HTTP server:

```sh
npm run db:check
```

This executes `SELECT NOW()` and does not create tables or change application state.

Apply the PostgreSQL schema explicitly with:

```sh
npm run db:migrate
```

## Authentication architecture

The final backend identity flow is:

```text
User
  |
  | email + password
  v
POST /auth/register
  |
  v
PostgreSQL users table

User
  |
  | email + password
  v
POST /auth/login
  |
  v
JWT (sub = verified PostgreSQL user UUID)
  |
  v
Socket.IO handshake
  |
  v
JWT verification
  |
  v
socket.userId
  |
  v
group handlers and group service
  |
  v
PostgreSQL group membership and creator records
```

Important rules:

- `users.id` is the canonical persistent application identity.
- `socket.userId` is derived only from the verified JWT `sub` claim.
- HTTP `req.user.id` is derived only from the verified JWT `sub` claim.
- Client-provided `userId`, `userName`, `name`, or `creatorUserId` values are never trusted for authentication or authorization.
- Socket IDs are temporary connection identifiers and are never persisted as application identity.
- GPS remains runtime-only; it is not persisted in PostgreSQL.

## Registration endpoint

`POST /auth/register` accepts:

```json
{
  "name": "Test User",
  "email": "user@example.com",
  "password": "secure-password"
}
```

Validation rules:

- `name`, `email`, and `password` are required.
- Names are trimmed and must not be blank.
- Emails are trimmed, lowercased, and validated before insertion.
- Passwords must be at least 8 characters long.
- Password hashes are created with bcrypt and never returned in the API response.
- Duplicate email addresses are rejected.

## Login endpoint

`POST /auth/login` accepts:

```json
{
  "email": "user@example.com",
  "password": "secure-password"
}
```

Successful login returns HTTP 200 with a JWT whose `sub` is the stable PostgreSQL UUID for the user.

```json
{
  "token": "<jwt>",
  "user": {
    "id": "<stable-user-uuid>",
    "name": "Test User",
    "email": "user@example.com"
  }
}
```

The login flow validates email normalization, checks the bcrypt hash, and signs a JWT using the shared JWT configuration. No refresh tokens, password reset flow, or email verification flow are introduced in this backend phase.

## HTTP authentication middleware

HTTP routes may require the `Authorization` header:

```http
Authorization: Bearer <jwt>
```

The middleware:

- verifies the bearer token signature and expiration
- validates the JWT `sub` claim as a UUID
- attaches the trusted identity to `req.user.id`
- rejects malformed, expired, unsigned, missing-sub, or invalid-sub tokens with a sanitized 401 response
- does not expose JWT library errors, stack traces, or token details in the HTTP response

## Socket.IO authentication

Socket.IO connections authenticate during the handshake. Clients send the JWT from `POST /auth/login` as the Socket.IO auth token:

```js
const socket = io('http://localhost:3000', {
  auth: {
    token: '<jwt from /auth/login>'
  }
});
```

The server accepts either a plain token or a bearer token string in the same `auth.token` field, but the preferred contract is the raw JWT value. The handshake verifies the JWT, validates the UUID `sub`, and sets `socket.userId` from the verified credential. Missing, empty, malformed, expired, unsigned, or invalid-sub tokens are rejected.

## Authenticated group operations

Group behavior now uses authenticated identity as the only trusted path:

- `create_group` uses `socket.userId` as the creator and persists it into `groups.creator_user_id`
- `join_group` uses `socket.userId` as the member identity and persists `group_members.user_id`
- `set_meeting_point` checks `socket.userId` against the persisted `groups.creator_user_id`
- member names are loaded from the persisted `users` record associated with `socket.userId`
- payload fields such as `userId`, `creatorUserId`, `userName`, and `name` are ignored for authorization decisions

The canonical relationship remains:

```text
socket.userId
      ↓
users.id
      ↓
users.name
```

## Restart and rejoin

On restart, the backend starts without runtime group state. When an authenticated member reconnects or re-joins a group, the durable data is restored from PostgreSQL:

```text
Backend starts
      ↓
No groups loaded in memory initially
      ↓
Authenticated socket connects
      ↓
JWT verified
      ↓
socket.userId established
      ↓
User requests/rejoins group
      ↓
Persisted group and memberships are loaded
      ↓
Group runtime restored
      ↓
Socket joins room
```

This preserves:

- persisted group state
- persisted membership state
- meeting point data
- creator identity
- authenticated member rejoin
- rejection of non-members
- duplicate membership prevention

Socket IDs are never persisted, and live GPS is still empty after a restart until fresh location updates arrive.

## GPS behavior

GPS remains intentionally memory-only:

```text
GPS update
   ↓
memory
   ↓
Socket.IO broadcast
```

There is no GPS table, no GPS persistence, and no GPS restoration after a server restart. New location updates are required after reconnect.

## Start the server

```sh
npm start
```

You should see a message that the server is listening on port 3000. To use another port, change `PORT` in `.env` and restart.

## Tests

Run the backend tests with:

```sh
npm test
```

The automated suite verifies:

- registration
- login
- HTTP middleware
- Socket.IO authentication
- PostgreSQL persistence
- group creation and join flows
- meeting-point authorization
- restart and rejoin restoration
- GPS memory-only behavior
- impersonation protections
- multi-socket identity handling

## Health check

Open [http://localhost:3000/health](http://localhost:3000/health). A running server returns:

```json
{
  "status": "ok",
  "service": "pilgrim-tracking-server"
}
```

Check PostgreSQL through the application at [http://localhost:3000/health/db](http://localhost:3000/health/db). It returns HTTP 200 when `SELECT NOW()` succeeds and HTTP 503 when the database is unavailable.

## Important backend limitations

- Flutter authentication is not implemented here.
- No refresh-token flow is added.
- No password reset or email verification is added.
- No OAuth, social login, or role system is added.
- No production deployment, HTTPS configuration, or cloud hosting is introduced.
- CORS remains open for local development and should be tightened before production use.
