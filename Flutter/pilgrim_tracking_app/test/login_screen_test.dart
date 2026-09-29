import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:pilgrim_tracking_app/authentication/auth_exception.dart';
import 'package:pilgrim_tracking_app/authentication/auth_service.dart';
import 'package:pilgrim_tracking_app/authentication/models/login_response.dart';
import 'package:pilgrim_tracking_app/authentication/models/user.dart';
import 'package:pilgrim_tracking_app/screens/login_screen.dart';
import 'package:pilgrim_tracking_app/services/app_session_service.dart';
import 'package:pilgrim_tracking_app/services/socket_service.dart';

class _FakeSecureTokenStorage implements SecureTokenStorage {
  String? token;
  final writes = <String>[];

  @override
  Future<String?> readToken() async => token;

  @override
  Future<void> writeToken(String value) async {
    token = value;
    writes.add(value);
  }

  @override
  Future<void> deleteToken() async => token = null;
}

class _FakeAuthService extends AuthService {
  _FakeAuthService({this.error, this.completer, this.response});

  final AuthException? error;
  final Completer<LoginResponse>? completer;
  final LoginResponse? response;
  final List<Map<String, String>> logins = [];

  @override
  Future<LoginResponse> login({
    required String email,
    required String password,
  }) async {
    logins.add({'email': email, 'password': password});
    if (completer != null) return completer!.future;
    if (error != null) throw error!;
    return response ??
        const LoginResponse(
          token: 'test-token',
          user: User(id: 'user-1', name: 'Ada', email: 'ada@example.com'),
        );
  }
}

Future<void> _pumpLogin(
  WidgetTester tester, {
  required _FakeAuthService authService,
  AppSessionService? sessionService,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: LoginScreen(
        authService: authService,
        sessionService:
            sessionService ??
            AppSessionService(secureTokenStorage: _FakeSecureTokenStorage()),
      ),
    ),
  );
}

void main() {
  setUp(() {
    SocketService.allowNetworkConnection = false;
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() => SocketService.allowNetworkConnection = true);

  testWidgets('renders email and obscured password fields', (tester) async {
    await _pumpLogin(tester, authService: _FakeAuthService());

    expect(find.text('Email'), findsOneWidget);
    expect(find.text('Password'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is EditableText && widget.obscureText,
      ),
      findsOneWidget,
    );
  });

  testWidgets('rejects empty email', (tester) async {
    final authService = _FakeAuthService();
    await _pumpLogin(tester, authService: authService);

    await tester.tap(find.widgetWithText(FilledButton, 'Login'));
    await tester.pump();

    expect(find.text('Enter your email'), findsOneWidget);
    expect(authService.logins, isEmpty);
  });

  testWidgets('rejects empty password', (tester) async {
    final authService = _FakeAuthService();
    await _pumpLogin(tester, authService: authService);
    await tester.enterText(find.byType(TextFormField).first, 'ada@example.com');

    await tester.tap(find.widgetWithText(FilledButton, 'Login'));
    await tester.pump();

    expect(find.text('Enter a password'), findsOneWidget);
    expect(authService.logins, isEmpty);
  });

  testWidgets('rejects invalid email', (tester) async {
    final authService = _FakeAuthService();
    await _pumpLogin(tester, authService: authService);
    await tester.enterText(find.byType(TextFormField).first, 'not-an-email');
    await tester.enterText(find.byType(TextFormField).last, 'password123');

    await tester.tap(find.widgetWithText(FilledButton, 'Login'));
    await tester.pump();

    expect(find.text('Enter a valid email address'), findsOneWidget);
    expect(authService.logins, isEmpty);
  });

  testWidgets('sends normalized credentials and handles login success', (
    tester,
  ) async {
    final authService = _FakeAuthService();
    await _pumpLogin(tester, authService: authService);
    await tester.enterText(
      find.byType(TextFormField).first,
      '  Ada@Example.COM  ',
    );
    await tester.enterText(find.byType(TextFormField).last, ' password123 ');

    await tester.tap(find.widgetWithText(FilledButton, 'Login'));
    await tester.pumpAndSettle();

    expect(authService.logins, [
      {'email': 'ada@example.com', 'password': ' password123 '},
    ]);
    expect(find.text('Login successful. Welcome, Ada.'), findsOneWidget);
  });

  testWidgets('persists the token securely without displaying it', (
    tester,
  ) async {
    const token = 'do-not-display-this-token';
    final secureStorage = _FakeSecureTokenStorage();
    final sessionService = AppSessionService(secureTokenStorage: secureStorage);
    await _pumpLogin(
      tester,
      authService: _FakeAuthService(
        response: const LoginResponse(
          token: token,
          user: User(id: 'user-1', name: 'Ada', email: 'ada@example.com'),
        ),
      ),
      sessionService: sessionService,
    );
    await tester.enterText(find.byType(TextFormField).first, 'ada@example.com');
    await tester.enterText(find.byType(TextFormField).last, 'password123');

    await tester.tap(find.widgetWithText(FilledButton, 'Login'));
    await tester.pumpAndSettle();

    final preferences = await SharedPreferences.getInstance();
    expect(secureStorage.writes, [token]);
    expect(sessionService.authenticatedSession?.token, token);
    expect(preferences.getKeys(), {'pilgrim_tracking_auth_user'});
    expect(preferences.getString('pilgrim_tracking_auth_user'), isNot(contains(token)));
    expect(find.textContaining(token), findsNothing);
  });

  final errorCases = <({AuthException error, String message})>[
    (
      error: const AuthException(
        code: 'BAD_REQUEST',
        message: 'Internal request details',
        statusCode: 400,
      ),
      message: 'Please check your email and password and try again.',
    ),
    (
      error: const AuthException(
        code: 'UNAUTHORIZED',
        message: 'Backend says user or password rejected',
        statusCode: 401,
      ),
      message: 'Invalid email or password.',
    ),
    (
      error: const AuthException(
        code: 'SERVER_ERROR',
        message: 'Database failure details',
        statusCode: 500,
      ),
      message: 'Unable to log in right now. Please try again later.',
    ),
    (
      error: const AuthException(
        code: 'NETWORK_ERROR',
        message: 'Raw socket details',
      ),
      message:
          'Unable to connect to the server. Please check your connection and try again.',
    ),
  ];

  for (final errorCase in errorCases) {
    testWidgets('shows safe message for ${errorCase.error.code}', (
      tester,
    ) async {
      await _pumpLogin(
        tester,
        authService: _FakeAuthService(error: errorCase.error),
      );
      await tester.enterText(
        find.byType(TextFormField).first,
        'ada@example.com',
      );
      await tester.enterText(find.byType(TextFormField).last, 'password123');

      await tester.tap(find.widgetWithText(FilledButton, 'Login'));
      await tester.pumpAndSettle();

      expect(find.text(errorCase.message), findsOneWidget);
      expect(find.text(errorCase.error.message), findsNothing);
    });
  }

  testWidgets('prevents duplicate submission while request is pending', (
    tester,
  ) async {
    final completer = Completer<LoginResponse>();
    final authService = _FakeAuthService(completer: completer);
    final secureStorage = _FakeSecureTokenStorage();
    await _pumpLogin(
      tester,
      authService: authService,
      sessionService: AppSessionService(secureTokenStorage: secureStorage),
    );
    await tester.enterText(find.byType(TextFormField).first, 'ada@example.com');
    await tester.enterText(find.byType(TextFormField).last, 'password123');

    await tester.tap(find.widgetWithText(FilledButton, 'Login'));
    await tester.pump();
    expect(find.text('Logging in...'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );

    completer.complete(
      const LoginResponse(
        token: 'test-token',
        user: User(id: 'user-1', name: 'Ada', email: 'ada@example.com'),
      ),
    );
    await tester.pumpAndSettle();

    expect(authService.logins, hasLength(1));
    expect(secureStorage.writes, ['test-token']);
  });

  testWidgets('login screen navigates to registration', (tester) async {
    await _pumpLogin(tester, authService: _FakeAuthService());

    await tester.tap(find.text('Create an account'));
    await tester.pumpAndSettle();

    expect(find.text('Registration'), findsOneWidget);
    expect(find.text('Confirm Password'), findsOneWidget);
  });
}
