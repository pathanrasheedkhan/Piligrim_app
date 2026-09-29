import '../models/group.dart';
import 'app_session_service.dart';
import 'socket_service.dart';

class GroupService {
  GroupService._();

  static final GroupService instance = GroupService._();

  static Map<String, dynamic> buildCreateGroupPayload({
    required String groupName,
    required int maxMembers,
    String? userName,
  }) {
    final resolvedUserName = (userName ?? '').trim();
    return {
      'groupName': groupName,
      'maxMembers': maxMembers,
      if (resolvedUserName.isNotEmpty) 'userName': resolvedUserName,
    };
  }

  static Map<String, dynamic> buildJoinGroupPayload({
    required String groupCode,
    String? userName,
  }) {
    final resolvedUserName = (userName ?? '').trim();
    return {
      'groupCode': groupCode,
      if (resolvedUserName.isNotEmpty) 'userName': resolvedUserName,
    };
  }

  static Map<String, dynamic> buildMeetingPointPayload({
    required String groupCode,
    required double latitude,
    required double longitude,
  }) => {
    'groupCode': groupCode,
    'latitude': latitude,
    'longitude': longitude,
  };

  static Map<String, dynamic> buildLocationUpdatePayload({
    required String groupCode,
    required double latitude,
    required double longitude,
  }) => {
    'groupCode': groupCode,
    'latitude': latitude,
    'longitude': longitude,
  };

  AuthenticatedSession _requireAuthenticatedSession() {
    final session = AppSessionService.instance.authenticatedSession;
    if (session == null) {
      throw const SocketServiceException(
        'AUTHENTICATION_REQUIRED',
        'Please sign in to use group features.',
      );
    }
    return session;
  }

  Future<Group> createGroup({
    required String groupName,
    required int maxMembers,
    String userName = 'Creator',
  }) async {
    final session = _requireAuthenticatedSession();
    final payload = buildCreateGroupPayload(
      groupName: groupName,
      maxMembers: maxMembers,
      userName: userName.isNotEmpty ? userName : session.user.name,
    );
    final response = await SocketService.instance.emitGroupRequest(
      'create_group',
      payload,
    );
    final group = Group.fromJson(
      Map<String, dynamic>.from(response['group'] as Map),
    );
    await AppSessionService.instance.saveGroupSession(
      group: group,
      userId: session.user.id,
      userName: session.user.name,
      isCreator: true,
    );
    return group;
  }

  Future<Group> joinGroup({
    required String groupCode,
    required String userName,
  }) async {
    final session = _requireAuthenticatedSession();
    final payload = buildJoinGroupPayload(
      groupCode: groupCode,
      userName: userName.isNotEmpty ? userName : session.user.name,
    );
    final response = await SocketService.instance.emitGroupRequest(
      'join_group',
      payload,
    );
    final group = Group.fromJson(
      Map<String, dynamic>.from(response['group'] as Map),
    );
    await AppSessionService.instance.saveGroupSession(
      group: group,
      userId: session.user.id,
      userName: session.user.name,
      isCreator: false,
    );
    return group;
  }

  Future<Group> rejoinGroup(SavedGroupSession session) async {
    _requireAuthenticatedSession();
    final response = await SocketService.instance.emitGroupRequest(
      'rejoin_group',
      {'groupCode': session.groupCode},
    );
    return Group.fromJson(
      Map<String, dynamic>.from(response['group'] as Map),
    );
  }
}