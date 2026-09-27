class GroupMember {
  const GroupMember({required this.userId, required this.name});

  final String userId;
  final String name;

  factory GroupMember.fromJson(Map<String, dynamic> json) {
    return GroupMember(
      userId: json['userId'] as String,
      name: json['userName'] as String,
    );
  }
}

class Group {
  Group({
    required this.groupId,
    required this.groupCode,
    required this.groupName,
    required this.maxMembers,
    required this.members,
  });

  final String groupId;
  final String groupCode;
  final String groupName;
  final int maxMembers;
  final List<GroupMember> members;

  factory Group.fromJson(Map<String, dynamic> json) {
    return Group(
      groupId: json['groupId'] as String,
      groupCode: json['groupCode'] as String,
      groupName: json['groupName'] as String,
      maxMembers: json['maxMembers'] as int,
      members: (json['members'] as List<dynamic>)
          .map((member) => GroupMember.fromJson(
                Map<String, dynamic>.from(member as Map),
              ))
          .toList(),
    );
  }
}