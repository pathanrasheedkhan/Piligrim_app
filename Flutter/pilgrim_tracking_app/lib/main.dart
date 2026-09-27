import 'package:flutter/material.dart';

import 'models/group.dart';
import 'screens/group_lobby_screen.dart';
import 'screens/map_screen.dart';
import 'services/app_session_service.dart';
import 'services/group_service.dart';
import 'services/socket_service.dart';
import 'screens/create_group_form_screen.dart';
import 'screens/join_group_screen.dart';

void main() {
  SocketService.instance.connect();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Pilgrim Tracking',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF286B57),
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: const Color(0xFFF4F7F4),
      ),
      home: const AppStartupScreen(),
    );
  }
}

class AppStartupScreen extends StatefulWidget {
  const AppStartupScreen({super.key});

  @override
  State<AppStartupScreen> createState() => _AppStartupScreenState();
}

class _AppStartupScreenState extends State<AppStartupScreen> {
  bool _isRestoring = true;
  Group? _restoredGroup;
  bool _restoreToMap = false;
  String? _startupMessage;
  bool _canRetry = false;

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    if (mounted) setState(() => _isRestoring = true);
    final session = await AppSessionService.instance.loadGroupSession();
    if (session == null) {
      if (mounted) setState(() => _isRestoring = false);
      return;
    }

    SocketService.instance.connect();
    try {
      final group = await GroupService.instance.rejoinGroup(session);
      if (!mounted) return;
      setState(() {
        _restoredGroup = group;
        _restoreToMap = session.enteredMap;
        _startupMessage = null;
        _canRetry = false;
        _isRestoring = false;
      });
    } on SocketServiceException catch (error) {
      final invalidSession =
          error.code == 'GROUP_NOT_FOUND' ||
          error.code == 'NOT_GROUP_MEMBER' ||
          error.code == 'INVALID_GROUP_CODE' ||
          error.code == 'INVALID_USER_ID';
      if (invalidSession) {
        await AppSessionService.instance.clearGroupSession();
        SocketService.instance.disconnect();
        SocketService.instance.connect();
      }
      if (!mounted) return;
      setState(() {
        _startupMessage = invalidSession
            ? 'Your previous group is no longer available.'
            : 'Could not reconnect to your previous group. Check your connection and retry.';
        _canRetry = !invalidSession;
        _isRestoring = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _startupMessage =
            'Could not reconnect to your previous group. Check your connection and retry.';
        _canRetry = true;
        _isRestoring = false;
      });
    }
  }

  void _returnHome() {
    setState(() {
      _restoredGroup = null;
      _restoreToMap = false;
      _startupMessage = null;
      _canRetry = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_isRestoring) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final group = _restoredGroup;
    if (group != null) {
      return _restoreToMap
          ? MapScreen(group: group, onLeave: _returnHome)
          : GroupLobbyScreen(group: group, onLeave: _returnHome);
    }
    return HomeScreen(
      message: _startupMessage,
      onRetry: _canRetry ? _restoreSession : null,
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({this.message, this.onRetry, super.key});

  final String? message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Pilgrim Tracking',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      color: const Color(0xFF203A32),
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'Stay connected on your journey.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: const Color(0xFF65736D),
                    ),
                  ),
                  if (message != null) ...[
                    const SizedBox(height: 20),
                    Text(
                      message!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                    if (onRetry != null)
                      TextButton.icon(
                        onPressed: onRetry,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Retry reconnecting'),
                      ),
                  ],
                  const SizedBox(height: 40),
                  FilledButton(
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (context) => const CreateGroupFormScreen(),
                        ),
                      );
                    },
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(64),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                      textStyle: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    child: const Text('Create a Group'),
                  ),
                  const SizedBox(height: 16),
                  OutlinedButton(
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (context) => const JoinGroupScreen(),
                        ),
                      );
                    },
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(64),
                      foregroundColor: const Color(0xFF286B57),
                      backgroundColor: Colors.white,
                      side: const BorderSide(color: Color(0xFFB7C9C0)),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                      textStyle: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    child: const Text('Join a Group'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

