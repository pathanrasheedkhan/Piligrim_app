import 'package:flutter/material.dart';

import '../authentication/auth_exception.dart';
import '../authentication/auth_service.dart';
import '../services/app_session_service.dart';
import '../services/socket_service.dart';
import 'registration_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({this.authService, this.sessionService, super.key});

  final AuthService? authService;
  final AppSessionService? sessionService;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  late final AuthService _authService = widget.authService ?? AuthService();
  late final AppSessionService _sessionService =
      widget.sessionService ?? AppSessionService.instance;
  bool _isSubmitting = false;
  String? _message;
  bool _loginSucceeded = false;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    if (_isSubmitting || !_formKey.currentState!.validate()) return;

    setState(() {
      _message = null;
      _loginSucceeded = false;
      _isSubmitting = true;
    });
    try {
      final response = await _authService.login(
        email: _emailController.text.trim().toLowerCase(),
        password: _passwordController.text,
      );
      if (response.token.trim().isEmpty ||
          response.user.id.trim().isEmpty ||
          response.user.name.trim().isEmpty ||
          response.user.email.trim().isEmpty) {
        throw const AuthException(
          code: 'INVALID_RESPONSE',
          message: 'The server returned an invalid response.',
        );
      }
      await _sessionService.saveAuthSession(response);
      SocketService.instance.connectAuthenticated(sessionService: _sessionService);
      if (mounted) {
        setState(() {
          _message = 'Login successful. Welcome, ${response.user.name}.';
          _loginSucceeded = true;
        });
      }
    } on AuthException catch (error, stackTrace) {
      debugPrint('Login AuthException (${error.runtimeType}): $error');
      debugPrintStack(
        stackTrace: stackTrace,
        label: 'Login AuthException stack trace',
      );
      if (mounted) setState(() => _message = _safeErrorMessage(error));
    } catch (error, stackTrace) {
      debugPrint('Login exception (${error.runtimeType}): $error');
      debugPrintStack(
        stackTrace: stackTrace,
        label: 'Login exception stack trace',
      );
      if (mounted) {
        setState(() => _message = 'Unable to log in. Please try again.');
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  String _safeErrorMessage(AuthException error) {
    if (error.statusCode == 400 || error.code == 'BAD_REQUEST') {
      return 'Please check your email and password and try again.';
    }
    if (error.statusCode == 401 || error.code == 'UNAUTHORIZED') {
      return 'Invalid email or password.';
    }
    if (error.statusCode == 500 || error.code == 'SERVER_ERROR') {
      return 'Unable to log in right now. Please try again later.';
    }
    if (error.code == 'NETWORK_ERROR') {
      return 'Unable to connect to the server. Please check your connection and try again.';
    }
    return 'Unable to log in. Please try again.';
  }

  String? _validateEmail(String? value) {
    final email = value?.trim() ?? '';
    if (email.isEmpty) return 'Enter your email';
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email.toLowerCase())) {
      return 'Enter a valid email address';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Login')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: SingleChildScrollView(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            TextFormField(
                              controller: _emailController,
                              decoration: const InputDecoration(
                                labelText: 'Email',
                                border: OutlineInputBorder(),
                              ),
                              keyboardType: TextInputType.emailAddress,
                              textInputAction: TextInputAction.next,
                              validator: _validateEmail,
                            ),
                            const SizedBox(height: 20),
                            TextFormField(
                              controller: _passwordController,
                              decoration: const InputDecoration(
                                labelText: 'Password',
                                border: OutlineInputBorder(),
                              ),
                              obscureText: true,
                              textInputAction: TextInputAction.done,
                              onFieldSubmitted: (_) => _login(),
                              validator: (value) {
                                if ((value ?? '').trim().isEmpty) {
                                  return 'Enter a password';
                                }
                                return null;
                              },
                            ),
                            if (_message != null) ...[
                              const SizedBox(height: 16),
                              Text(
                                _message!,
                                key: const Key('login-message'),
                                style: TextStyle(
                                  color: _loginSucceeded
                                      ? Theme.of(context).colorScheme.primary
                                      : Theme.of(context).colorScheme.error,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: _isSubmitting ? null : _login,
                        style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(56),
                        ),
                        child: _isSubmitting
                            ? const Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  ),
                                  SizedBox(width: 12),
                                  Text('Logging in...'),
                                ],
                              )
                            : const Text('Login'),
                      ),
                    ),
                    TextButton(
                      onPressed: () {
                        Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (context) => const RegistrationScreen(),
                          ),
                        );
                      },
                      child: const Text('Create an account'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
