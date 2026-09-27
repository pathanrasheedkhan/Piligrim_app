const assert = require('node:assert/strict');
const test = require('node:test');

const GroupService = require('../services/group_service');

test('createGroup stores a unique code and creator as the first member', () => {
  const service = new GroupService();
  const group = service.createGroup({
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

test('createGroup rejects blank names and invalid member limits', () => {
  const service = new GroupService();
  const create = (overrides) => service.createGroup({
    groupName: 'Trip',
    maxMembers: 4,
    userId: 'creator-1',
    userName: 'Creator',
    ...overrides,
  });

  assert.throws(() => create({ groupName: ' ' }), { code: 'INVALID_GROUP_NAME' });
  for (const maxMembers of [1, 7, 2.5, '4']) {
    assert.throws(() => create({ maxMembers }), { code: 'INVALID_MEMBER_LIMIT' });
  }
});

test('joinGroup handles invalid codes, missing groups, successful joins, and full groups', () => {
  const service = new GroupService();
  const group = service.createGroup({
    groupName: 'Trip',
    maxMembers: 2,
    userId: 'creator-1',
    userName: 'Creator',
  });

  assert.throws(() => service.joinGroup({
    groupCode: '123', userId: 'user-1', userName: 'Ahmed',
  }), { code: 'INVALID_GROUP_CODE' });
  assert.throws(() => service.joinGroup({
    groupCode: '000000', userId: 'user-1', userName: 'Ahmed',
  }), { code: 'GROUP_NOT_FOUND' });

  const joined = service.joinGroup({
    groupCode: group.groupCode,
    userId: 'user-1',
    userName: ' Ahmed ',
  });
  assert.equal(joined.group.members[1].userName, 'Ahmed');
  assert.equal(joined.memberJoined, true);
  assert.throws(() => service.joinGroup({
    groupCode: group.groupCode,
    userId: 'user-2',
    userName: 'Samira',
  }), { code: 'GROUP_FULL' });
});

test('rejoinGroup returns existing membership without adding a duplicate', () => {
  const service = new GroupService();
  const group = service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });
  service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed',
  });

  const result = service.rejoinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
  });
  assert.equal(result.member.userName, 'Ahmed');
  assert.equal(result.group.members.length, 2);
  assert.throws(() => service.rejoinGroup({
    groupCode: group.groupCode,
    userId: 'outsider',
  }), { code: 'NOT_GROUP_MEMBER' });
  assert.throws(() => service.rejoinGroup({
    groupCode: '123456',
    userId: 'member-1',
  }), { code: 'GROUP_NOT_FOUND' });
});

test('joinGroup and rejoinGroup keep the original member identity for the stable user ID', () => {
  const service = new GroupService();
  const group = service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });

  const firstJoin = service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed',
  });
  assert.equal(firstJoin.member.userName, 'Ahmed');
  assert.equal(firstJoin.group.members.length, 2);

  const duplicateJoin = service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed 2',
  });
  assert.equal(duplicateJoin.member.userName, 'Ahmed');
  assert.equal(duplicateJoin.group.members.length, 2);

  const rejoin = service.rejoinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed 2',
  });
  assert.equal(rejoin.member.userName, 'Ahmed');
  assert.equal(rejoin.group.members.length, 2);
});

test('setMeetingPoint replaces the in-memory point and restricts updates to the creator', () => {
  const service = new GroupService();
  const group = service.createGroup({
    groupName: 'Trip',
    maxMembers: 3,
    userId: 'creator-1',
    userName: 'Creator',
  });
  service.joinGroup({
    groupCode: group.groupCode,
    userId: 'member-1',
    userName: 'Ahmed',
  });

  assert.deepEqual(service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.6288,
    longitude: 79.4192,
  }), { latitude: 13.6288, longitude: 79.4192 });
  assert.deepEqual(service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.635,
    longitude: 79.43,
  }), { latitude: 13.635, longitude: 79.43 });
  assert.deepEqual(service.groups.get(group.groupCode).meetingPoint, {
    latitude: 13.635,
    longitude: 79.43,
  });
  assert.throws(() => service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'member-1',
    latitude: 13.6288,
    longitude: 79.4192,
  }), { code: 'NOT_GROUP_CREATOR' });
  assert.throws(() => service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 91,
    longitude: 79.4192,
  }), { code: 'INVALID_LATITUDE' });
  assert.throws(() => service.setMeetingPoint({
    groupCode: group.groupCode,
    userId: 'creator-1',
    latitude: 13.6288,
    longitude: 181,
  }), { code: 'INVALID_LONGITUDE' });
});