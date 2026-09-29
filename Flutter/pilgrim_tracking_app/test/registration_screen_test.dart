import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:pilgrim_tracking_app/authentication/auth_exception.dart';
import 'package:pilgrim_tracking_app/authentication/auth_service.dart';
import 'package:pilgrim_tracking_app/authentication/models/user.dart';
import 'package:pilgrim_tracking_app/main.dart';
import 'package:pilgrim_tracking_app/screens/registration_screen.dart';
import 'package:pilgrim_tracking_app/services/app_session_service.dart';

class _FakeSecureTokenStorage implements SecureTokenStorage {
  @override
  Future<String?> readToken() async => null;

  @override
  Future<void> writeToken(String token) async {}

  @override
  Future<void> deleteToken() async {}
}

class _FakeAuthService extends AuthService {
  _FakeAuthService({this.error, this.completer});

  final AuthException? error;
  final Completer<User>? completer;
  final List<Map<String, String>> registrations = [];

  @override
  Future<User> register({
    required String name,
    required String email,
    required String password,
  }) async {
    registrations.add({'name': name, 'email': email, 'password': password});
    if (completer != null) return completer!.future;
    if (error != null) throw error!;
    return const User(id: 'user-1', name: 'A User', email: 'a@example.com');
  }
}

Future<void> _pumpRegistration(
  WidgetTester tester, {
  required _FakeAuthService authService,
}) async {
  await tester.pumpWidget(
    MaterialApp(home: RegistrationScreen(authService: authService)),
  );
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('rejects empty name and email', (tester) async {
    final authService = _FakeAuthService();
    await _pumpRegistration(tester, authService: authService);

    await tester.tap(find.text('Register'));
    await tester.pump();

    expect(find.text('Enter your name'), findsOneWidget);
    expect(find.text('Enter your email'), findsOneWidget);
    expect(authService.registrations, isEmpty);

    await tester.enterText(find.byType(TextFormField).at(0), '   ');
    await tester.tap(find.text('Register'));
    await tester.pump();
    expect(find.text('Enter your name'), findsOneWidget);
  });

  testWidgets('home screen opens registration', (tester) async {
    await tester.pumpWidget(
      MyApp(sessionService: AppSessionService(secureTokenStorage: _FakeSecureTokenStorage())),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Create an account'));
    await tester.pumpAndSettle();

    expect(find.text('Registration'), findsOneWidget);
    expect(find.text('Confirm Password'), findsOneWidget);
  });

  testWidgets('rejects invalid email', (tester) async {
    final authService = _FakeAuthService();
    await _pumpRegistration(tester, authService: authService);
    await tester.enterText(find.byType(TextFormField).at(0), 'A User');
    await tester.enterText(find.byType(TextFormField).at(1), 'not-an-email');
    await tester.enterText(find.byType(TextFormField).at(2), 'password123');
    await tester.enterText(find.byType(TextFormField).at(3), 'password123');

    await tester.tap(find.text('Register'));
    await tester.pump();

    expect(find.text('Enter a valid email address'), findsOneWidget);
    expect(authService.registrations, isEmpty);
  });

  testWidgets('rejects short passwords and mismatched confirmation', (
    tester,
  ) async {
    final authService = _FakeAuthService();
    await _pumpRegistration(tester, authService: authService);
    await tester.enterText(find.byType(TextFormField).at(0), 'A User');
    await tester.enterText(find.byType(TextFormField).at(1), 'a@example.com');
    await tester.enterText(find.byType(TextFormField).at(2), 'short');
    await tester.enterText(find.byType(TextFormField).at(3), 'different');

    await tester.tap(find.text('Register'));
    await tester.pump();

    expect(find.text('Password must be at least 8 characters'), findsOneWidget);
    expect(find.text('Passwords do not match'), findsOneWidget);
    expect(authService.registrations, isEmpty);
  });

  testWidgets('registers normalized values and shows success without a token', (
    tester,
  ) async {
    final authService = _FakeAuthService();
    await _pumpRegistration(tester, authService: authService);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is EditableText && widget.obscureText,
      ),
      findsNWidgets(2),
    );
    await tester.enterText(find.byType(TextFormField).at(0), '  A User  ');
    await tester.enterText(
      find.byType(TextFormField).at(1),
      '  A@Example.COM  ',
    );
    await tester.enterText(find.byType(TextFormField).at(2), 'password123');
    await tester.enterText(find.byType(TextFormField).at(3), 'password123');

    await tester.tap(find.text('Register'));
    await tester.pumpAndSettle();

    expect(authService.registrations, [
      {'name': 'A User', 'email': 'a@example.com', 'password': 'password123'},
    ]);
    expect(find.text('Your account has been created.'), findsOneWidget);
    expect(find.text('Return to home'), findsOneWidget);
    final preferences = await SharedPreferences.getInstance();
    expect(preferences.getKeys(), isEmpty);
    expect(find.textContaining('password123'), findsNothing);
  });

  final errorCases = <({AuthException error, String message})>[
    (
      error: const AuthException(
        code: 'CONFLICT',
        message: 'Internal database details',
        statusCode: 409,
      ),
      message: 'An account with this email already exists.',
    ),
    (
      error: const AuthException(
        code: 'BAD_REQUEST',
        message: 'Internal validation detail',
        statusCode: 400,
      ),
      message: 'Please check your name, email, and password and try again.',
    ),
    (
      error: const AuthException(
        code: 'SERVER_ERROR',
        message: 'SQL error and secret values',
        statusCode: 500,
      ),
      message:
          'Unable to create your account right now. Please try again later.',
    ),
    (
      error: const AuthException(
        code: 'NETWORK_ERROR',
        message: 'Raw connection details',
      ),
      message:
          'Unable to connect to the server. Please check your connection and try again.',
    ),
  ];

  for (final errorCase in errorCases) {
    testWidgets('shows safe registration error for ${errorCase.error.code}', (
      tester,
    ) async {
      final authService = _FakeAuthService(error: errorCase.error);
      await _pumpRegistration(tester, authService: authService);
      await tester.enterText(find.byType(TextFormField).at(0), 'A User');
      await tester.enterText(find.byType(TextFormField).at(1), 'a@example.com');
      await tester.enterText(find.byType(TextFormField).at(2), 'password123');
      await tester.enterText(find.byType(TextFormField).at(3), 'password123');

      await tester.tap(find.text('Register'));
      await tester.pumpAndSettle();

      expect(find.text(errorCase.message), findsOneWidget);
      expect(find.text('Internal database details'), findsNothing);
      expect(find.text('SQL error and secret values'), findsNothing);
      expect(find.text('Raw connection details'), findsNothing);
    });
  }

  testWidgets('prevents duplicate submission while a request is pending', (
    tester,
  ) async {
    final completer = Completer<User>();
    final authService = _FakeAuthService(completer: completer);
    await _pumpRegistration(tester, authService: authService);
    await tester.enterText(find.byType(TextFormField).at(0), 'A User');
    await tester.enterText(find.byType(TextFormField).at(1), 'a@example.com');
    await tester.enterText(find.byType(TextFormField).at(2), 'password123');
    await tester.enterText(find.byType(TextFormField).at(3), 'password123');

    await tester.tap(find.text('Register'));
    await tester.pump();
    await tester.tap(find.text('Registering...'));
    await tester.pump();

    expect(authService.registrations, hasLength(1));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    completer.complete(
      const User(id: 'user-1', name: 'A User', email: 'a@example.com'),
    );
    await tester.pumpAndSettle();
    expect(find.text('Your account has been created.'), findsOneWidget);
  });
}
