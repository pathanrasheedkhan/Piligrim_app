import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/app_session_service.dart';
import '../services/group_service.dart';
import '../services/socket_service.dart';
import 'group_lobby_screen.dart';

class JoinGroupScreen extends StatefulWidget {
  const JoinGroupScreen({super.key});

  @override
  State<JoinGroupScreen> createState() => _JoinGroupScreenState();
}

class _JoinGroupScreenState extends State<JoinGroupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _codeController = TextEditingController();
  String? _joinError;
  bool _isSubmitting = false;

  @override
  void dispose() {
    _nameController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _joinGroup() async {
    setState(() => _joinError = null);
    if (!_formKey.currentState!.validate()) return;
    if (AppSessionService.instance.authenticatedSession == null) {
      setState(() => _joinError = 'Authentication required. Please sign in first.');
      return;
    }

    setState(() => _isSubmitting = true);
    try {
      final group = await GroupService.instance.joinGroup(
        groupCode: _codeController.text,
        userName: _nameController.text.trim(),
      );
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (context) => GroupLobbyScreen(group: group),
        ),
      );
    } on SocketServiceException catch (error) {
      if (mounted) setState(() => _joinError = error.message);
    } catch (_) {
      if (mounted) setState(() => _joinError = 'Unable to join the group.');
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Join a Group')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                children: [
                  Expanded(
                    child: SingleChildScrollView(
                      child: Form(
                        key: _formKey,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            TextFormField(
                              controller: _nameController,
                              decoration: const InputDecoration(
                                labelText: 'Your Name',
                                border: OutlineInputBorder(),
                              ),
                              textCapitalization: TextCapitalization.words,
                              validator: (value) {
                                if (value == null || value.trim().isEmpty) {
                                  return 'Enter your name';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 20),
                            TextFormField(
                              controller: _codeController,
                              decoration: const InputDecoration(
                                labelText: '6-Digit Group Code',
                                border: OutlineInputBorder(),
                              ),
                              keyboardType: TextInputType.number,
                              inputFormatters: [
                                FilteringTextInputFormatter.digitsOnly,
                                LengthLimitingTextInputFormatter(6),
                              ],
                              validator: (value) {
                                if (value == null ||
                                    !RegExp(r'^\d{6}$').hasMatch(value)) {
                                  return 'Enter exactly 6 digits';
                                }
                                return null;
                              },
                            ),
                            if (_joinError != null) ...[
                              const SizedBox(height: 16),
                              Text(
                                _joinError!,
                                style: TextStyle(
                                  color: Theme.of(context).colorScheme.error,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _isSubmitting ? null : _joinGroup,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(56),
                      ),
                      child: Text(_isSubmitting ? 'Joining...' : 'Join Group'),
                    ),
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