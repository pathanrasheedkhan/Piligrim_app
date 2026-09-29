const assert = require('node:assert/strict');
const test = require('node:test');

const GroupService = require('../services/group_service');
const registerGroupSocketHandlers = require('../sockets/group_socket_handlers');

function createTestDatabase() {
  const users = new Map();
  const groups = new Map();
  const memberships = new Set();
  const meetingPoints = new Map();
  const statements = [];
  const databaseAccess = {
    memberships,
    statements,
    failMembershipUserId: null,
    failMeetingPointUpsert: false,
    failGroupRestore: false,
    meetingPoints,
  };
  databaseAccess.withTransaction = async (callback) => callback({
      query: async (statement, params = []) => {
        statements.push(statement);
        const sql = statement.replace(/\s+/g, ' ').trim();
        if (sql.startsWith('INSERT INTO users')) {
          if (!users.has(params[0])) users.set(params[0], params[1]);
        } else if (sql.startsWith('INSERT INTO groups')) {
          groups.set(params[1], {
            id: params[0],
            groupCode: params[1],
            groupName: params[2],
            maxMembers: params[3],
            creatorId: params[4],
          });
        } else if (sql.startsWith('INSERT INTO group_members')) {
          if (databaseAccess.failMembershipUserId === params[1]) {
            throw new Error('membership insert failed');
          }
          memberships.add(`${params[0]}:${params[1]}`);
        } else if (sql.startsWith('INSERT INTO meeting_points')) {
          if (databaseAccess.failMeetingPointUpsert) {
            throw new Error('meeting point persistence failed');
          }
          meetingPoints.set(params[0], { latitude: params[1], longitude: params[2] });
        } else if (sql.startsWith('SELECT groups.id, groups.group_code')) {
          if (databaseAccess.failGroupRestore) throw new Error('database unavailable');
          const group = groups.get(params[0]);
          if (!group) return { rows: [] };
          const memberIds = [...memberships]
            .filter((key) => key.startsWith(`${group.id}:`))
            .map((key) => key.slice(group.id.length + 1));
          const rows = (memberIds.length > 0 ? memberIds : [null]).map((userId) => ({
            id: group.id,
            group_code: group.groupCode,
            group_name: group.groupName,
            max_members: group.maxMembers,
            creator_user_id: group.creatorId,
            user_id: userId,
            user_name: userId === null ? null : users.get(userId),
            meeting_point_latitude: meetingPoints.get(group.id)?.latitude ?? null,
            meeting_point_longitude: meetingPoints.get(group.id)?.longitude ?? null,
          }));
          return { rows };
        } else if (sql.startsWith('SELECT id FROM groups')) {
          return { rows: [...groups.values()].some((group) => group.id === params[0])
            ? [{ id: params[0] }]
            : [] };
        } else if (sql.startsWith('SELECT users.name')) {
          const key = `${params[0]}:${params[1]}`;
          return {
            rows: memberships.has(key) ? [{ name: users.get(params[1]) }] : [],
          };
        } else if (sql.startsWith('SELECT COUNT(*)')) {
          const prefix = `${params[0]}:`;
          const memberCount = [...memberships].filter((key) => key.startsWith(prefix)).length;
          return { rows: [{ member_count: String(memberCount) }] };
        }
        return { rows: [] };
      },
    });
  return databaseAccess;
}

function createSocketHarness(databaseAccess = createTestDatabase()) {
  const sockets = [];
  let connectionHandler;
  const io = {
    on(event, handler) {
      if (event === 'connection') connectionHandler = handler;
    },
    to(room) {
      return {
        emit: (event, payload) => {
          for (const recipient of sockets) {
            if (recipient.rooms.has(room)) {
              recipient.serverEvents.push({ event, payload });
            }
          }
        },
      };
    },
  };

  function connect(id, userId = id) {
    const socket = {
      id,
      userId,
      rooms: new Set(),
      serverEvents: [],
      clientHandlers: new Map(),
      on(event, handler) {
        this.clientHandlers.set(event, handler);
      },
      emit(event, payload) {
        this.serverEvents.push({ event, payload });
      },
      async join(room) {
        this.rooms.add(room);
      },
      to(room) {
        return {
          emit: (event, payload) => {
            for (const recipient of sockets) {
              if (recipient !== this && recipient.rooms.has(room)) {
                recipient.serverEvents.push({ event, payload });
              }
            }
          },
        };
      },
      async clientEmit(event, payload) {
        const handler = this.clientHandlers.get(event);
        assert.ok(handler, `No handler registered for ${event}`);
        return new Promise((resolve) => {
          handler(payload, resolve);
        });
      },
      disconnect() {
        this.rooms.clear();
        this.clientHandlers.get('disconnect')();
      },
    };
    sockets.push(socket);
    connectionHandler(socket);
    return socket;
  }

  const groupService = new GroupService(databaseAccess);
  registerGroupSocketHandlers(io, groupService);
  return { connect, groupService, databaseAccess };
}

test('create and join events return groups and notify existing room members', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket');
  const creatorResult = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 4,
    userId: 'creator-socket',
    userName: 'Creator',
  });
  const group = creatorResult.group;

  assert.equal(creatorResult.success, true);
  assert.equal(creator.serverEvents[0].event, 'group_created');
  assert.ok(creator.rooms.has(group.groupCode));

  const member = harness.connect('member-socket');
  const joinResult = await member.clientEmit('join_group', {
    groupCode: group.groupCode,
    userId: 'member-socket',
    userName: 'Ahmed',
  });

  assert.equal(joinResult.success, true);
  assert.equal(joinResult.group.members.length, 2);
  assert.ok(member.rooms.has(group.groupCode));
  assert.deepEqual(
    creator.serverEvents.find((event) => event.event === 'member_joined')?.payload,
    { userId: 'member-socket', userName: 'Ahmed', groupCode: group.groupCode },
  );
  assert.equal(member.serverEvents[0].event, 'group_joined');
  assert.deepEqual(member.serverEvents[1], {
    event: 'group_locations',
    payload: { groupCode: group.groupCode, locations: [] },
  });
  assert.equal(
    member.serverEvents.some((event) => event.event === 'member_joined'),
    false,
  );
});

test('authenticated socket identity is used for create and join instead of client-controlled ids', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'user-a');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Auth Group',
    maxMembers: 3,
    userId: 'attacker-user',
    userName: 'Attacker',
  });

  assert.equal(created.success, true);
  assert.equal(created.group.creatorId, 'user-a');
  assert.equal(created.group.members[0].userId, 'user-a');

  const member = harness.connect('member-socket', 'user-b');
  const joined = await member.clientEmit('join_group', {
    groupCode: created.group.groupCode,
    userId: 'fake-member',
    userName: 'Fake Member',
  });

  assert.equal(joined.success, true);
  assert.equal(joined.group.members.some((memberInfo) => memberInfo.userId === 'user-b'), true);
  assert.equal(joined.group.members.some((memberInfo) => memberInfo.userId === 'fake-member'), false);
});

test('meeting-point authorization trusts the authenticated socket user instead of payload identity', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'user-creator');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Meeting Point Group',
    maxMembers: 3,
    userId: 'user-creator',
    userName: 'Creator',
  });

  const member = harness.connect('member-socket', 'user-member');
  await member.clientEmit('join_group', {
    groupCode: created.group.groupCode,
    userId: 'user-member',
    userName: 'Member',
  });

  const unauthorized = await member.clientEmit('set_meeting_point', {
    groupCode: created.group.groupCode,
    userId: 'user-creator',
    latitude: 13.62,
    longitude: 79.41,
  });

  assert.equal(unauthorized.success, false);
  assert.equal(unauthorized.error.code, 'NOT_GROUP_CREATOR');

  const creatorUpdate = await creator.clientEmit('set_meeting_point', {
    groupCode: created.group.groupCode,
    userId: 'attacker-user',
    latitude: 13.63,
    longitude: 79.42,
  });

  assert.equal(creatorUpdate.success, true);
  assert.deepEqual(creatorUpdate.meetingPoint, { latitude: 13.63, longitude: 79.42 });
});

test('create_group reports database failures without emitting success or storing memory state', async () => {
  const harness = createSocketHarness({
    withTransaction: async () => { throw new Error('database unavailable'); },
  });
  const creator = harness.connect('creator-socket');

  const result = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 4,
    userId: 'creator-socket',
    userName: 'Creator',
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INTERNAL_ERROR');
  assert.equal(creator.serverEvents.some((event) => event.event === 'group_created'), false);
  assert.equal(harness.groupService.groups.size, 0);
  assert.equal(creator.rooms.size, 0);
});

test('join_group database failure does not add runtime membership or join the room', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'creator-id');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 3,
    userId: 'creator-id',
    userName: 'Creator',
  });
  const member = harness.connect('member-socket', 'member-id');
  harness.databaseAccess.failMembershipUserId = 'member-id';

  const result = await member.clientEmit('join_group', {
    groupCode: created.group.groupCode,
    userId: 'member-id',
    userName: 'Ahmed',
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INTERNAL_ERROR');
  assert.equal(member.rooms.has(created.group.groupCode), false);
  assert.equal(member.serverEvents.some((event) => event.event === 'group_joined'), false);
  assert.equal(harness.groupService.groups.get(created.group.groupCode).members.length, 1);
});
test('meeting points broadcast to the group, replace old state, and reject members', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'rasheed');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 4,
    userId: 'rasheed',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const ahmed = harness.connect('ahmed-socket', 'ahmed');
  await ahmed.clientEmit('join_group', { groupCode, userId: 'ahmed', userName: 'Ahmed' });
  const imran = harness.connect('imran-socket', 'imran');
  await imran.clientEmit('join_group', { groupCode, userId: 'imran', userName: 'Imran' });

  const firstPoint = { latitude: 13.6288, longitude: 79.4192 };
  const firstResult = await creator.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'rasheed',
    ...firstPoint,
  });
  assert.equal(firstResult.success, true);
  for (const client of [creator, ahmed, imran]) {
    assert.deepEqual(client.serverEvents.findLast(
      (event) => event.event === 'meeting_point_updated',
    )?.payload, firstPoint);
  }

  const secondPoint = { latitude: 13.635, longitude: 79.43 };
  await creator.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'rasheed',
    ...secondPoint,
  });
  for (const client of [creator, ahmed, imran]) {
    assert.deepEqual(client.serverEvents.findLast(
      (event) => event.event === 'meeting_point_updated',
    )?.payload, secondPoint);
  }
  assert.deepEqual(harness.groupService.groups.get(groupCode).meetingPoint, secondPoint);
  assert.deepEqual(harness.databaseAccess.meetingPoints.get(created.group.groupId), secondPoint);

  const newMember = harness.connect('new-member-socket', 'new-member');
  await newMember.clientEmit('join_group', {
    groupCode,
    userId: 'new-member',
    userName: 'New Member',
  });
  assert.deepEqual(newMember.serverEvents.find(
    (event) => event.event === 'meeting_point',
  )?.payload, secondPoint);

  const unauthorized = await ahmed.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'ahmed',
    latitude: 13.7,
    longitude: 79.5,
  });
  assert.equal(unauthorized.error.code, 'NOT_GROUP_CREATOR');
  assert.deepEqual(harness.groupService.groups.get(groupCode).meetingPoint, secondPoint);

  const outsider = harness.connect('outsider-socket', 'outsider');
  const spoofedCreator = await outsider.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'rasheed',
    latitude: 13.7,
    longitude: 79.5,
  });
  assert.equal(spoofedCreator.error.code, 'NOT_GROUP_MEMBER');
  assert.deepEqual(harness.groupService.groups.get(groupCode).meetingPoint, secondPoint);
});

test('meeting-point persistence failure emits an error without success or runtime mutation', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'rasheed');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 3,
    userId: 'rasheed',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const firstPoint = { latitude: 13.6288, longitude: 79.4192 };
  assert.equal((await creator.clientEmit('set_meeting_point', {
    groupCode, userId: 'rasheed', ...firstPoint,
  })).success, true);

  harness.databaseAccess.failMeetingPointUpsert = true;
  const result = await creator.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'rasheed',
    latitude: 13.635,
    longitude: 79.43,
  });

  assert.equal(result.success, false);
  assert.equal(result.error.message, 'meeting point persistence failed');
  assert.deepEqual(harness.groupService.groups.get(groupCode).meetingPoint, firstPoint);
  assert.equal(creator.serverEvents.at(-1).event, 'set_meeting_point_error');
  assert.equal(
    creator.serverEvents.filter((event) => event.event === 'meeting_point_updated').length,
    1,
  );
});

test('rejoin restores group state without duplicating a member', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'stable-creator-id');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 4,
    userId: 'stable-creator-id',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const member = harness.connect('member-socket-before-refresh', 'stable-member-id');
  await member.clientEmit('join_group', {
    groupCode,
    userId: 'stable-member-id',
    userName: 'Ahmed',
  });
  const observer = harness.connect('observer-socket', 'observer-id');
  await observer.clientEmit('join_group', {
    groupCode,
    userId: 'observer-id',
    userName: 'Imran',
  });

  const knownLocations = [
    {
      groupCode,
      userId: 'stable-creator-id',
      userName: 'Rasheed',
      latitude: 13.62,
      longitude: 79.41,
    },
    {
      groupCode,
      userId: 'observer-id',
      userName: 'Imran',
      latitude: 13.63,
      longitude: 79.42,
    },
  ];
  await creator.clientEmit('location_update', knownLocations[0]);
  await observer.clientEmit('location_update', knownLocations[1]);
  const meetingPoint = { latitude: 13.64, longitude: 79.43 };
  await creator.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'stable-creator-id',
    ...meetingPoint,
  });
  member.disconnect();

  const refreshedMember = harness.connect('member-socket-after-refresh', 'stable-member-id');
  const result = await refreshedMember.clientEmit('rejoin_group', {
    groupCode,
    userId: 'stable-member-id',
  });

  assert.equal(result.success, true);
  assert.equal(result.group.members.length, 3);
  assert.equal(
    result.group.members.filter((entry) => entry.userId === 'stable-member-id').length,
    1,
  );
  assert.ok(refreshedMember.rooms.has(groupCode));
  assert.equal(refreshedMember.serverEvents[0].event, 'group_rejoined');
  assert.deepEqual(
    refreshedMember.serverEvents.find((event) => event.event === 'group_locations')?.payload,
    {
      groupCode,
      locations: knownLocations.map(({ groupCode: _groupCode, ...location }) => location),
    },
  );
  assert.deepEqual(
    refreshedMember.serverEvents.find((event) => event.event === 'meeting_point')?.payload,
    meetingPoint,
  );
  assert.deepEqual(
    creator.serverEvents.findLast((event) => event.event === 'member_rejoined')?.payload,
    { userId: 'stable-member-id', userName: 'Ahmed', groupCode },
  );

  const outsider = harness.connect('outsider-socket', 'not-a-member');
  const rejected = await outsider.clientEmit('rejoin_group', {
    groupCode,
    userId: 'not-a-member',
  });
  assert.equal(rejected.error.code, 'NOT_GROUP_MEMBER');
});

test('restart rejoin restores durable group state but starts with empty locations', async () => {
  const originalRuntime = createSocketHarness();
  const creator = originalRuntime.connect('creator-socket-before-restart', 'stable-creator-id');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Restart Pilgrimage',
    maxMembers: 3,
    userId: 'stable-creator-id',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const member = originalRuntime.connect('member-socket-before-restart', 'stable-member-id');
  await member.clientEmit('join_group', {
    groupCode,
    userId: 'stable-member-id',
    userName: 'Ahmed',
  });
  const meetingPoint = { latitude: 13.64, longitude: 79.43 };
  await creator.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'stable-creator-id',
    ...meetingPoint,
  });
  await creator.clientEmit('location_update', {
    groupCode,
    userId: 'stable-creator-id',
    userName: 'Rasheed',
    latitude: 13.62,
    longitude: 79.41,
  });

  const restartedRuntime = createSocketHarness(originalRuntime.databaseAccess);
  assert.equal(restartedRuntime.groupService.groups.size, 0);
  assert.equal(restartedRuntime.groupService.memberLocations.size, 0);
  const reconnectedMember = restartedRuntime.connect('member-socket-after-restart', 'stable-member-id');
  const result = await reconnectedMember.clientEmit('rejoin_group', {
    groupCode,
    userId: 'stable-member-id',
  });

  assert.equal(result.success, true);
  assert.equal(result.group.groupId, created.group.groupId);
  assert.equal(result.group.groupCode, groupCode);
  assert.equal(result.group.groupName, 'Restart Pilgrimage');
  assert.equal(result.group.maxMembers, 3);
  assert.equal(result.group.creatorId, 'stable-creator-id');
  assert.deepEqual(result.group.members, [
    { userId: 'stable-creator-id', userName: 'Rasheed' },
    { userId: 'stable-member-id', userName: 'Ahmed' },
  ]);
  assert.deepEqual(result.group.meetingPoint, meetingPoint);
  assert.deepEqual(reconnectedMember.serverEvents.find(
    (event) => event.event === 'group_locations',
  )?.payload, { groupCode, locations: [] });
  assert.equal(reconnectedMember.serverEvents.some(
    (event) => event.event === 'meeting_point',
  ), true);
  assert.ok(reconnectedMember.rooms.has(groupCode));
  assert.deepEqual(restartedRuntime.groupService.getMemberLocations(groupCode), []);

  const freshLocation = {
    groupCode,
    userId: 'stable-member-id',
    userName: 'Ahmed',
    latitude: 13.63,
    longitude: 79.42,
  };
  assert.equal((await reconnectedMember.clientEmit('location_update', freshLocation)).success, true);
  assert.deepEqual(restartedRuntime.groupService.getMemberLocations(groupCode), [{
    userId: 'stable-member-id',
    userName: 'Ahmed',
    latitude: 13.63,
    longitude: 79.42,
  }]);
});

test('existing member rejoins a full restored group while a new member is rejected', async () => {
  const originalRuntime = createSocketHarness();
  const creator = originalRuntime.connect('creator-socket', 'creator-id');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Full Restart Group',
    maxMembers: 2,
    userId: 'creator-id',
    userName: 'Creator',
  });
  await originalRuntime.connect('member-socket', 'member-id').clientEmit('join_group', {
    groupCode: created.group.groupCode,
    userId: 'member-id',
    userName: 'Member',
  });

  const restartedRuntime = createSocketHarness(originalRuntime.databaseAccess);
  const returningMember = restartedRuntime.connect('returning-member', 'member-id');
  const rejoined = await returningMember.clientEmit('rejoin_group', {
    groupCode: created.group.groupCode,
    userId: 'member-id',
  });
  assert.equal(rejoined.success, true);
  assert.equal(rejoined.group.members.length, 2);
  assert.equal(
    [...restartedRuntime.databaseAccess.memberships]
      .filter((key) => key.startsWith(`${created.group.groupId}:`)).length,
    2,
  );

  const newMember = restartedRuntime.connect('new-member', 'new-member-id');
  const rejected = await newMember.clientEmit('join_group', {
    groupCode: created.group.groupCode,
    userId: 'new-member-id',
    userName: 'New Member',
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.error.code, 'GROUP_FULL');
  assert.equal(newMember.rooms.has(created.group.groupCode), false);
  assert.equal(
    restartedRuntime.databaseAccess.memberships.has(
      `${created.group.groupId}:new-member-id`,
    ),
    false,
  );
  assert.equal(
    restartedRuntime.groupService.groups.get(created.group.groupCode).members.length,
    2,
  );
});

test('restored creator identity is stable and groups without points stay empty', async () => {
  const originalRuntime = createSocketHarness();
  const creator = originalRuntime.connect('creator-before-restart', 'stable-creator-id');
  const created = await creator.clientEmit('create_group', {
    groupName: 'No Point Group',
    maxMembers: 3,
    userId: 'stable-creator-id',
    userName: 'Creator',
  });
  await originalRuntime.connect('member-before-restart', 'stable-member-id').clientEmit('join_group', {
    groupCode: created.group.groupCode,
    userId: 'stable-member-id',
    userName: 'Member',
  });

  const restartedRuntime = createSocketHarness(originalRuntime.databaseAccess);
  const member = restartedRuntime.connect('member-after-restart', 'stable-member-id');
  const restored = await member.clientEmit('rejoin_group', {
    groupCode: created.group.groupCode,
    userId: 'stable-member-id',
  });
  assert.equal(restored.group.creatorId, 'stable-creator-id');
  assert.equal(restored.group.meetingPoint, null);
  assert.equal(member.serverEvents.some((event) => event.event === 'meeting_point'), false);

  const unauthorized = await member.clientEmit('set_meeting_point', {
    groupCode: created.group.groupCode,
    userId: 'stable-member-id',
    latitude: 13.64,
    longitude: 79.43,
  });
  assert.equal(unauthorized.error.code, 'NOT_GROUP_CREATOR');

  const restoredCreator = restartedRuntime.connect('creator-after-restart', 'stable-creator-id');
  const creatorRejoin = await restoredCreator.clientEmit('rejoin_group', {
    groupCode: created.group.groupCode,
    userId: 'stable-creator-id',
  });
  assert.equal(creatorRejoin.group.creatorId, 'stable-creator-id');
  assert.equal((await restoredCreator.clientEmit('set_meeting_point', {
    groupCode: created.group.groupCode,
    userId: 'stable-creator-id',
    latitude: 13.64,
    longitude: 79.43,
  })).success, true);
});

test('missing groups and restoration failures do not create runtime state or join rooms', async () => {
  const emptyRuntime = createSocketHarness();
  const missingGroupSocket = emptyRuntime.connect('missing-group-socket');
  const missing = await missingGroupSocket.clientEmit('rejoin_group', {
    groupCode: '123456',
    userId: 'member-id',
  });
  assert.equal(missing.error.code, 'GROUP_NOT_FOUND');
  assert.equal(emptyRuntime.groupService.groups.size, 0);
  assert.equal(missingGroupSocket.rooms.size, 0);

  const originalRuntime = createSocketHarness();
  const created = await originalRuntime.connect('creator').clientEmit('create_group', {
    groupName: 'Database Failure Group',
    maxMembers: 3,
    userId: 'creator-id',
    userName: 'Creator',
  });
  const restartedRuntime = createSocketHarness(originalRuntime.databaseAccess);
  restartedRuntime.databaseAccess.failGroupRestore = true;
  const failedRestoreSocket = restartedRuntime.connect('failed-restore-socket');
  const failed = await failedRestoreSocket.clientEmit('rejoin_group', {
    groupCode: created.group.groupCode,
    userId: 'creator-id',
  });
  assert.equal(failed.error.code, 'INTERNAL_ERROR');
  assert.equal(failed.error.message, 'Unable to process group request');
  assert.equal(restartedRuntime.groupService.groups.size, 0);
  assert.equal(failedRestoreSocket.rooms.size, 0);
  assert.equal(failedRestoreSocket.serverEvents.some(
    (event) => event.event === 'group_rejoined',
  ), false);
});

test('socket events return clear validation, not-found, and full-group errors', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket');
  const invalidCreate = await creator.clientEmit('create_group', {
    groupName: 'Trip',
    maxMembers: 1,
    userId: 'creator-socket',
    userName: 'Creator',
  });
  assert.equal(invalidCreate.error.code, 'INVALID_MEMBER_LIMIT');

  const missingGroup = await creator.clientEmit('join_group', {
    groupCode: '123456',
    userId: 'member-1',
    userName: 'Ahmed',
  });
  assert.equal(missingGroup.error.code, 'GROUP_NOT_FOUND');

  const groupResult = await creator.clientEmit('create_group', {
    groupName: 'Full Group',
    maxMembers: 2,
    userId: 'creator-socket',
    userName: 'Creator',
  });
  const groupCode = groupResult.group.groupCode;
  await harness.connect('first-member').clientEmit('join_group', {
    groupCode,
    userId: 'first-member',
    userName: 'Ahmed',
  });
  const fullResult = await harness.connect('second-member').clientEmit(
    'join_group',
    { groupCode, userId: 'second-member', userName: 'Samira' },
  );
  assert.equal(fullResult.error.code, 'GROUP_FULL');

  const invalidCode = await harness.connect('invalid-code').clientEmit(
    'join_group',
    { groupCode: 'bad', userId: 'invalid-code', userName: 'User' },
  );
  assert.equal(invalidCode.error.code, 'INVALID_GROUP_CODE');
});

test('location updates are room-broadcast to others and new members receive latest locations', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'user-a');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 4,
    userId: 'user-a',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;

  const firstLocation = {
    groupCode,
    userId: 'user-a',
    userName: 'Rasheed',
    latitude: 13.6288,
    longitude: 79.4192,
  };
  const isolatedMember = harness.connect('isolated-member-socket', 'isolated-user');
  const isolatedGroup = await isolatedMember.clientEmit('create_group', {
    groupName: 'Other Group',
    maxMembers: 2,
    userId: 'isolated-user',
    userName: 'Isolated',
  });
  assert.equal((await creator.clientEmit('location_update', firstLocation)).success, true);
  assert.equal(
    creator.serverEvents.some((event) => event.event === 'member_location_updated'),
    false,
  );
  assert.equal(
    isolatedMember.serverEvents.some((event) => event.event === 'member_location_updated'),
    false,
  );
  assert.notEqual(isolatedGroup.group.groupCode, groupCode);

  const member = harness.connect('member-socket');
  await member.clientEmit('join_group', { groupCode, userId: 'user-b', userName: 'Ahmed' });
  assert.deepEqual(member.serverEvents.find((event) => event.event === 'group_locations')?.payload, {
    groupCode,
    locations: [{
      userId: 'user-a',
      userName: 'Rasheed',
      latitude: 13.6288,
      longitude: 79.4192,
    }],
  });

  const nextLocation = { ...firstLocation, latitude: 13.6295, longitude: 79.421 };
  assert.equal((await creator.clientEmit('location_update', nextLocation)).success, true);
  assert.deepEqual(member.serverEvents.findLast(
    (event) => event.event === 'member_location_updated',
  )?.payload, {
    userId: 'user-a',
    userName: 'Rasheed',
    latitude: 13.6295,
    longitude: 79.421,
  });
  assert.equal(
    creator.serverEvents.some((event) => event.event === 'member_location_updated'),
    false,
  );
  assert.deepEqual(harness.groupService.getMemberLocations(groupCode), [{
    userId: 'user-a',
    userName: 'Rasheed',
    latitude: 13.6295,
    longitude: 79.421,
  }]);
});

test('location updates reject invalid groups, coordinates, and non-member sockets', async () => {
  const harness = createSocketHarness();
  const member = harness.connect('member-socket', 'user-a');
  const outsider = harness.connect('outsider-socket', 'outsider');
  const created = await member.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 3,
    userId: 'user-a',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const validPayload = {
    groupCode,
    userId: 'user-a',
    userName: 'Rasheed',
    latitude: 13.6288,
    longitude: 79.4192,
  };

  const invalidCode = await member.clientEmit('location_update', {
    ...validPayload,
    groupCode: 'bad',
  });
  assert.equal(invalidCode.error.code, 'INVALID_GROUP_CODE');

  const missingGroup = await member.clientEmit('location_update', {
    ...validPayload,
    groupCode: '123456',
  });
  assert.equal(missingGroup.error.code, 'GROUP_NOT_FOUND');

  const invalidLatitude = await member.clientEmit('location_update', {
    ...validPayload,
    latitude: 91,
  });
  assert.equal(invalidLatitude.error.code, 'INVALID_LATITUDE');

  const ignoredMissingUserId = await member.clientEmit('location_update', {
    ...validPayload,
    userId: '',
  });
  assert.equal(ignoredMissingUserId.success, true);

  const ignoredMissingUserName = await member.clientEmit('location_update', {
    ...validPayload,
    userName: ' ',
  });
  assert.equal(ignoredMissingUserName.success, true);

  const invalidLongitude = await member.clientEmit('location_update', {
    ...validPayload,
    longitude: '79.4192',
  });
  assert.equal(invalidLongitude.error.code, 'INVALID_LONGITUDE');

  const outOfRangeLongitude = await member.clientEmit('location_update', {
    ...validPayload,
    longitude: 181,
  });
  assert.equal(outOfRangeLongitude.error.code, 'INVALID_LONGITUDE');

  const notMember = await outsider.clientEmit('location_update', {
    ...validPayload,
    userId: 'outsider',
    userName: 'Outsider',
  });
  assert.equal(notMember.error.code, 'NOT_GROUP_MEMBER');

  const notJoined = await outsider.clientEmit('location_update', validPayload);
  assert.equal(notJoined.error.code, 'NOT_GROUP_MEMBER');
  assert.equal(
    member.serverEvents.some((event) => event.event === 'member_location_updated'),
    false,
  );
  assert.equal(
    outsider.serverEvents.filter((event) => event.event === 'location_update_error').length,
    2,
  );
});

test('disconnect removes only active location and keeps in-memory group membership', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket', 'user-a');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 3,
    userId: 'user-a',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const groupId = created.group.groupId;
  const member = harness.connect('member-socket', 'user-b');
  await member.clientEmit('join_group', { groupCode, userId: 'user-b', userName: 'Ahmed' });
  const observer = harness.connect('observer-socket', 'user-c');
  await observer.clientEmit('join_group', { groupCode, userId: 'user-c', userName: 'Samira' });
  assert.equal(harness.databaseAccess.memberships.has(`${groupId}:user-a`), true);
  assert.equal(harness.databaseAccess.memberships.has(`${groupId}:user-b`), true);
  await creator.clientEmit('location_update', {
    groupCode,
    userId: 'user-a',
    userName: 'Rasheed',
    latitude: 13.6288,
    longitude: 79.4192,
  });

  creator.disconnect();

  assert.equal(harness.databaseAccess.memberships.has(`${groupId}:user-a`), true);
  assert.equal(harness.databaseAccess.memberships.has(`${groupId}:user-b`), true);
  assert.equal(
    harness.databaseAccess.statements.some((statement) => /DELETE\s+FROM\s+group_members/i.test(statement)),
    false,
  );

  assert.deepEqual(member.serverEvents.findLast(
    (event) => event.event === 'member_location_removed',
  )?.payload, { userId: 'user-a' });
  assert.deepEqual(observer.serverEvents.findLast(
    (event) => event.event === 'member_location_removed',
  )?.payload, { userId: 'user-a' });
  assert.deepEqual(harness.groupService.getMemberLocations(groupCode), []);
  assert.deepEqual(
    harness.groupService.groups.get(groupCode).members,
    [
      { userId: 'user-a', userName: 'Rasheed' },
      { userId: 'user-b', userName: 'Ahmed' },
      { userId: 'user-c', userName: 'Samira' },
    ],
  );

  member.disconnect();
  assert.deepEqual(observer.serverEvents.findLast(
    (event) => event.event === 'member_location_removed',
  )?.payload, { userId: 'user-b' });
});