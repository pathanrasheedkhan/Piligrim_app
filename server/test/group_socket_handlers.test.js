const assert = require('node:assert/strict');
const test = require('node:test');

const GroupService = require('../services/group_service');
const registerGroupSocketHandlers = require('../sockets/group_socket_handlers');

function createSocketHarness() {
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

  function connect(id) {
    const socket = {
      id,
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

  const groupService = new GroupService();
  registerGroupSocketHandlers(io, groupService);
  return { connect, groupService };
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

test('meeting points broadcast to the group, replace old state, and reject members', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 4,
    userId: 'rasheed',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const ahmed = harness.connect('ahmed-socket');
  await ahmed.clientEmit('join_group', { groupCode, userId: 'ahmed', userName: 'Ahmed' });
  const imran = harness.connect('imran-socket');
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

  const newMember = harness.connect('new-member-socket');
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

  const outsider = harness.connect('outsider-socket');
  const spoofedCreator = await outsider.clientEmit('set_meeting_point', {
    groupCode,
    userId: 'rasheed',
    latitude: 13.7,
    longitude: 79.5,
  });
  assert.equal(spoofedCreator.error.code, 'NOT_GROUP_MEMBER');
  assert.deepEqual(harness.groupService.groups.get(groupCode).meetingPoint, secondPoint);
});

test('rejoin restores group state without duplicating a member', async () => {
  const harness = createSocketHarness();
  const creator = harness.connect('creator-socket');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 4,
    userId: 'stable-creator-id',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const member = harness.connect('member-socket-before-refresh');
  await member.clientEmit('join_group', {
    groupCode,
    userId: 'stable-member-id',
    userName: 'Ahmed',
  });
  const observer = harness.connect('observer-socket');
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

  const refreshedMember = harness.connect('member-socket-after-refresh');
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

  const outsider = harness.connect('outsider-socket');
  const rejected = await outsider.clientEmit('rejoin_group', {
    groupCode,
    userId: 'not-a-member',
  });
  assert.equal(rejected.error.code, 'NOT_GROUP_MEMBER');
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
  const creator = harness.connect('creator-socket');
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
  const isolatedMember = harness.connect('isolated-member-socket');
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
  const member = harness.connect('member-socket');
  const outsider = harness.connect('outsider-socket');
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

  const invalidMissingUserId = await member.clientEmit('location_update', {
    ...validPayload,
    userId: '',
  });
  assert.equal(invalidMissingUserId.error.code, 'INVALID_USER_ID');

  const invalidMissingUserName = await member.clientEmit('location_update', {
    ...validPayload,
    userName: ' ',
  });
  assert.equal(invalidMissingUserName.error.code, 'INVALID_USER_NAME');

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
  const creator = harness.connect('creator-socket');
  const created = await creator.clientEmit('create_group', {
    groupName: 'Tirupati Trip',
    maxMembers: 3,
    userId: 'user-a',
    userName: 'Rasheed',
  });
  const groupCode = created.group.groupCode;
  const member = harness.connect('member-socket');
  await member.clientEmit('join_group', { groupCode, userId: 'user-b', userName: 'Ahmed' });
  const observer = harness.connect('observer-socket');
  await observer.clientEmit('join_group', { groupCode, userId: 'user-c', userName: 'Samira' });
  await creator.clientEmit('location_update', {
    groupCode,
    userId: 'user-a',
    userName: 'Rasheed',
    latitude: 13.6288,
    longitude: 79.4192,
  });

  creator.disconnect();

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