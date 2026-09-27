class MeetingPoint {
  const MeetingPoint({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;

  static MeetingPoint? tryParse(dynamic data) {
    if (data is! Map || data['latitude'] is! num || data['longitude'] is! num) {
      return null;
    }

    final latitude = (data['latitude'] as num).toDouble();
    final longitude = (data['longitude'] as num).toDouble();
    if (!latitude.isFinite || latitude < -90 || latitude > 90) return null;
    if (!longitude.isFinite || longitude < -180 || longitude > 180) return null;
    return MeetingPoint(latitude: latitude, longitude: longitude);
  }
}