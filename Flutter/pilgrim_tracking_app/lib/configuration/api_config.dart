class ApiConfig {
  ApiConfig._();

  static const String _defaultBaseUrl = 'http://localhost:3000';

  static String get baseUrl {
    const configured = String.fromEnvironment(
      'API_BASE_URL',
      defaultValue: _defaultBaseUrl,
    );
    return configured.trim().isEmpty ? _defaultBaseUrl : configured;
  }
}
