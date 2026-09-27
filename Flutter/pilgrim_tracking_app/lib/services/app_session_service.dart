import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/group.dart';

class SavedGroupSession {
  const SavedGroupSession({
    required this.groupCode,
    required this.groupName,
    required this.userId,
    required this.userName,
    required this.maxMembers,
    required this.isCreator,
    required this.enteredMap,
  });

  final String groupCode;
  final String groupName;
  final String userId;
  final String userName;
  final int maxMembers;
  final bool isCreator;
  final bool enteredMap;

  Map<String, dynamic> toJson() => {
    'groupCode': groupCode,
    'groupName': groupName,
    'userId': userId,
    'userName': userName,
    'maxMembers': maxMembers,
    'isCreator': isCreator,
    'enteredMap': enteredMap,
  };

  SavedGroupSession copyWith({bool? enteredMap}) => SavedGroupSession(
    groupCode: groupCode,
    groupName: groupName,
    userId: userId,
    userName: userName,
    maxMembers: maxMembers,
    isCreator: isCreator,
    enteredMap: enteredMap ?? this.enteredMap,
  );

  static SavedGroupSession? tryParse(dynamic value) {
    if (value is! Map) return null;
    final data = Map<String, dynamic>.from(value);
    final groupCode = data['groupCode'];
    final groupName = data['groupName'];
    final userId = data['userId'];
    final userName = data['userName'];
    final maxMembers = data['maxMembers'];
    final isCreator = data['isCreator'];
    final enteredMap = data['enteredMap'];
    if (groupCode is! String || !RegExp(r'^\d{6}$').hasMatch(groupCode)) {
      return null;
    }
    if (groupName is! String || groupName.trim().isEmpty) return null;
    if (userId is! String || userId.trim().isEmpty) return null;
    if (userName is! String || userName.trim().isEmpty) return null;
    if (maxMembers is! int || maxMembers < 2 || maxMembers > 6) return null;
    if (isCreator is! bool || enteredMap is! bool) return null;
    return SavedGroupSession(
      groupCode: groupCode,
      groupName: groupName,
      userId: userId,
      userName: userName,
      maxMembers: maxMembers,
      isCreator: isCreator,
      enteredMap: enteredMap,
    );
  }
}

class AppSessionService {
  AppSessionService._();

  static final AppSessionService instance = AppSessionService._();

  static const _userIdKey = 'pilgrim_tracking_user_id';
  static const _groupSessionKey = 'pilgrim_tracking_group_session';

  Future<String> getOrCreateUserId() async {
    final preferences = await SharedPreferences.getInstance();
    final existing = preferences.getString(_userIdKey);
    if (existing != null && existing.isNotEmpty) return existing;

    final userId = _generateUserId();
    await preferences.setString(_userIdKey, userId);
    return userId;
  }

  Future<void> saveGroupSession({
    required Group group,
    required String userId,
    required String userName,
    required bool isCreator,
  }) async {
    final session = SavedGroupSession(
      groupCode: group.groupCode,
      groupName: group.groupName,
      userId: userId,
      userName: userName,
      maxMembers: group.maxMembers,
      isCreator: isCreator,
      enteredMap: false,
    );
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(_groupSessionKey, jsonEncode(session.toJson()));
  }

  Future<SavedGroupSession?> loadGroupSession() async {
    final preferences = await SharedPreferences.getInstance();
    final encoded = preferences.getString(_groupSessionKey);
    if (encoded == null) return null;

    try {
      final session = SavedGroupSession.tryParse(jsonDecode(encoded));
      if (session != null) return session;
    } on FormatException {
      // Invalid local data is discarded below.
    }
    await preferences.remove(_groupSessionKey);
    return null;
  }

  Future<void> markMapEntered() async {
    final session = await loadGroupSession();
    if (session == null) return;
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(
      _groupSessionKey,
      jsonEncode(session.copyWith(enteredMap: true).toJson()),
    );
  }

  Future<void> clearGroupSession() async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.remove(_groupSessionKey);
  }

  String _generateUserId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final value = bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${value.substring(0, 8)}-${value.substring(8, 12)}-'
        '${value.substring(12, 16)}-${value.substring(16, 20)}-'
        '${value.substring(20)}';
  }
}