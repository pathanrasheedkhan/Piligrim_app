// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:pilgrim_tracking_app/main.dart';
import 'package:pilgrim_tracking_app/models/group.dart';
import 'package:pilgrim_tracking_app/screens/map_screen.dart';
import 'package:pilgrim_tracking_app/services/app_session_service.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('Home screen shows group actions', (WidgetTester tester) async {
    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    expect(find.text('Pilgrim Tracking'), findsOneWidget);
    expect(find.text('Create a Group'), findsOneWidget);
    expect(find.text('Join a Group'), findsOneWidget);
  });

  testWidgets('Create group validates fields and reports missing backend', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Create a Group'));
    await tester.pumpAndSettle();

    expect(find.text('Group Name'), findsOneWidget);
    expect(find.text('Number of Members'), findsOneWidget);
    expect(find.byType(FlutterMap), findsNothing);

    await tester.tap(find.text('Create Group'));
    await tester.pumpAndSettle();
    expect(find.text('Enter a group name'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField), 'Pilgrim Friends');
    await tester.tap(find.byType(DropdownButtonFormField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('6 members'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create Group'));
    await tester.pumpAndSettle();

    expect(
      find.text('The server connection has not been initialized.'),
      findsOneWidget,
    );
  });

  testWidgets('Join group validates fields and reports missing backend', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Join a Group'));
    await tester.pumpAndSettle();
    final textFields = find.byType(TextFormField);

    await tester.tap(find.text('Join Group'));
    await tester.pumpAndSettle();
    expect(find.text('Enter your name'), findsOneWidget);
    expect(find.text('Enter exactly 6 digits'), findsOneWidget);

    await tester.enterText(textFields.at(0), 'Samira');
    await tester.enterText(textFields.at(1), '12345');
    await tester.tap(find.text('Join Group'));
    await tester.pumpAndSettle();
    expect(find.text('Enter exactly 6 digits'), findsOneWidget);

    await tester.enterText(textFields.at(1), '123456');
    await tester.tap(find.text('Join Group'));
    await tester.pumpAndSettle();
    expect(
      find.text('The server connection has not been initialized.'),
      findsOneWidget,
    );
  });

  testWidgets('Map screen still renders OpenStreetMap', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: MapScreen()));
    await tester.pump();

    expect(find.byType(FlutterMap), findsOneWidget);
    expect(find.text('OpenStreetMap contributors'), findsOneWidget);
  });

  test('saved group sessions reuse the stable user ID and omit locations', () async {
    final sessionService = AppSessionService.instance;
    final firstUserId = await sessionService.getOrCreateUserId();
    final secondUserId = await sessionService.getOrCreateUserId();
    expect(secondUserId, firstUserId);

    final group = Group(
      groupId: 'group-1',
      groupCode: '123456',
      groupName: 'Tirupati Trip',
      maxMembers: 4,
      members: [GroupMember(userId: firstUserId, name: 'Rasheed')],
    );
    await sessionService.saveGroupSession(
      group: group,
      userId: firstUserId,
      userName: 'Rasheed',
      isCreator: true,
    );
    await sessionService.markMapEntered();

    final restored = await sessionService.loadGroupSession();
    expect(restored?.groupCode, '123456');
    expect(restored?.userId, firstUserId);
    expect(restored?.userName, 'Rasheed');
    expect(restored?.maxMembers, 4);
    expect(restored?.isCreator, isTrue);
    expect(restored?.enteredMap, isTrue);

    final preferences = await SharedPreferences.getInstance();
    expect(preferences.getKeys(), {
      'pilgrim_tracking_user_id',
      'pilgrim_tracking_group_session',
    });
    await sessionService.clearGroupSession();
    expect(await sessionService.loadGroupSession(), isNull);
  });

  testWidgets('Map member panel shows group roster and location status', (
    WidgetTester tester,
  ) async {
    final group = Group(
      groupId: 'group-1',
      groupCode: '123456',
      groupName: 'Tirupati Trip',
      maxMembers: 6,
      members: const [
        GroupMember(userId: 'rasheed', name: 'Rasheed'),
        GroupMember(userId: 'ahmed', name: 'Ahmed'),
        GroupMember(userId: 'imran', name: 'Imran'),
      ],
    );

    await tester.pumpWidget(MaterialApp(home: MapScreen(group: group)));
    await tester.pump();
    expect(find.text('Members'), findsOneWidget);
    expect(find.text('Show All Members'), findsOneWidget);
    await tester.tap(find.text('Show All Members'));
    await tester.pump();
    expect(find.text('No member locations are available yet.'), findsOneWidget);
    await tester.tap(find.text('Members'));
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Tirupati Trip'), findsOneWidget);
    expect(find.text('3 members'), findsOneWidget);
    expect(find.text('Rasheed'), findsOneWidget);
    expect(find.text('Ahmed'), findsOneWidget);
    expect(find.text('Imran'), findsOneWidget);
    expect(find.text('Location unavailable'), findsNWidgets(3));
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is Icon &&
            widget.icon == Icons.circle &&
            widget.color == Colors.amber.shade700,
      ),
      findsNWidgets(3),
    );
  });
}
