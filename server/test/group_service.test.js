const assert = require('node:assert/strict');
const test = require('node:test');

const GroupService = require('../services/group_service');

function createTestDatabase() {
  const users = new Map();
  const groups = new Map();
  const memberships = new Set();
  const meetingPoints = new Map();
  const databaseAccess = {
    failMembershipInsert: false,
    failMeetingPointUpsert: false,
    failGroupRestore: false,
    meetingPoints,
  };
  databaseAccess.withTransaction = async (callback) => callback({
      query: async (statement, params = []) => {
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
          if (databaseAccess.failMembershipInsert) throw new Error('membership insert failed');
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
          const members = [...memberships]
            .filter((key) => key.startsWith(`${group.id}:`))
            .map((key) => key.slice(group.id.length + 1));
          const rows = (members.length > 0 ? members : [null]).map((userId) => ({
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

function createService(databaseAccess = createTestDatabase()) {
  return new GroupService(databaseAccess);
}

test('createGroup stores a unique code and creator as the first member', async () => {
  const service = createService();
  const group = await service.createGroup({
    groupName: ' Tirupati Trip ',
    maxMembers: 4,
    userId: 'creator-1',
    userName: 'Creator',
  });

  assert.match(group.groupId, /^[0-9a-f-]{36}$/);
  assert.match(group.groupCode, /^\d{6}$/);
  assert.equal(group.groupName, 'Tirupati Trip');
  assert.equal(group.maxMembers, 4);
  assert.deepEqual(group.members, [{ userId: 'creator-1', userName: 'Creator' }]);
});

test('createGroup rejects blank names and invalid member limits', async () => {
  const service = createService();
  const create = (overrides) => service.createGroup({
    groupName: 'Trip',
    maxMembers: 4,
    userId: 'creator-1',
    userName: 'Creator',
    ...overrides,
  });

  await assert.rejects(create({ groupName: ' ' }), { code: 'INVALID_GROUP_NAME' });
  for (const maxMembers of [1, 7, 2.5, '4']) {
    await assert.rejects(create({ maxMembers }), { code: 'INVALID_MEMBER_LIMIT' });
  }
});

test('createGroup does not update memory when PostgreSQL persistence fails', async () => {
  const service = new GroupService({
    withTransaction: async () => { throw new Error('database unavailable'); },
  });

  await assert.rejects(service.createGroup({
    groupName: 'Trip',
    maxMembers: 4,
    userId: 'creator-1',
    userName: 'Creator',
  }), { message: 'database unavailable' });
  assert.equal(service.groups.size, 0);
});
test('joinGroup handles invalid codes, missing groups, successful joins, and full groups', async () => {
  const service = createService();
  const group = await service.createGroup({
    groupName: 'Trip',
    maxMembers: 2,
    userId: 'creator-1',
    userName: 'Creator',
  });

  await assert.rejects(service.joinGroup({
    groupCode: '123', userId: 'user-1', userName: 'Ahmed',
  }), { code: 'INVALID_GROUP_CODE' });
  await assert.rejects(service.joinGroup({
    groupCode: '000000', userId: 'user-1', userName: 'Ahmed',
  }), { code: 'GROUP_NOT_FOUND' });

  const joined = await service.joinGroup({
    groupCode: group.groupCode,
    userId: 'user-1',
    userName: ' Ahmed ',
  });
  assert.equal(joined.group.members[1].userName, 'Ahmed');
  assert.equal(joined.memberJoined, true);
  await assert.rejects(service.joinGroup({
    groupCode: group.groupCode,
    userId: 'user-2',
    userName: 'Samira',
  }), { code: 'GROUP_FULL' });
});

test('rejoinGroup returns persisted membership without adding a duplicate', async () => {
  const service = createService();
  const group = await service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });
  await service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed',
  });

  const result = await service.rejoinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
  });
  assert.equal(result.member.userName, 'Ahmed');
  assert.equal(result.group.members.length, 2);
  await assert.rejects(service.rejoinGroup({
    groupCode: group.groupCode,
    userId: 'outsider',
  }), { code: 'NOT_GROUP_MEMBER' });
  await assert.rejects(service.rejoinGroup({
    groupCode: '123456',
    userId: 'member-1',
  }), { code: 'GROUP_NOT_FOUND' });
});

test('joinGroup and rejoinGroup keep the original member identity for the stable user ID', async () => {
  const service = createService();
  const group = await service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });

  const firstJoin = await service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed',
  });
  assert.equal(firstJoin.member.userName, 'Ahmed');
  assert.equal(firstJoin.group.members.length, 2);

  const duplicateJoin = await service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed 2',
  });
  assert.equal(duplicateJoin.member.userName, 'Ahmed');
  assert.equal(duplicateJoin.group.members.length, 2);

  const rejoin = await service.rejoinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed 2',
  });
  assert.equal(rejoin.member.userName, 'Ahmed');
  assert.equal(rejoin.group.members.length, 2);
});

test('an existing member can join a full group but a new member cannot', async () => {
  const service = createService();
  const group = await service.createGroup({
    groupName: 'Full Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Rasheed',
  });
  await service.joinGroup({ groupCode: group.groupCode, userId: 'ahmed', userName: 'Ahmed' });
  await service.joinGroup({ groupCode: group.groupCode, userId: 'imran', userName: 'Imran' });

  const rejoined = await service.joinGroup({
    groupCode: group.groupCode,
    userId: 'ahmed',
    userName: 'Ahmed refreshed',
  });
  assert.equal(rejoined.memberJoined, false);
  assert.equal(rejoined.group.members.length, 3);
  assert.equal(rejoined.member.userName, 'Ahmed');
  await assert.rejects(service.joinGroup({
    groupCode: group.groupCode,
    userId: 'john',
    userName: 'John',
  }), { code: 'GROUP_FULL' });
});

test('joinGroup does not update memory when membership persistence fails', async () => {
  const databaseAccess = createTestDatabase();
  const service = createService(databaseAccess);
  const group = await service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });
  databaseAccess.failMembershipInsert = true;

  await assert.rejects(service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed',
  }), { message: 'membership insert failed' });
  assert.deepEqual(service.groups.get(group.groupCode).members, [
    { userId: 'creator-1', userName: 'Creator' },
  ]);
});

test('setMeetingPoint replaces the in-memory point and restricts updates to the creator', async () => {
  const databaseAccess = createTestDatabase();
  const service = createService(databaseAccess);
  const group = await service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });
  await service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed',
  });

  assert.deepEqual(await service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.6288,
    longitude: 79.4192,
  }), { latitude: 13.6288, longitude: 79.4192 });
  assert.deepEqual(await service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.635,
    longitude: 79.43,
  }), { latitude: 13.635, longitude: 79.43 });
  assert.deepEqual(service.groups.get(group.groupCode).meetingPoint, {
    latitude: 13.635,
    longitude: 79.43,
  });
  await assert.rejects(service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'member-1',
    latitude: 13.6288,
    longitude: 79.4192,
  }), { code: 'NOT_GROUP_CREATOR' });
  await assert.rejects(service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 91,
    longitude: 79.4192,
  }), { code: 'INVALID_LATITUDE' });
  await assert.rejects(service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.6288,
    longitude: 181,
  }), { code: 'INVALID_LONGITUDE' });
  assert.deepEqual(databaseAccess.meetingPoints.get(group.groupId), {
    latitude: 13.635,
    longitude: 79.43,
  });
});

test('setMeetingPoint leaves runtime state unchanged when persistence fails', async () => {
  const databaseAccess = createTestDatabase();
  const service = createService(databaseAccess);
  const group = await service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });
  await service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.6288,
    longitude: 79.4192,
  });
  databaseAccess.failMeetingPointUpsert = true;

  await assert.rejects(service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.635,
    longitude: 79.43,
  }), { message: 'meeting point persistence failed' });
  assert.deepEqual(service.groups.get(group.groupCode).meetingPoint, {
    latitude: 13.6288,
    longitude: 79.4192,
  });
});