import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:pilgrim_tracking_app/authentication/auth_exception.dart';
import 'package:pilgrim_tracking_app/authentication/auth_service.dart';

class _RecordingClient extends http.BaseClient {
  _RecordingClient({required this.responses}) : assert(responses.isNotEmpty);

  final List<http.Response> responses;
  final List<Map<String, dynamic>> calls = <Map<String, dynamic>>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final body = await request.finalize().toBytes();
    calls.add({
      'method': request.method,
      'url': request.url.toString(),
      'body': jsonDecode(utf8.decode(body)) as Map<String, dynamic>,
    });

    final response = responses.removeAt(0);
    return http.StreamedResponse(
      Stream<List<int>>.fromIterable([response.bodyBytes]),
      response.statusCode,
      headers: response.headers,
      request: request,
      reasonPhrase: response.reasonPhrase,
    );
  }
}

void main() {
  group('AuthService', () {
    test('login posts to /auth/login with the correct fields', () async {
      final client = _RecordingClient(
        responses: <http.Response>[
          http.Response(
            jsonEncode({
              'token': 'abc123',
              'user': {
                'id': 'user-1',
                'name': 'Ada',
                'email': 'ada@example.com',
              },
            }),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        ],
      );

      final service = AuthService(client: client, baseUrl: 'https://example.com');
      final result = await service.login(
        email: 'ada@example.com',
        password: 'password123',
      );

      expect(result.token, 'abc123');
      expect(result.user.id, 'user-1');
      expect(result.user.name, 'Ada');
      expect(result.user.email, 'ada@example.com');
      expect(client.calls.length, 1);
      expect(client.calls.first['method'], 'POST');
      expect(client.calls.first['url'], 'https://example.com/auth/login');
      expect(client.calls.first['body'], {
        'email': 'ada@example.com',
        'password': 'password123',
      });
    });

    test('register posts to /auth/register with the correct fields', () async {
      final client = _RecordingClient(
        responses: <http.Response>[
          http.Response(
            jsonEncode({
              'user': {
                'id': 'user-2',
                'name': 'Grace',
                'email': 'grace@example.com',
              },
            }),
            201,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        ],
      );

      final service = AuthService(client: client, baseUrl: 'https://example.com');
      final result = await service.register(
        name: 'Grace Hopper',
        email: 'grace@example.com',
        password: 'password123',
      );

      expect(result.id, 'user-2');
      expect(result.name, 'Grace');
      expect(result.email, 'grace@example.com');
      expect(client.calls.length, 1);
      expect(client.calls.first['method'], 'POST');
      expect(client.calls.first['url'], 'https://example.com/auth/register');
      expect(client.calls.first['body'], {
        'name': 'Grace Hopper',
        'email': 'grace@example.com',
        'password': 'password123',
      });
    });

    test('login wraps unauthorized and unexpected server errors', () async {
      final client = _RecordingClient(
        responses: <http.Response>[
          http.Response(
            jsonEncode({'error': 'Invalid email or password.'}),
            401,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
          http.Response(
            jsonEncode({'error': 'Unable to log in at this time.'}),
            500,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        ],
      );

      final service = AuthService(client: client, baseUrl: 'https://example.com');

      await expectLater(
        service.login(email: 'ada@example.com', password: 'wrong'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'UNAUTHORIZED')),
      );

      await expectLater(
        service.login(email: 'ada@example.com', password: 'wrong2'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'SERVER_ERROR')),
      );
    });

    test('register handles conflict and invalid responses', () async {
      final client = _RecordingClient(
        responses: <http.Response>[
          http.Response(
            jsonEncode({'error': 'An account with that email already exists.'}),
            409,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
          http.Response('not json', 200, headers: {'content-type': 'text/plain'}),
        ],
      );

      final service = AuthService(client: client, baseUrl: 'https://example.com');

      await expectLater(
        service.register(
          name: 'Grace Hopper',
          email: 'taken@example.com',
          password: 'password123',
        ),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'CONFLICT')),
      );

      await expectLater(
        service.register(
          name: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'password123',
        ),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_RESPONSE')),
      );
    });

    test('login handles network errors and invalid JSON', () async {
      final service = AuthService(
        client: _FailingClient(),
        baseUrl: 'https://example.com',
      );

      await expectLater(
        service.login(email: 'ada@example.com', password: 'password123'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'NETWORK_ERROR')),
      );

      final invalidJsonClient = _RecordingClient(
        responses: <http.Response>[
          http.Response('not json', 200, headers: {'content-type': 'application/json'}),
        ],
      );
      final invalidJsonService = AuthService(
        client: invalidJsonClient,
        baseUrl: 'https://example.com',
      );

      await expectLater(
        invalidJsonService.login(email: 'ada@example.com', password: 'password123'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_RESPONSE')),
      );
    });
  });
}

class _FailingClient extends http.BaseClient {
  @override
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    throw http.ClientException('No network');
  }
}
