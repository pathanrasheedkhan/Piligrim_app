# Pilgrim Tracking Server (Phase 5A)

This Node.js backend provides an HTTP health check and Socket.IO group creation and joining. Groups are held in server memory and are lost when the server restarts.

## Requirements

Install Node.js 18 or newer. From this directory, install the dependencies:

```sh
npm install
```

## Environment file

Create a `.env` file in the `server` directory with the server port:

```env
PORT=3000
```

If `PORT` is omitted, the server defaults to port `3000`.

## Start the server

```sh
npm start
```

You should see a message that the server is listening on port 3000. To use another port, change `PORT` in `.env` and restart.

## Tests

Run the group service and Socket.IO event tests with:

```sh
npm test
```

## Flutter Web client

In a separate terminal, start Flutter Web after the backend is running:

```sh
cd ../Flutter/pilgrim_tracking_app
flutter pub get
flutter run -d chrome --web-port 7357
```

The app connects to `http://localhost:3000` by default. To use another backend port, pass a URL at build/run time, for example:

```sh
flutter run -d chrome --web-port 7357 --dart-define=SOCKET_SERVER_URL=http://localhost:3001
```

## Health check

Open [http://localhost:3000/health](http://localhost:3000/health). A running server returns:

```json
{
  "status": "ok",
  "service": "pilgrim-tracking-server"
}
```

## Socket.IO events

The backend accepts `create_group` and `join_group` requests. A successful request is acknowledged with the group, and also emits `group_created` or `group_joined`. A successful join emits `member_joined` to the other sockets in that group's room. Room identifiers are the six-digit group codes.

The `ping_server` and `pong_server` test events remain available.

## Phase 5A limitations

- Groups exist only in Node.js memory and disappear on server restart.
- No authentication.
- No GPS broadcasting or live map markers.
- CORS is open for local development and should be restricted before production use.