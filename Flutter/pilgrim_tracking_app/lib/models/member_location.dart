class MemberLocation {
  const MemberLocation({
    required this.userId,
    required this.userName,
    required this.latitude,
    required this.longitude,
  });

  final String userId;
  final String userName;
  final double latitude;
  final double longitude;

  static MemberLocation? tryParse(dynamic value) {
    if (value is! Map) return null;
    final userId = value['userId'];
    final userName = value['userName'];
    final latitude = value['latitude'];
    final longitude = value['longitude'];
    if (userId is! String ||
        userName is! String ||
        latitude is! num ||
        longitude is! num ||
        !latitude.isFinite ||
        !longitude.isFinite) {
      return null;
    }

    return MemberLocation(
      userId: userId,
      userName: userName,
      latitude: latitude.toDouble(),
      longitude: longitude.toDouble(),
    );
  }
}
