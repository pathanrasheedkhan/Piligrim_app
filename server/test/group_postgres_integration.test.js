const assert = require('node:assert/strict');
const { randomInt, randomUUID } = require('node:crypto');
const test = require('node:test');

const database = require('../db/database');
const GroupService = require('../services/group_service');
const registerGroupSocketHandlers = require('../sockets/group_socket_handlers');

function createSocketHarness(databaseAccess = database) {
  const sockets = [];
  let connectionHandler;
  const io = {
    on(event, handler) {
      if (event === 'connection') connectionHandler = handler;
    },
    to(room) {
      return {
        emit(event, payload) {
          for (const recipient of sockets) {
            if (recipient.rooms.has(room)) recipient.serverEvents.push({ event, payload });
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
      clientEmit(event, payload) {
        const handler = this.clientHandlers.get(event);
        assert.ok(handler, `No handler registered for ${event}`);
        return new Promise((resolve) => handler(payload, resolve));
      },
    };
    sockets.push(socket);
    connectionHandler(socket);
    return socket;
  }

  const groupService = new GroupService(databaseAccess);
  registerGroupSocketHandlers(io, groupService);
  return { connect, groupService };
}

async function cleanupRecords(groupId, userIds) {
  if (groupId) await database.query('DELETE FROM groups WHERE id = $1', [groupId]);
  for (const userId of userIds) {
    await database.query('DELETE FROM users WHERE id = $1', [userId]);
  }
}

function sortMembers(members) {
  return [...members].sort((left, right) => left.userId.localeCompare(right.userId));
}

test('PostgreSQL-backed Socket.IO lifecycle survives restart and preserves durable state', async () => {
  const userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let groupId;

  try {
    const runtime = createSocketHarness();
    const creator = runtime.connect('creator-before-restart', userIds[0]);
    const created = await creator.clientEmit('create_group', {
      groupName: 'Phase 6.8 Integration Group',
      maxMembers: 3,
      userId: userIds[0],
      userName: 'Creator',
    });
    assert.equal(created.success, true);
    groupId = created.group.groupId;

    const persistedGroup = await database.query(
      `SELECT id, group_code, group_name, max_members, creator_user_id
       FROM groups WHERE id = $1`,
      [groupId],
    );
    assert.deepEqual(persistedGroup.rows, [{
      id: groupId,
      group_code: created.group.groupCode,
      group_name: 'Phase 6.8 Integration Group',
      max_members: 3,
      creator_user_id: userIds[0],
    }]);
    assert.deepEqual((await database.query(
      'SELECT group_id, user_id FROM group_members WHERE group_id = $1',
      [groupId],
    )).rows, [{ group_id: groupId, user_id: userIds[0] }]);

    const memberA = runtime.connect('member-a-before-restart', userIds[1]);
    const joinedA = await memberA.clientEmit('join_group', {
      groupCode: created.group.groupCode,
      userId: userIds[1],
      userName: 'Member A',
    });
    assert.equal(joinedA.success, true);
    const memberB = runtime.connect('member-b-before-restart', userIds[2]);
    const joinedB = await memberB.clientEmit('join_group', {
      groupCode: created.group.groupCode,
      userId: userIds[2],
      userName: 'Member B',
    });
    assert.equal(joinedB.success, true);
    assert.equal(runtime.groupService.groups.get(created.group.groupCode).members.length, 3);

    const meetingPoint = { latitude: 13.6288, longitude: 79.4192 };
    assert.equal((await creator.clientEmit('set_meeting_point', {
      groupCode: created.group.groupCode,
      userId: userIds[0],
      ...meetingPoint,
    })).success, true);
    const populatedGroup = runtime.groupService.groups.get(created.group.groupCode);
    assert.equal(populatedGroup.groupId, groupId);
    assert.equal(populatedGroup.groupCode, created.group.groupCode);
    assert.equal(populatedGroup.groupName, 'Phase 6.8 Integration Group');
    assert.equal(populatedGroup.maxMembers, 3);
    assert.equal(populatedGroup.creatorId, userIds[0]);
    assert.deepEqual(sortMembers(populatedGroup.members), sortMembers([
      { userId: userIds[0], userName: 'Creator' },
      { userId: userIds[1], userName: 'Member A' },
      { userId: userIds[2], userName: 'Member B' },
    ]));
    assert.deepEqual(populatedGroup.meetingPoint, meetingPoint);
    const savedPoint = await database.query(
      'SELECT group_id, latitude, longitude FROM meeting_points WHERE group_id = $1',
      [groupId],
    );
    assert.deepEqual(savedPoint.rows, [{ group_id: groupId, ...meetingPoint }]);

    const oldLocation = {
      groupCode: created.group.groupCode,
      userId: userIds[0],
      userName: 'Creator',
      latitude: 13.62,
      longitude: 79.41,
    };
    assert.equal((await creator.clientEmit('location_update', oldLocation)).success, true);
    assert.equal(memberA.serverEvents.some(
      (event) => event.event === 'member_location_updated',
    ), true);
    assert.equal(runtime.groupService.getMemberLocations(created.group.groupCode).length, 1);

    // A new service and handler registration model process memory being discarded.
    const restartedRuntime = createSocketHarness();
    assert.equal(restartedRuntime.groupService.groups.size, 0);
    assert.equal(restartedRuntime.groupService.memberLocations.size, 0);
    assert.equal(restartedRuntime.groupService.groups.has(created.group.groupCode), false);
    assert.equal((await database.query('SELECT id FROM groups WHERE id = $1', [groupId])).rows.length, 1);
    assert.equal((await database.query(
      'SELECT group_id FROM meeting_points WHERE group_id = $1',
      [groupId],
    )).rows.length, 1);

    const returningMember = restartedRuntime.connect('member-a-after-restart', userIds[1]);
    const restored = await returningMember.clientEmit('rejoin_group', {
      groupCode: created.group.groupCode,
      userId: userIds[1],
    });
    assert.equal(restored.success, true);
    assert.equal(restored.group.groupId, groupId);
    assert.equal(restored.group.groupCode, created.group.groupCode);
    assert.equal(restored.group.groupName, 'Phase 6.8 Integration Group');
    assert.equal(restored.group.maxMembers, 3);
    assert.equal(restored.group.creatorId, userIds[0]);
    assert.deepEqual(sortMembers(restored.group.members), sortMembers([
      { userId: userIds[0], userName: 'Creator' },
      { userId: userIds[1], userName: 'Member A' },
      { userId: userIds[2], userName: 'Member B' },
    ]));
    assert.deepEqual(restored.group.meetingPoint, meetingPoint);
    assert.equal(returningMember.rooms.has(created.group.groupCode), true);
    assert.deepEqual(returningMember.serverEvents.find(
      (event) => event.event === 'group_locations',
    )?.payload, { groupCode: created.group.groupCode, locations: [] });
    assert.equal(restartedRuntime.groupService.getMemberLocations(created.group.groupCode).length, 0);

    const memberCountAfterRestore = await database.query(
      'SELECT COUNT(*) AS count FROM group_members WHERE group_id = $1',
      [groupId],
    );
    assert.equal(Number(memberCountAfterRestore.rows[0].count), 3);

    const unauthorizedPoint = await returningMember.clientEmit('set_meeting_point', {
      groupCode: created.group.groupCode,
      userId: userIds[1],
      latitude: 13.7,
      longitude: 79.5,
    });
    assert.equal(unauthorizedPoint.success, false);
    assert.equal(unauthorizedPoint.error.code, 'NOT_GROUP_CREATOR');
    assert.deepEqual(restartedRuntime.groupService.groups.get(
      created.group.groupCode,
    ).meetingPoint, meetingPoint);

    const restoredCreator = restartedRuntime.connect('creator-after-restart', userIds[0]);
    const creatorRejoin = await restoredCreator.clientEmit('rejoin_group', {
      groupCode: created.group.groupCode,
      userId: userIds[0],
    });
    assert.equal(creatorRejoin.success, true);
    assert.equal(creatorRejoin.group.creatorId, userIds[0]);
    const updatedPoint = { latitude: 13.635, longitude: 79.43 };
    assert.equal((await restoredCreator.clientEmit('set_meeting_point', {
      groupCode: created.group.groupCode,
      userId: userIds[0],
      ...updatedPoint,
    })).success, true);
    assert.deepEqual(returningMember.serverEvents.findLast(
      (event) => event.event === 'meeting_point_updated',
    )?.payload, updatedPoint);

    const freshLocation = {
      groupCode: created.group.groupCode,
      userId: userIds[1],
      userName: 'Member A',
      latitude: 13.63,
      longitude: 79.42,
    };
    assert.equal((await returningMember.clientEmit('location_update', freshLocation)).success, true);
    assert.deepEqual(restartedRuntime.groupService.getMemberLocations(
      created.group.groupCode,
    ), [{ userId: userIds[1], userName: 'Member A', latitude: 13.63, longitude: 79.42 }]);
    assert.deepEqual(restoredCreator.serverEvents.findLast(
      (event) => event.event === 'member_location_updated',
    )?.payload, {
      userId: userIds[1],
      userName: 'Member A',
      latitude: 13.63,
      longitude: 79.42,
    });

    const newMember = restartedRuntime.connect('new-member-after-restart', userIds[3]);
    const fullGroupJoin = await newMember.clientEmit('join_group', {
      groupCode: created.group.groupCode,
      userId: userIds[3],
      userName: 'New Member',
    });
    assert.equal(fullGroupJoin.success, false);
    assert.equal(fullGroupJoin.error.code, 'GROUP_FULL');
    assert.equal(newMember.rooms.has(created.group.groupCode), false);

    const finalGroups = await database.query(
      'SELECT COUNT(*) AS count FROM groups WHERE id = $1 AND group_code = $2',
      [groupId, created.group.groupCode],
    );
    assert.equal(Number(finalGroups.rows[0].count), 1);
    const finalMemberships = await database.query(
      `SELECT group_id, user_id FROM group_members WHERE group_id = $1 ORDER BY user_id`,
      [groupId],
    );
    assert.deepEqual(finalMemberships.rows, userIds.slice(0, 3).sort().map((userId) => ({
      group_id: groupId,
      user_id: userId,
    })));
    const finalMeetingPoints = await database.query(
      'SELECT COUNT(*) AS count FROM meeting_points WHERE group_id = $1',
      [groupId],
    );
    assert.equal(Number(finalMeetingPoints.rows[0].count), 1);
    const persistedUsers = await database.query(
      'SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id',
      [userIds.slice(0, 3).sort()],
    );
    assert.deepEqual(persistedUsers.rows.map((row) => row.id), userIds.slice(0, 3).sort());
    const rejectedUser = await database.query('SELECT id FROM users WHERE id = $1', [userIds[3]]);
    assert.equal(rejectedUser.rows.length, 0);
  } finally {
    await cleanupRecords(groupId, userIds);
  }
});

test('rejoining a missing PostgreSQL group creates no runtime group or room', async () => {
  let groupCode;
  do {
    groupCode = String(randomInt(100000, 1000000));
  } while ((await database.query('SELECT 1 FROM groups WHERE group_code = $1', [groupCode])).rows.length);

  const runtime = createSocketHarness();
  const userId = randomUUID();
  const socket = runtime.connect('missing-group', userId);
  const result = await socket.clientEmit('rejoin_group', {
    groupCode,
    userId,
  });

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'GROUP_NOT_FOUND');
  assert.equal(runtime.groupService.groups.size, 0);
  assert.equal(socket.rooms.size, 0);
  assert.equal(socket.serverEvents.some((event) => event.event === 'group_rejoined'), false);
});

test('a PostgreSQL restoration failure is sanitized and leaves runtime state untouched', async () => {
  const userId = randomUUID();
  let groupId;

  try {
    const originalRuntime = createSocketHarness();
    const creator = originalRuntime.connect('creator-before-database-failure', userId);
    const created = await creator.clientEmit('create_group', {
      groupName: 'Restore Failure Integration Group',
      maxMembers: 3,
      userId,
      userName: 'Creator',
    });
    assert.equal(created.success, true);
    groupId = created.group.groupId;

    const failingDatabase = {
      query: database.query.bind(database),
      withTransaction(callback) {
        return database.withTransaction((client) => callback({
          query(statement, params) {
            if (statement.includes('SELECT groups.id, groups.group_code')) {
              throw new Error('sensitive PostgreSQL failure detail');
            }
            return client.query(statement, params);
          },
        }));
      },
    };
    const restartedRuntime = createSocketHarness(failingDatabase);
    const returningCreator = restartedRuntime.connect('creator-after-database-failure', userId);
    const failed = await returningCreator.clientEmit('rejoin_group', {
      groupCode: created.group.groupCode,
      userId,
    });

    assert.equal(failed.success, false);
    assert.equal(failed.error.code, 'INTERNAL_ERROR');
    assert.equal(failed.error.message, 'Unable to process group request');
    assert.equal(failed.error.message.includes('sensitive PostgreSQL'), false);
    assert.equal(restartedRuntime.groupService.groups.size, 0);
    assert.equal(returningCreator.rooms.size, 0);
    assert.equal(returningCreator.serverEvents.some(
      (event) => event.event === 'group_rejoined',
    ), false);
    assert.equal((await database.query('SELECT id FROM groups WHERE id = $1', [groupId])).rows.length, 1);
  } finally {
    await cleanupRecords(groupId, [userId]);
  }
});