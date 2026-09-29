const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const database = require('../db/database');
const GroupService = require('../services/group_service');

test('createGroup persists its code, group fields, and temporary creator identity', async () => {
  const service = new GroupService(database);
  const userId = randomUUID();
  let group;

  try {
    group = await service.createGroup({
      groupName: ' PostgreSQL Pilgrimage ',
      maxMembers: 5,
      userId,
      userName: 'Temporary Creator',
    });

    const result = await database.query(
      `SELECT id, group_code, group_name, max_members, creator_user_id, created_at, updated_at
       FROM groups WHERE id = $1`,
      [group.groupId],
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, group.groupId);
    assert.equal(result.rows[0].group_code, group.groupCode);
    assert.match(result.rows[0].group_code, /^\d{6}$/);
    assert.equal(result.rows[0].group_name, 'PostgreSQL Pilgrimage');
    assert.equal(result.rows[0].max_members, 5);
    assert.equal(result.rows[0].creator_user_id, userId);
    assert.ok(result.rows[0].created_at instanceof Date);
    assert.ok(result.rows[0].updated_at instanceof Date);

    const membership = await database.query(
      'SELECT group_id, user_id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [group.groupId, userId],
    );
    assert.deepEqual(membership.rows, [{ group_id: group.groupId, user_id: userId }]);
  } finally {
    if (group) {
      await database.query('DELETE FROM groups WHERE id = $1', [group.groupId]);
    }
    await database.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('joinGroup persists unique membership and allows existing members into a full group', async () => {
  const service = new GroupService(database);
  const userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let group;

  try {
    group = await service.createGroup({
      groupName: 'Full PostgreSQL Pilgrimage',
      maxMembers: 3,
      userId: userIds[0],
      userName: 'Rasheed',
    });
    assert.equal((await service.joinGroup({
      groupCode: group.groupCode,
      userId: userIds[1],
      userName: 'Ahmed',
    })).memberJoined, true);
    assert.equal((await service.joinGroup({
      groupCode: group.groupCode,
      userId: userIds[2],
      userName: 'Imran',
    })).memberJoined, true);

    const duplicate = await service.joinGroup({
      groupCode: group.groupCode,
      userId: userIds[1],
      userName: 'Ahmed Updated',
    });
    assert.equal(duplicate.memberJoined, false);
    assert.equal(duplicate.member.userName, 'Ahmed');
    assert.equal(duplicate.group.members.length, 3);

    const rejoined = await service.joinGroup({
      groupCode: group.groupCode,
      userId: userIds[1],
      userName: 'Ahmed Updated',
    });
    assert.equal(rejoined.memberJoined, false);
    assert.equal(rejoined.group.members.length, 3);

    await assert.rejects(service.joinGroup({
      groupCode: group.groupCode,
      userId: userIds[3],
      userName: 'John',
    }), { code: 'GROUP_FULL' });

    const result = await database.query(
      `SELECT group_id, user_id FROM group_members
       WHERE group_id = $1 ORDER BY user_id`,
      [group.groupId],
    );
    assert.deepEqual(result.rows, userIds.slice(0, 3).sort().map((userId) => ({
      group_id: group.groupId,
      user_id: userId,
    })));

    const duplicateCount = await database.query(
      'SELECT COUNT(*) AS count FROM group_members WHERE group_id = $1 AND user_id = $2',
      [group.groupId, userIds[1]],
    );
    assert.equal(Number(duplicateCount.rows[0].count), 1);
  } finally {
    if (group) await database.query('DELETE FROM groups WHERE id = $1', [group.groupId]);
    for (const userId of userIds) {
      await database.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  }
});

test('setMeetingPoint persists one row and replaces it for the group creator', async () => {
  const service = new GroupService(database);
  const userId = randomUUID();
  let group;

  try {
    group = await service.createGroup({
      groupName: 'Meeting Point Pilgrimage',
      maxMembers: 3,
      userId,
      userName: 'Rasheed',
    });
    await service.setMeetingPoint({
      groupCode: group.groupCode,
      userId,
      latitude: 13.6288,
      longitude: 79.4192,
    });
    await service.setMeetingPoint({
      groupCode: group.groupCode,
      userId,
      latitude: 13.635,
      longitude: 79.43,
    });

    const result = await database.query(
      `SELECT group_id, latitude, longitude FROM meeting_points WHERE group_id = $1`,
      [group.groupId],
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].group_id, group.groupId);
    assert.equal(result.rows[0].latitude, 13.635);
    assert.equal(result.rows[0].longitude, 79.43);
  } finally {
    if (group) await database.query('DELETE FROM groups WHERE id = $1', [group.groupId]);
    await database.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('rejoin rebuilds group, members, and meeting point after runtime reset', async () => {
  const service = new GroupService(database);
  const restartedService = new GroupService(database);
  const userIds = [randomUUID(), randomUUID()];
  let group;

  try {
    group = await service.createGroup({
      groupName: 'Restart Restoration Pilgrimage',
      maxMembers: 3,
      userId: userIds[0],
      userName: 'Creator',
    });
    await service.joinGroup({
      groupCode: group.groupCode,
      userId: userIds[1],
      userName: 'Member',
    });
    await service.setMeetingPoint({
      groupCode: group.groupCode,
      userId: userIds[0],
      latitude: 13.6288,
      longitude: 79.4192,
    });
    service.storeMemberLocation(group.groupCode, {
      userId: userIds[0],
      userName: 'Creator',
      latitude: 13.62,
      longitude: 79.41,
    });

    const restored = await restartedService.rejoinGroup({
      groupCode: group.groupCode,
      userId: userIds[1],
    });

    assert.equal(restored.group.groupId, group.groupId);
    assert.equal(restored.group.groupCode, group.groupCode);
    assert.equal(restored.group.groupName, 'Restart Restoration Pilgrimage');
    assert.equal(restored.group.maxMembers, 3);
    assert.equal(restored.group.creatorId, userIds[0]);
    assert.deepEqual(restored.group.members, [
      { userId: userIds[0], userName: 'Creator' },
      { userId: userIds[1], userName: 'Member' },
    ]);
    assert.deepEqual(restored.group.meetingPoint, {
      latitude: 13.6288,
      longitude: 79.4192,
    });
    assert.deepEqual(restartedService.getMemberLocations(group.groupCode), []);
  } finally {
    if (group) await database.query('DELETE FROM groups WHERE id = $1', [group.groupId]);
    for (const userId of userIds) {
      await database.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  }
});