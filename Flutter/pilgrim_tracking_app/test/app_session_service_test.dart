import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:pilgrim_tracking_app/authentication/models/login_response.dart';
import 'package:pilgrim_tracking_app/authentication/models/user.dart';
import 'package:pilgrim_tracking_app/main.dart';
import 'package:pilgrim_tracking_app/services/app_session_service.dart';
import 'package:pilgrim_tracking_app/services/group_service.dart';
import 'package:pilgrim_tracking_app/services/socket_service.dart';

class _FakeSecureTokenStorage implements SecureTokenStorage {
  _FakeSecureTokenStorage({this.token, this.readCompleter});

  String? token;
  final Completer<String?>? readCompleter;
  final writes = <String>[];
  int deleteCount = 0;

  @override
  Future<String?> readToken() => readCompleter?.future ?? Future.value(token);

  @override
  Future<void> writeToken(String value) async {
    token = value;
    writes.add(value);
  }

  @override
  Future<void> deleteToken() async {
    token = null;
    deleteCount++;
  }
}

void main() {
  setUp(() {
    SocketService.allowNetworkConnection = false;
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() {
    SocketService.allowNetworkConnection = true;
    SocketService.instance.disconnect();
  });

  test('no stored token restores as unauthenticated', () async {
    final service = AppSessionService(
      secureTokenStorage: _FakeSecureTokenStorage(),
    );

    expect(await service.restoreAuthSession(), isNull);
    expect(service.isAuthenticated, isFalse);
  });

  test('stored token and user restore the authenticated session', () async {
    const token = 'restored-token';
    const user = User(
      id: 'stable-backend-uuid',
      name: 'Ada',
      email: 'ada@example.com',
    );
    final storage = _FakeSecureTokenStorage(token: token);
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString('pilgrim_tracking_auth_user', jsonEncode(user.toJson()));
    final service = AppSessionService(secureTokenStorage: storage);

    final session = await service.restoreAuthSession();

    expect(session?.token, token);
    expect(session?.user.id, user.id);
    expect(session?.user.name, user.name);
    expect(session?.user.email, user.email);
    expect(service.authenticatedSession, same(session));
  });

  test('login saves the active session and never saves a password', () async {
    const response = LoginResponse(
      token: 'login-token',
      user: User(id: 'stable-backend-uuid', name: 'Ada', email: 'ada@example.com'),
    );
    final storage = _FakeSecureTokenStorage();
    final service = AppSessionService(secureTokenStorage: storage);

    await service.saveAuthSession(response);

    final preferences = await SharedPreferences.getInstance();
    expect(storage.writes, ['login-token']);
    expect(storage.token, response.token);
    expect(preferences.getKeys(), {'pilgrim_tracking_auth_user'});
    expect(preferences.getString('pilgrim_tracking_auth_user'), isNot(contains('password')));
    expect(service.authenticatedSession?.user.id, response.user.id);
  });

  test('clear removes the token, saved user and in-memory session', () async {
    final storage = _FakeSecureTokenStorage(token: 'stored-token');
    final service = AppSessionService(secureTokenStorage: storage);
    await service.saveAuthSession(
      const LoginResponse(
        token: 'stored-token',
        user: User(id: 'user-uuid', name: 'Ada', email: 'ada@example.com'),
      ),
    );

    await service.clearAuthSession();

    final preferences = await SharedPreferences.getInstance();
    expect(storage.token, isNull);
    expect(storage.deleteCount, 1);
    expect(preferences.containsKey('pilgrim_tracking_auth_user'), isFalse);
    expect(service.authenticatedSession, isNull);
  });

  testWidgets('startup waits for restoration before selecting entry state', (
    tester,
  ) async {
    const token = 'startup-token';
    final readCompleter = Completer<String?>();
    final storage = _FakeSecureTokenStorage(readCompleter: readCompleter);
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(
      'pilgrim_tracking_auth_user',
      jsonEncode(
        const User(
          id: 'stable-backend-uuid',
          name: 'Ada',
          email: 'ada@example.com',
        ).toJson(),
      ),
    );
    final service = AppSessionService(secureTokenStorage: storage);

    await tester.pumpWidget(
      MaterialApp(home: AppStartupScreen(sessionService: service)),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Welcome back, Ada.'), findsNothing);
    expect(find.text('Stay connected on your journey.'), findsNothing);

    readCompleter.complete(token);
    await tester.pumpAndSettle();

    expect(find.text('Welcome back, Ada.'), findsOneWidget);
    expect(find.text('Log in'), findsNothing);
    expect(find.text('Create an account'), findsNothing);
    expect(find.textContaining(token), findsNothing);
  });

  test('authenticated socket uses JWT only in the auth handshake', () async {
    const token = 'jwt-for-socket-auth';
    final sessionService = AppSessionService(
      secureTokenStorage: _FakeSecureTokenStorage(token: token),
    );
    final socketService = SocketService.instance;
    socketService.disconnect();

    await sessionService.saveAuthSession(
      const LoginResponse(
        token: token,
        user: User(id: 'user-uuid', name: 'Ada', email: 'ada@example.com'),
      ),
    );
    socketService.connectAuthenticated(
      sessionService: sessionService,
      autoConnect: false,
    );

    expect(socketService.connectionAuth, {'token': token});
    expect(socketService.connectionAuth, isNot(contains('userId')));
    expect(socketService.connectionAuth, isNot(contains('userName')));
    expect(socketService.connectionAuth, isNot(contains('groupCode')));
    expect(socketService.connectionAuth?['token'], token);
    expect(socketService.connectionAuth?['token'], isNot(contains('user-uuid')));
  });

  test('group payloads use the authenticated session and omit arbitrary client ids', () async {
    final sessionService = AppSessionService(
      secureTokenStorage: _FakeSecureTokenStorage(token: 'jwt-123'),
    );
    AppSessionService.instance = sessionService;
    await sessionService.saveAuthSession(
      const LoginResponse(
        token: 'jwt-123',
        user: User(id: 'stable-backend-uuid', name: 'Ada', email: 'ada@example.com'),
      ),
    );

    final createPayload = GroupService.buildCreateGroupPayload(
      groupName: 'Pilgrim Friends',
      maxMembers: 4,
      userName: 'Ada',
    );
    final joinPayload = GroupService.buildJoinGroupPayload(
      groupCode: '123456',
      userName: 'Ada',
    );

    expect(createPayload, {
      'groupName': 'Pilgrim Friends',
      'maxMembers': 4,
      'userName': 'Ada',
    });
    expect(createPayload.containsKey('userId'), isFalse);
    expect(joinPayload, {'groupCode': '123456', 'userName': 'Ada'});
    expect(joinPayload.containsKey('userId'), isFalse);
  });

  test('no session means no authenticated socket is created', () async {
    final socketService = SocketService.instance;
    socketService.disconnect();

    socketService.connectAuthenticated(
      sessionService: AppSessionService(
        secureTokenStorage: _FakeSecureTokenStorage(),
      ),
      autoConnect: false,
    );

    expect(socketService.connectionAuth, isNull);
    expect(socketService.isConnected, isFalse);
    expect(socketService.lastConnectionError, isNull);
  });

  test('clearing auth session disconnects the socket', () async {
    final sessionService = AppSessionService(
      secureTokenStorage: _FakeSecureTokenStorage(token: 'jwt-clears-session'),
    );
    final socketService = SocketService.instance;
    socketService.disconnect();

    await sessionService.saveAuthSession(
      const LoginResponse(
        token: 'jwt-clears-session',
        user: User(id: 'user-uuid', name: 'Ada', email: 'ada@example.com'),
      ),
    );
    socketService.connectAuthenticated(
      sessionService: sessionService,
      autoConnect: false,
    );
    expect(socketService.connectionAuth, {'token': 'jwt-clears-session'});

    await sessionService.clearAuthSession();

    expect(socketService.connectionAuth, isNull);
    expect(socketService.isConnected, isFalse);
  });
}