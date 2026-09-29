import 'dart:convert';

import 'package:http/http.dart' as http;

import '../authentication/auth_exception.dart';
import '../authentication/models/login_response.dart';
import '../authentication/models/user.dart';
import '../networking/api_client.dart';

class AuthService {
  AuthService({http.Client? client, String? baseUrl})
      : _apiClient = ApiClient(client: client ?? http.Client(), baseUrl: baseUrl);

  final ApiClient _apiClient;

  Future<LoginResponse> login({
    required String email,
    required String password,
  }) async {
    try {
      final response = await _apiClient.post(
        '/auth/login',
        body: {
          'email': email,
          'password': password,
        },
      );
      return _parseLoginResponse(response);
    } on http.ClientException {
      throw const AuthException(
        code: 'NETWORK_ERROR',
        message: 'Unable to reach the server. Check your connection and try again.',
      );
    }
  }

  Future<User> register({
    required String name,
    required String email,
    required String password,
  }) async {
    try {
      final response = await _apiClient.post(
        '/auth/register',
        body: {
          'name': name,
          'email': email,
          'password': password,
        },
      );
      return _parseRegisterResponse(response);
    } on http.ClientException {
      throw const AuthException(
        code: 'NETWORK_ERROR',
        message: 'Unable to reach the server. Check your connection and try again.',
      );
    }
  }

  LoginResponse _parseLoginResponse(http.Response response) {
    final parsed = _decodeBody(response);
    if (response.statusCode == 200) {
      return LoginResponse.fromJson(parsed);
    }
    throw _mapError(response, parsed);
  }

  User _parseRegisterResponse(http.Response response) {
    final parsed = _decodeBody(response);
    if (response.statusCode == 201) {
      final userPayload = parsed['user'];
      if (userPayload is Map) {
        return User.fromJson(Map<String, dynamic>.from(userPayload));
      }
      throw const AuthException(
        code: 'INVALID_RESPONSE',
        message: 'The server returned an invalid response.',
      );
    }
    throw _mapError(response, parsed);
  }

  Map<String, dynamic> _decodeBody(http.Response response) {
    try {
      final dynamic decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) {
        return decoded;
      }
      if (decoded is Map) {
        return Map<String, dynamic>.from(decoded);
      }
      throw const AuthException(
        code: 'INVALID_RESPONSE',
        message: 'The server returned an invalid response.',
      );
    } on FormatException {
      throw const AuthException(
        code: 'INVALID_RESPONSE',
        message: 'The server returned an invalid response.',
      );
    }
  }

  AuthException _mapError(http.Response response, Map<String, dynamic> payload) {
    switch (response.statusCode) {
      case 400:
        return AuthException(
          code: 'BAD_REQUEST',
          message: (payload['error'] as String?) ?? 'The request could not be processed.',
          statusCode: response.statusCode,
        );
      case 401:
        return AuthException(
          code: 'UNAUTHORIZED',
          message: (payload['error'] as String?) ?? 'Invalid email or password.',
          statusCode: response.statusCode,
        );
      case 409:
        return AuthException(
          code: 'CONFLICT',
          message: (payload['error'] as String?) ?? 'An account with that email already exists.',
          statusCode: response.statusCode,
        );
      case 500:
        return AuthException(
          code: 'SERVER_ERROR',
          message: (payload['error'] as String?) ?? 'The server is unavailable.',
          statusCode: response.statusCode,
        );
      default:
        return const AuthException(
          code: 'INVALID_RESPONSE',
          message: 'The server returned an invalid response.',
        );
    }
  }
}
