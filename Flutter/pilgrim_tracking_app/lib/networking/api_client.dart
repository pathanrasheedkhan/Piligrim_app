import 'dart:convert';

import 'package:http/http.dart' as http;

import '../configuration/api_config.dart';

class ApiClient {
  ApiClient({http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _baseUrl = (baseUrl ?? ApiConfig.baseUrl).trim();

  final http.Client _client;
  final String _baseUrl;

  Future<http.Response> get(
    String path, {
    Map<String, String>? headers,
    Map<String, dynamic>? queryParameters,
  }) async => _send('GET', path, headers: headers, queryParameters: queryParameters);

  Future<http.Response> post(
    String path, {
    Map<String, String>? headers,
    Object? body,
  }) async => _send('POST', path, headers: headers, body: body);

  Future<http.Response> put(
    String path, {
    Map<String, String>? headers,
    Object? body,
  }) async => _send('PUT', path, headers: headers, body: body);

  Future<http.Response> delete(
    String path, {
    Map<String, String>? headers,
    Object? body,
  }) async => _send('DELETE', path, headers: headers, body: body);

  Future<http.Response> _send(
    String method,
    String path, {
    Map<String, String>? headers,
    Map<String, dynamic>? queryParameters,
    Object? body,
  }) async {
    final uri = _buildUri(path, queryParameters);
    final requestHeaders = <String, String>{
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json',
      ...?headers,
    };

    final encodedBody = body == null ? null : jsonEncode(body);
    final request = http.Request(method, uri)
      ..headers.addAll(requestHeaders)
      ..body = encodedBody ?? '';

    try {
      final streamed = await _client.send(request);
      final responseBody = await streamed.stream.bytesToString();
      return http.Response(
        responseBody,
        streamed.statusCode,
        headers: streamed.headers,
        request: request,
        reasonPhrase: streamed.reasonPhrase,
      );
    } on http.ClientException catch (_) {
      rethrow;
    }
  }

  Uri _buildUri(String path, Map<String, dynamic>? queryParameters) {
    final normalizedPath = path.startsWith('/') ? path : '/$path';
    final uri = Uri.parse(_baseUrl).resolve(normalizedPath);
    if (queryParameters == null || queryParameters.isEmpty) {
      return uri;
    }
    return uri.replace(queryParameters: {
      ...uri.queryParameters,
      ...queryParameters.map((key, value) => MapEntry(key, value.toString())),
    });
  }
}
