import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../models/meeting_point.dart';
import '../models/member_location.dart';
import 'app_session_service.dart';

class SocketServiceException implements Exception {
  const SocketServiceException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

class SocketService {
  SocketService._();

  static final SocketService instance = SocketService._();

  io.Socket? _socket;
  final StreamController<Map<String, dynamic>> _memberJoinedController =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<bool> _connectionController =
      StreamController<bool>.broadcast();
  final StreamController<Map<String, MemberLocation>>
  _memberLocationsController =
      StreamController<Map<String, MemberLocation>>.broadcast();
    final StreamController<MeetingPoint?> _meetingPointController =
      StreamController<MeetingPoint?>.broadcast();
  final Map<String, MemberLocation> _memberLocations = {};
    MeetingPoint? _meetingPoint;
  String? _currentUserId;

  Stream<Map<String, dynamic>> get memberJoined =>
      _memberJoinedController.stream;
  Stream<bool> get connectionChanges => _connectionController.stream;
  Stream<Map<String, MemberLocation>> get memberLocationChanges =>
      _memberLocationsController.stream;
    Stream<MeetingPoint?> get meetingPointChanges =>
      _meetingPointController.stream;
  Map<String, MemberLocation> get memberLocations =>
      Map.unmodifiable(_memberLocations);
    MeetingPoint? get meetingPoint => _meetingPoint;
  bool get isConnected => _socket?.connected ?? false;

  void setCurrentUserId(String userId) {
    _currentUserId = userId;
    if (_memberLocations.remove(userId) != null) {
      _publishMemberLocations();
    }
  }

  void connect() {
    if (_socket != null) return;

    debugPrint('Socket connecting...');
    const serverUrl = String.fromEnvironment(
      'SOCKET_SERVER_URL',
      defaultValue: 'http://localhost:3000',
    );
    final socket = io.io(
      serverUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .disableAutoConnect()
          .build(),
    );
    _socket = socket;

    socket.onConnect((_) {
      debugPrint('Socket connected: ${socket.id}');
      _connectionController.add(true);
      sendPing();
    });
    socket.onConnectError((error) {
      debugPrint('Socket connection error: $error');
    });
    socket.onDisconnect((_) {
      debugPrint('Socket disconnected');
      _connectionController.add(false);
    });
    socket.on('pong_server', (_) {
      debugPrint('Received pong_server');
    });
    socket.on('member_joined', (data) {
      if (data is Map) {
        _memberJoinedController.add(Map<String, dynamic>.from(data));
      }
    });
    socket.on('member_location_updated', (data) {
      _storeMemberLocation(data);
    });
    socket.on('group_locations', (data) {
      _replaceMemberLocations(data);
    });
    socket.on('meeting_point', _storeMeetingPoint);
    socket.on('meeting_point_updated', _storeMeetingPoint);
    socket.on('member_location_removed', (data) {
      if (data is! Map || data['userId'] is! String) return;
      final userId = data['userId'] as String;
      if (_memberLocations.remove(userId) != null) {
        debugPrint('Member location removed: userId=$userId');
        _publishMemberLocations();
      }
    });
    socket.on('location_update_error', (data) {
      if (data is Map) {
        debugPrint(
          'Location update rejected: ${data['code']} ${data['message']}',
        );
      }
    });

    socket.connect();
  }

  Future<String> getUserId() async {
    return AppSessionService.instance.getOrCreateUserId();
  }

  bool sendLocationUpdate(Map<String, dynamic> payload) {
    final socket = _socket;
    if (socket == null || !socket.connected) return false;

    debugPrint(
      'Sending location: userId=${payload['userId']} '
      'groupCode=${payload['groupCode']}',
    );
    socket.emit('location_update', payload);
    return true;
  }

  void _storeMemberLocation(dynamic data) {
    final location = MemberLocation.tryParse(data);
    if (location == null || location.userId == _currentUserId) return;

    _memberLocations[location.userId] = location;
    debugPrint(
      'Received member location: userId=${location.userId} '
      'latitude=${location.latitude} longitude=${location.longitude}',
    );
    _publishMemberLocations();
  }

  void _replaceMemberLocations(dynamic data) {
    if (data is! Map || data['locations'] is! List) return;

    _memberLocations.clear();
    for (final value in data['locations'] as List) {
      final location = MemberLocation.tryParse(value);
      if (location == null || location.userId == _currentUserId) continue;
      _memberLocations[location.userId] = location;
      debugPrint(
        'Received member location: userId=${location.userId} '
        'latitude=${location.latitude} longitude=${location.longitude}',
      );
    }
    _publishMemberLocations();
  }

  void _publishMemberLocations() {
    _memberLocationsController.add(Map.unmodifiable(_memberLocations));
  }

  void _storeMeetingPoint(dynamic data) {
    final meetingPoint = MeetingPoint.tryParse(data);
    if (meetingPoint == null) return;
    _meetingPoint = meetingPoint;
    _meetingPointController.add(meetingPoint);
  }

  Future<Map<String, dynamic>> emitGroupRequest(
    String event,
    Map<String, dynamic> payload,
  ) async {
    final socket = await _connectedSocket();
    final dynamic response;
    try {
        if (event == 'create_group' ||
          event == 'join_group' ||
          event == 'rejoin_group') {
        _meetingPoint = null;
        _meetingPointController.add(null);
      }
        response = await socket
          .emitWithAckAsync(event, payload)
          .timeout(const Duration(seconds: 12));
    } on TimeoutException {
      throw const SocketServiceException(
        'REQUEST_TIMEOUT',
        'The server did not respond. Please try again.',
      );
    } catch (error) {
      throw SocketServiceException('CONNECTION_ERROR', error.toString());
    }

    if (response is! Map) {
      throw const SocketServiceException(
        'INVALID_RESPONSE',
        'The server returned an invalid response.',
      );
    }
    final result = Map<String, dynamic>.from(response);
    if (result['success'] != true) {
      final error = result['error'];
      if (error is Map) {
        throw SocketServiceException(
          error['code'] as String? ?? 'GROUP_REQUEST_FAILED',
          error['message'] as String? ?? 'Unable to process group request',
        );
      }
      throw const SocketServiceException(
        'GROUP_REQUEST_FAILED',
        'Unable to process group request',
      );
    }
    return result;
  }

  Future<io.Socket> _connectedSocket() async {
    final socket = _socket;
    if (socket == null) {
      throw const SocketServiceException(
        'NOT_INITIALIZED',
        'The server connection has not been initialized.',
      );
    }
    if (socket.connected) return socket;

    final completer = Completer<void>();
    void onConnect(dynamic _) {
      if (!completer.isCompleted) completer.complete();
    }

    void onConnectError(dynamic error) {
      if (!completer.isCompleted) {
        completer.completeError(
          SocketServiceException('CONNECTION_ERROR', error.toString()),
        );
      }
    }

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.connect();
    try {
      await completer.future.timeout(const Duration(seconds: 12));
    } on TimeoutException {
      throw const SocketServiceException(
        'CONNECTION_TIMEOUT',
        'Could not connect to the server. Check that it is running.',
      );
    } finally {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    }
    return socket;
  }

  void updateMeetingPointFromResponse(Map<String, dynamic> response) {
    _storeMeetingPoint(response['meetingPoint']);
  }

  void sendPing() {
    final socket = _socket;
    if (socket == null || !socket.connected) {
      debugPrint('Cannot send ping_server: socket is not connected');
      return;
    }

    debugPrint('Sending ping_server');
    socket.emit('ping_server');
  }

  void disconnect() {
    final socket = _socket;
    if (socket == null) return;

    socket.disconnect();
    socket.dispose();
    _socket = null;
  }
}
