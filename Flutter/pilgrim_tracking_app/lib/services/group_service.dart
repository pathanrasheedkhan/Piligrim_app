import '../models/group.dart';
import 'app_session_service.dart';
import 'socket_service.dart';

class GroupService {
  GroupService._();

  static final GroupService instance = GroupService._();

  Future<Group> createGroup({
    required String groupName,
    required int maxMembers,
    String userName = 'Creator',
  }) async {
    final socketService = SocketService.instance;
    final userId = await socketService.getUserId();
    final response = await socketService.emitGroupRequest('create_group', {
      'groupName': groupName,
      'maxMembers': maxMembers,
      'userId': userId,
      'userName': userName,
    });
    final group = Group.fromJson(
      Map<String, dynamic>.from(response['group'] as Map),
    );
    await AppSessionService.instance.saveGroupSession(
      group: group,
      userId: userId,
      userName: userName,
      isCreator: true,
    );
    return group;
  }

  Future<Group> joinGroup({
    required String groupCode,
    required String userName,
  }) async {
    final socketService = SocketService.instance;
    final userId = await socketService.getUserId();
    final response = await socketService.emitGroupRequest('join_group', {
      'groupCode': groupCode,
      'userId': userId,
      'userName': userName,
    });
    final group = Group.fromJson(
      Map<String, dynamic>.from(response['group'] as Map),
    );
    await AppSessionService.instance.saveGroupSession(
      group: group,
      userId: userId,
      userName: userName,
      isCreator: false,
    );
    return group;
  }

  Future<Group> rejoinGroup(SavedGroupSession session) async {
    final response = await SocketService.instance.emitGroupRequest(
      'rejoin_group',
      {'groupCode': session.groupCode, 'userId': session.userId},
    );
    return Group.fromJson(
      Map<String, dynamic>.from(response['group'] as Map),
    );
  }
}