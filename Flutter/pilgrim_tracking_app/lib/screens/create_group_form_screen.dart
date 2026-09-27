import 'package:flutter/material.dart';

import '../services/group_service.dart';
import '../services/socket_service.dart';
import 'group_lobby_screen.dart';

class CreateGroupFormScreen extends StatefulWidget {
  const CreateGroupFormScreen({super.key});

  @override
  State<CreateGroupFormScreen> createState() => _CreateGroupFormScreenState();
}

class _CreateGroupFormScreenState extends State<CreateGroupFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _groupNameController = TextEditingController();
  int _memberLimit = 2;
  String? _createError;
  bool _isSubmitting = false;

  @override
  void dispose() {
    _groupNameController.dispose();
    super.dispose();
  }

  Future<void> _createGroup() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _createError = null;
      _isSubmitting = true;
    });
    try {
      final group = await GroupService.instance.createGroup(
        groupName: _groupNameController.text.trim(),
        maxMembers: _memberLimit,
      );
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (context) => GroupLobbyScreen(group: group),
        ),
      );
    } on SocketServiceException catch (error) {
      if (mounted) setState(() => _createError = error.message);
    } catch (_) {
      if (mounted) setState(() => _createError = 'Unable to create the group.');
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create a Group')),
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
                            Text(
                              'Set up your group',
                              style: Theme.of(context).textTheme.headlineSmall
                                  ?.copyWith(fontWeight: FontWeight.w700),
                            ),
                            const SizedBox(height: 24),
                            TextFormField(
                              controller: _groupNameController,
                              decoration: const InputDecoration(
                                labelText: 'Group Name',
                                border: OutlineInputBorder(),
                              ),
                              textCapitalization: TextCapitalization.words,
                              validator: (value) {
                                if (value == null || value.trim().isEmpty) {
                                  return 'Enter a group name';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 20),
                            DropdownButtonFormField<int>(
                              initialValue: _memberLimit,
                              decoration: const InputDecoration(
                                labelText: 'Number of Members',
                                border: OutlineInputBorder(),
                              ),
                              items: List.generate(
                                5,
                                (index) => DropdownMenuItem(
                                  value: index + 2,
                                  child: Text('${index + 2} members'),
                                ),
                              ),
                              onChanged: (value) {
                                if (value != null) {
                                  setState(() => _memberLimit = value);
                                }
                              },
                              validator: (value) {
                                if (value == null || value < 2 || value > 6) {
                                  return 'Choose between 2 and 6 members';
                                }
                                return null;
                              },
                            ),
                            if (_createError != null) ...[
                              const SizedBox(height: 16),
                              Text(
                                _createError!,
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
                      onPressed: _isSubmitting ? null : _createGroup,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(56),
                      ),
                      child: Text(_isSubmitting ? 'Creating...' : 'Create Group'),
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