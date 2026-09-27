import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../models/group.dart';
import '../models/meeting_point.dart';
import '../models/member_location.dart';
import '../services/app_session_service.dart';
import '../services/socket_service.dart';

class MapScreen extends StatefulWidget {
  const MapScreen({this.group, this.onLeave, super.key});

  final Group? group;
  final VoidCallback? onLeave;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> {
  final MapController _mapController = MapController();
  StreamSubscription<Position>? _positionSubscription;
  StreamSubscription<bool>? _connectionSubscription;
  StreamSubscription<Map<String, MemberLocation>>? _memberLocationSubscription;
  StreamSubscription<Map<String, dynamic>>? _memberJoinedSubscription;
  StreamSubscription<MeetingPoint?>? _meetingPointSubscription;
  StateSetter? _memberPanelSetState;
  Map<String, MemberLocation> _memberLocations = {};
  MeetingPoint? _meetingPoint;
  Position? _currentUserPosition;
  String? _currentUserId;
  String? _currentUserName;
  String? _locationMessage;
  bool _isLoadingLocation = false;
  bool _isSelectingMeetingPoint = false;
  bool _showAppSettingsAction = false;
  bool _showLocationSettingsAction = false;

  @override
  void initState() {
    super.initState();
    final socketService = SocketService.instance;
    _memberLocations = socketService.memberLocations;
    _meetingPoint = socketService.meetingPoint;
    _meetingPointSubscription = socketService.meetingPointChanges.listen((
      meetingPoint,
    ) {
      if (!mounted) return;
      setState(() => _meetingPoint = meetingPoint);
    });
    _memberLocationSubscription = socketService.memberLocationChanges.listen((
      locations,
    ) {
      if (!mounted) return;
      setState(() => _memberLocations = locations);
      _memberPanelSetState?.call(() {});
    });
    _memberJoinedSubscription = socketService.memberJoined.listen(
      _onMemberJoined,
    );
    _connectionSubscription = SocketService.instance.connectionChanges.listen((
      connected,
    ) {
      if (connected) _sendCurrentUserPosition();
    });
    if (widget.group != null) _initializeCurrentUser();
    _locateUser(centerMap: true);
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _connectionSubscription?.cancel();
    _memberLocationSubscription?.cancel();
    _memberJoinedSubscription?.cancel();
    _meetingPointSubscription?.cancel();
    _mapController.dispose();
    super.dispose();
  }

  void _onMemberJoined(Map<String, dynamic> event) {
    final group = widget.group;
    if (group == null || event['groupCode'] != group.groupCode) return;

    final member = GroupMember.fromJson(event);
    if (group.members.any((existing) => existing.userId == member.userId)) {
      return;
    }

    setState(() => group.members.add(member));
    _memberPanelSetState?.call(() {});
  }

  Future<void> _showGroupMembers() async {
    final group = widget.group;
    if (group == null) return;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (context, setSheetState) {
          _memberPanelSetState = setSheetState;
          return _buildMemberPanel(context, sheetContext, group);
        },
      ),
    );
    _memberPanelSetState = null;
  }

  Widget _buildMemberPanel(
    BuildContext context,
    BuildContext sheetContext,
    Group group,
  ) {
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.75,
      ),
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.outlineVariant,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                group.groupName,
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 4),
              Text('${group.members.length} members'),
              const Divider(height: 24),
              for (final member in group.members)
                _buildMemberTile(context, sheetContext, member),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildMemberTile(
    BuildContext context,
    BuildContext sheetContext,
    GroupMember member,
  ) {
    final isCurrentUser = member.userId == _currentUserId;
    final location = _memberLocations[member.userId];
    final hasLocation = isCurrentUser
        ? _currentUserPosition != null
        : location != null;

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        Icons.circle,
        size: 10,
        color: hasLocation ? Colors.green.shade600 : Colors.amber.shade700,
      ),
      title: Text(member.name),
      subtitle: Text(
        isCurrentUser
            ? hasLocation
                  ? 'You • Location active'
                  : 'You • Location unavailable'
            : hasLocation
            ? 'Location active'
            : 'Location unavailable',
      ),
      onTap: isCurrentUser
          ? null
          : () {
              if (location == null) {
                final messenger = ScaffoldMessenger.of(this.context);
                Navigator.of(sheetContext).pop();
                messenger.showSnackBar(
                  SnackBar(
                    content: Text('Location unavailable for ${member.name}'),
                  ),
                );
                return;
              }

              Navigator.of(sheetContext).pop();
              _mapController.move(
                LatLng(location.latitude, location.longitude),
                16,
              );
            },
    );
  }

  Future<void> _locateUser({bool centerMap = false}) async {
    if (_isLoadingLocation) return;
    setState(() {
      _isLoadingLocation = true;
      _locationMessage = null;
      _showAppSettingsAction = false;
      _showLocationSettingsAction = false;
    });

    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        _setLocationMessage(
          'Location services are off. Turn them on to show your position.',
          showLocationSettingsAction: !kIsWeb,
        );
        return;
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }

      if (permission == LocationPermission.denied) {
        _setLocationMessage(
          kIsWeb
              ? 'Location access was denied. Allow it in your browser site settings.'
              : 'Location permission was denied. Tap My Location to try again.',
        );
        return;
      }

      if (permission == LocationPermission.deniedForever) {
        _setLocationMessage(
          kIsWeb
              ? 'Location access is blocked. Allow it in your browser site settings, then reload.'
              : 'Location permission is blocked. Enable it in app settings.',
          showAppSettingsAction: !kIsWeb,
        );
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 20),
        ),
      );
      if (!mounted) return;

      _updateCurrentUserPosition(position);
      if (centerMap) _moveToPosition(position);

      await _positionSubscription?.cancel();
      _positionSubscription =
          Geolocator.getPositionStream(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.high,
              distanceFilter: 10,
            ),
          ).listen(
            (updatedPosition) {
              _updateCurrentUserPosition(updatedPosition);
            },
            onError: (_) {
              if (mounted) {
                _setLocationMessage('Unable to keep your location up to date.');
              }
            },
          );
    } on TimeoutException {
      _setLocationMessage('Could not get a GPS fix. Try My Location again.');
    } catch (_) {
      _setLocationMessage(
        kIsWeb
            ? 'Could not get your location. Check browser permission and try again.'
            : 'Could not get your location. Check location settings and try again.',
      );
    } finally {
      if (mounted) setState(() => _isLoadingLocation = false);
    }
  }

  Future<void> _initializeCurrentUser() async {
    final group = widget.group;
    if (group == null) return;

    try {
      final socketService = SocketService.instance;
      final userId = await socketService.getUserId();
      if (!mounted) return;
      String? userName;
      for (final member in group.members) {
        if (member.userId == userId) {
          userName = member.name;
          break;
        }
      }
      if (userName == null) {
        debugPrint('Current socket user is not a member of this group');
        return;
      }

      setState(() {
        _currentUserId = userId;
        _currentUserName = userName;
      });
      _memberPanelSetState?.call(() {});
      socketService.setCurrentUserId(userId);
      _sendCurrentUserPosition();
    } catch (error) {
      debugPrint('Unable to prepare location sharing: $error');
    }
  }

  void _updateCurrentUserPosition(Position position) {
    if (!mounted) return;
    setState(() => _currentUserPosition = position);
    _memberPanelSetState?.call(() {});
    debugPrint(
      'GPS position: latitude=${position.latitude} '
      'longitude=${position.longitude}',
    );
    _sendCurrentUserPosition();
  }

  void _sendCurrentUserPosition() {
    final group = widget.group;
    final position = _currentUserPosition;
    final userId = _currentUserId;
    final userName = _currentUserName;
    if (group == null ||
        position == null ||
        userId == null ||
        userName == null) {
      return;
    }

    SocketService.instance.sendLocationUpdate({
      'groupCode': group.groupCode,
      'userId': userId,
      'userName': userName,
      'latitude': position.latitude,
      'longitude': position.longitude,
    });
  }

  void _setLocationMessage(
    String message, {
    bool showAppSettingsAction = false,
    bool showLocationSettingsAction = false,
  }) {
    if (!mounted) return;
    setState(() {
      _locationMessage = message;
      _showAppSettingsAction = showAppSettingsAction;
      _showLocationSettingsAction = showLocationSettingsAction;
    });
  }

  void _moveToPosition(Position position) {
    _mapController.move(LatLng(position.latitude, position.longitude), 16);
  }

  void _showAllMembers() {
    final locations = <LatLng>[
      if (_currentUserPosition case final position?)
        LatLng(position.latitude, position.longitude),
      for (final member in _memberLocations.values)
        if (member.userId != _currentUserId)
          LatLng(member.latitude, member.longitude),
    ];

    if (locations.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No member locations are available yet.')),
      );
      return;
    }

    if (locations.length == 1) {
      _mapController.move(locations.single, 16);
      return;
    }

    _mapController.fitCamera(
      CameraFit.bounds(
        bounds: LatLngBounds.fromPoints(locations),
        padding: const EdgeInsets.all(64),
      ),
    );
  }

  bool get _isGroupCreator {
    final group = widget.group;
    return group != null &&
        group.members.isNotEmpty &&
        group.members.first.userId == _currentUserId;
  }

  List<Polyline> get _leaderConnectionPolylines {
    final group = widget.group;
    final creatorUserId = group?.members.firstOrNull?.userId;
    final currentUserId = _currentUserId;
    final currentLocation = _currentUserPosition == null
        ? null
        : LatLng(_currentUserPosition!.latitude, _currentUserPosition!.longitude);
    final creatorLocation = creatorUserId == null || creatorUserId == currentUserId
        ? null
        : _memberLocations[creatorUserId] == null
        ? null
        : LatLng(
            _memberLocations[creatorUserId]!.latitude,
            _memberLocations[creatorUserId]!.longitude,
          );

    if (currentLocation == null || creatorLocation == null) {
      return const [];
    }

    return [
      Polyline(
        points: [currentLocation, creatorLocation],
        strokeWidth: 2.0,
        color: Colors.deepPurple.withValues(alpha: 0.8),
        borderStrokeWidth: 0,
        borderColor: Colors.transparent,
      ),
    ];
  }

  Future<void> _confirmMeetingPoint(LatLng point) async {
    final group = widget.group;
    final userId = _currentUserId;
    if (group == null || userId == null) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Set meeting point?'),
        content: Text(
          '${point.latitude.toStringAsFixed(5)}, '
          '${point.longitude.toStringAsFixed(5)}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Confirm'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;

    setState(() => _isSelectingMeetingPoint = false);
    try {
      final response = await SocketService.instance.emitGroupRequest(
        'set_meeting_point',
        {
          'groupCode': group.groupCode,
          'userId': userId,
          'latitude': point.latitude,
          'longitude': point.longitude,
        },
      );
      SocketService.instance.updateMeetingPointFromResponse(response);
    } on SocketServiceException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
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
    SocketService.instance.connect();
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
        title: const Text('Group Map'),
        actions: [
          if (widget.group != null)
            IconButton(
              tooltip: 'Leave group',
              onPressed: _leaveGroup,
              icon: const Icon(Icons.exit_to_app),
            ),
          if (_isGroupCreator)
            TextButton.icon(
              onPressed: () {
                setState(() {
                  _isSelectingMeetingPoint = !_isSelectingMeetingPoint;
                });
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(
                      _isSelectingMeetingPoint
                          ? 'Tap the map to select a meeting point.'
                          : 'Meeting point selection cancelled.',
                    ),
                  ),
                );
              },
              icon: Icon(
                _isSelectingMeetingPoint ? Icons.close : Icons.star_outline,
              ),
              label: Text(
                _isSelectingMeetingPoint
                    ? 'Cancel Selection'
                    : 'Set Meeting Point',
              ),
            ),
          if (widget.group != null)
            TextButton.icon(
              onPressed: _showGroupMembers,
              icon: const Icon(Icons.groups_outlined),
              label: const Text('Members'),
            ),
        ],
      ),
      body: Stack(
        children: [
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: LatLng(14.4673, 78.8242),
              initialZoom: 13,
              onTap: (tapPosition, point) {
                if (_isSelectingMeetingPoint) {
                  _confirmMeetingPoint(point);
                }
              },
            ),
            children: [
              TileLayer(
                urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                userAgentPackageName: 'com.example.pilgrim_tracking_app',
              ),
              if (_currentUserPosition case final position?)
                MarkerLayer(
                  markers: [
                    Marker(
                      point: LatLng(position.latitude, position.longitude),
                      width: 48,
                      height: 48,
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.blue.shade600,
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 4),
                          boxShadow: const [
                            BoxShadow(color: Colors.black26, blurRadius: 8),
                          ],
                        ),
                        child: const Icon(
                          Icons.navigation,
                          color: Colors.white,
                          size: 24,
                        ),
                      ),
                    ),
                  ],
                ),
              MarkerLayer(
                markers: [
                  for (final member in _memberLocations.values)
                    if (member.userId != _currentUserId)
                      Marker(
                        point: LatLng(member.latitude, member.longitude),
                        width: 120,
                        height: 76,
                        alignment: Alignment.bottomCenter,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              constraints: const BoxConstraints(maxWidth: 112),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                border: Border.all(
                                  color: Colors.deepOrange.shade700,
                                ),
                                borderRadius: BorderRadius.circular(6),
                                boxShadow: const [
                                  BoxShadow(
                                    color: Colors.black26,
                                    blurRadius: 4,
                                  ),
                                ],
                              ),
                              child: Text(
                                member.userName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                  color: Colors.black87,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            Icon(
                              Icons.location_on,
                              color: Colors.deepOrange.shade700,
                              size: 32,
                            ),
                          ],
                        ),
                      ),
                ],
              ),
              PolylineLayer(
                polylines: _leaderConnectionPolylines,
              ),
              if (_meetingPoint case final meetingPoint?)
                MarkerLayer(
                  markers: [
                    Marker(
                      point: LatLng(
                        meetingPoint.latitude,
                        meetingPoint.longitude,
                      ),
                      width: 132,
                      height: 76,
                      alignment: Alignment.bottomCenter,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 4,
                            ),
                            decoration: BoxDecoration(
                              color: Colors.amber.shade100,
                              border: Border.all(color: Colors.amber.shade800),
                              borderRadius: BorderRadius.circular(6),
                              boxShadow: const [
                                BoxShadow(color: Colors.black26, blurRadius: 4),
                              ],
                            ),
                            child: const Text(
                              'Meeting Point',
                              maxLines: 1,
                              style: TextStyle(
                                color: Colors.black87,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          Icon(
                            Icons.star,
                            color: Colors.amber.shade800,
                            size: 34,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              const SimpleAttributionWidget(
                source: Text('OpenStreetMap contributors'),
              ),
            ],
          ),
          if (_locationMessage case final message?)
            Positioned(
              top: 12,
              left: 12,
              right: 12,
              child: Material(
                elevation: 3,
                borderRadius: BorderRadius.circular(8),
                color: Theme.of(context).colorScheme.surface,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 10,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(message),
                      if (_showAppSettingsAction)
                        TextButton(
                          onPressed: Geolocator.openAppSettings,
                          child: const Text('Open app settings'),
                        ),
                      if (_showLocationSettingsAction)
                        TextButton(
                          onPressed: Geolocator.openLocationSettings,
                          child: const Text('Open location settings'),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          Positioned(
            right: 16,
            bottom: 20,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                FloatingActionButton.extended(
                  heroTag: 'show-all-members',
                  onPressed: _showAllMembers,
                  icon: const Icon(Icons.zoom_out_map),
                  label: const Text('Show All Members'),
                ),
                const SizedBox(height: 12),
                FloatingActionButton.extended(
                  heroTag: 'my-location',
                  onPressed: _isLoadingLocation
                      ? null
                      : () async {
                          if (_currentUserPosition == null) {
                            await _locateUser(centerMap: true);
                          } else {
                            _moveToPosition(_currentUserPosition!);
                          }
                        },
                  icon: _isLoadingLocation
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.my_location),
                  label: const Text('My Location'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
