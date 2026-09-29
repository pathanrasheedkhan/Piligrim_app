import 'dart:async';

import 'package:flutter/material.dart';

import '../models/group.dart';
import '../services/app_session_service.dart';
import '../services/socket_service.dart';
import 'map_screen.dart';

class GroupLobbyScreen extends StatefulWidget {
  const GroupLobbyScreen({required this.group, this.onLeave, super.key});

  final Group group;
  final VoidCallback? onLeave;

  @override
  State<GroupLobbyScreen> createState() => _GroupLobbyScreenState();
}

class _GroupLobbyScreenState extends State<GroupLobbyScreen> {
  StreamSubscription<Map<String, dynamic>>? _memberJoinedSubscription;

  @override
  void initState() {
    super.initState();
    _memberJoinedSubscription = SocketService.instance.memberJoined.listen(
      _onMemberJoined,
    );
  }

  void _onMemberJoined(Map<String, dynamic> event) {
    if (event['groupCode'] != widget.group.groupCode) return;
    final member = GroupMember.fromJson(event);
    if (widget.group.members.any(
      (existing) => existing.userId == member.userId,
    )) {
      return;
    }
    setState(() => widget.group.members.add(member));
  }

  @override
  void dispose() {
    _memberJoinedSubscription?.cancel();
    super.dispose();
  }

  Future<void> _leaveGroup() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Leave group?'),
        content: const Text('Your saved group session will be cleared.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Leave Group'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    await AppSessionService.instance.clearGroupSession();
    if (!mounted) return;
    SocketService.instance.disconnect();
    SocketService.instance.connectAuthenticated();
    if (widget.onLeave != null) {
      widget.onLeave!();
    } else {
      Navigator.of(context).popUntil((route) => route.isFirst);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Group Lobby'),
        actions: [
          IconButton(
            tooltip: 'Leave group',
            onPressed: _leaveGroup,
            icon: const Icon(Icons.exit_to_app),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    widget.group.groupName,
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 28),
                  Text(
                    'Group code',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 8),
                  SelectableText(
                    widget.group.groupCode,
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                      color: const Color(0xFF286B57),
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 28),
                  Text(
                    'Members',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '${widget.group.members.length} of ${widget.group.maxMembers}',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  ...widget.group.members.map(
                    (member) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        children: [
                          const Icon(Icons.person_outline, size: 20),
                          const SizedBox(width: 8),
                          Text(member.name),
                        ],
                      ),
                    ),
                  ),
                  const Spacer(),
                  FilledButton(
                    onPressed: () async {
                      await AppSessionService.instance.markMapEntered();
                      if (!context.mounted) return;
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (context) => MapScreen(group: widget.group),
                        ),
                      );
                    },
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(56),
                    ),
                    child: const Text('Enter Map'),
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
