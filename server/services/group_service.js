const { randomInt, randomUUID } = require('node:crypto');
const database = require('../db/database');

class GroupServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GroupServiceError';
    this.code = code;
  }
}

class GroupService {
  constructor(databaseAccess = database) {
    this.database = databaseAccess;
    this.groups = new Map();
    // Keep only the latest point in memory; history and PostgreSQL are deferred to a later phase.
    this.memberLocations = new Map();
  }

  async createGroup({ groupName, maxMembers, userId, userName }) {
    const normalizedGroupName = this.requireName(groupName, 'INVALID_GROUP_NAME');
    const normalizedUserName = this.requireName(userName, 'INVALID_USER_NAME');
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 6) {
      throw new GroupServiceError(
        'INVALID_MEMBER_LIMIT',
        'Maximum members must be a whole number between 2 and 6',
      );
    }
    this.requireUserId(userId);

    const groupId = randomUUID();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let groupCode;
      do {
        groupCode = String(randomInt(100000, 1000000));
      } while (this.groups.has(groupCode));

      try {
        await this.database.withTransaction(async (client) => {
          await client.query(
            'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
            [userId, normalizedUserName],
          );
          await client.query(
            `INSERT INTO groups
              (id, group_code, group_name, max_members, creator_user_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [groupId, groupCode, normalizedGroupName, maxMembers, userId],
          );
          await client.query(
            'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
            [groupId, userId],
          );
        });
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'groups_group_code_unique') {
          continue;
        }
        throw error;
      }

      const persistedUserName = await this.fetchUserName(userId, normalizedUserName);
      const group = {
        groupId,
        groupCode,
        groupName: normalizedGroupName,
        maxMembers,
        creatorId: userId,
        members: [{ userId, userName: persistedUserName }],
        meetingPoint: null,
      };
      this.groups.set(groupCode, group);
      return this.copyGroup(group);
    }

    throw new GroupServiceError('GROUP_CODE_CONFLICT', 'Unable to generate a unique group code');
  }

  async joinGroup({ groupCode, userId, userName }) {
    if (typeof groupCode !== 'string' || !/^\d{6}$/.test(groupCode)) {
      throw new GroupServiceError('INVALID_GROUP_CODE', 'Enter a valid 6-digit group code');
    }
    const normalizedUserName = this.requireName(userName, 'INVALID_USER_NAME');
    this.requireUserId(userId);

    if (!this.groups.has(groupCode)) await this.loadGroupFromDatabase(groupCode);
    const group = this.groups.get(groupCode);
    if (!group) {
      throw new GroupServiceError('GROUP_NOT_FOUND', 'Group not found');
    }

    const persistedMembership = await this.database.withTransaction(async (client) => {
      await client.query(
        'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [userId, normalizedUserName],
      );
      await client.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [group.groupId]);

      const existingMembership = await client.query(
        `SELECT users.name
         FROM group_members
         INNER JOIN users ON users.id = group_members.user_id
         WHERE group_members.group_id = $1 AND group_members.user_id = $2`,
        [group.groupId, userId],
      );
      if (existingMembership.rows.length > 0) {
        return { memberJoined: false, userName: existingMembership.rows[0].name || normalizedUserName };
      }

      const membershipCount = await client.query(
        'SELECT COUNT(*) AS member_count FROM group_members WHERE group_id = $1',
        [group.groupId],
      );
      if (Number(membershipCount.rows[0]?.member_count || 0) >= group.maxMembers) {
        throw new GroupServiceError('GROUP_FULL', 'Group is full');
      }

      await client.query(
        'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
        [group.groupId, userId],
      );
      return { memberJoined: true, userName: normalizedUserName };
    });

    const canonicalUserName = await this.fetchUserName(userId, persistedMembership.userName);
    const existingMember = group.members.find((member) => member.userId === userId);
    const member = {
      userId,
      userName: existingMember?.userName || canonicalUserName,
    };
    if (!existingMember) group.members.push(member);
    return {
      group: this.copyGroup(group),
      memberJoined: persistedMembership.memberJoined,
      member,
    };
  }

  async rejoinGroup({ groupCode, userId }) {
    if (typeof groupCode !== 'string' || !/^\d{6}$/.test(groupCode)) {
      throw new GroupServiceError('INVALID_GROUP_CODE', 'Enter a valid 6-digit group code');
    }
    this.requireUserId(userId);

    const group = await this.loadGroupFromDatabase(groupCode, userId);
    const member = group.members.find((existing) => existing.userId === userId);
    if (!member) {
      throw new GroupServiceError('NOT_GROUP_MEMBER', 'User does not belong to this group');
    }

    return { group: this.copyGroup(group), member: { ...member } };
  }

  async loadGroupFromDatabase(groupCode, requiredUserId) {
    let rows;
    try {
      const result = await this.database.withTransaction((client) => client.query(
        `SELECT groups.id, groups.group_code, groups.group_name, groups.max_members,
                groups.creator_user_id, group_members.user_id, users.name AS user_name,
                meeting_points.latitude AS meeting_point_latitude,
                meeting_points.longitude AS meeting_point_longitude
         FROM groups
         LEFT JOIN group_members ON group_members.group_id = groups.id
         LEFT JOIN users ON users.id = group_members.user_id
         LEFT JOIN meeting_points ON meeting_points.group_id = groups.id
         WHERE groups.group_code = $1
         ORDER BY group_members.joined_at, group_members.user_id`,
        [groupCode],
      ));
      rows = result.rows;
    } catch (_error) {
      throw new GroupServiceError('INTERNAL_ERROR', 'Unable to process group request');
    }

    if (rows.length === 0) {
      throw new GroupServiceError('GROUP_NOT_FOUND', 'Group not found');
    }
    const firstRow = rows[0];
    const members = rows
      .filter((row) => row.user_id !== null)
      .map((row) => ({ userId: row.user_id, userName: row.user_name }));
    if (requiredUserId && !members.some((member) => member.userId === requiredUserId)) {
      throw new GroupServiceError('NOT_GROUP_MEMBER', 'User does not belong to this group');
    }
    const group = {
      groupId: firstRow.id,
      groupCode: firstRow.group_code,
      groupName: firstRow.group_name,
      maxMembers: firstRow.max_members,
      creatorId: firstRow.creator_user_id,
      members,
      meetingPoint: firstRow.meeting_point_latitude === null
        ? null
        : {
          latitude: firstRow.meeting_point_latitude,
          longitude: firstRow.meeting_point_longitude,
        },
    };
      if (!this.groups.has(groupCode)) this.memberLocations.delete(groupCode);
    this.groups.set(groupCode, group);
      return group;
  }

  updateMemberLocation({ groupCode, userId, userName, latitude, longitude }) {
    const location = this.validateMemberLocation({
      groupCode, userId, userName, latitude, longitude,
    });
    this.storeMemberLocation(groupCode, location);
    return location;
  }

  validateMemberLocation({ groupCode, userId, userName, latitude, longitude }) {
    if (typeof groupCode !== 'string' || !/^\d{6}$/.test(groupCode)) {
      throw new GroupServiceError('INVALID_GROUP_CODE', 'Enter a valid 6-digit group code');
    }
    const group = this.groups.get(groupCode);
    if (!group) {
      throw new GroupServiceError('GROUP_NOT_FOUND', 'Group not found');
    }
    this.requireUserId(userId);
    const member = group.members.find((entry) => entry.userId === userId);
    const authoritativeUserName = member ? member.userName : this.requireName(userName, 'INVALID_USER_NAME');
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new GroupServiceError('INVALID_LATITUDE', 'Latitude must be a number between -90 and 90');
    }
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new GroupServiceError('INVALID_LONGITUDE', 'Longitude must be a number between -180 and 180');
    }
    if (!group.members.some((entry) => entry.userId === userId)) {
      throw new GroupServiceError('NOT_GROUP_MEMBER', 'User does not belong to this group');
    }

    return { userId, userName: authoritativeUserName, latitude, longitude };
  }

  storeMemberLocation(groupCode, location) {
    if (!this.memberLocations.has(groupCode)) {
      this.memberLocations.set(groupCode, new Map());
    }
    this.memberLocations.get(groupCode).set(location.userId, { ...location });
  }

  getMemberLocations(groupCode, excludedUserId) {
    const locations = this.memberLocations.get(groupCode);
    if (!locations) return [];
    return [...locations.values()]
      .filter((location) => location.userId !== excludedUserId)
      .map((location) => ({ ...location }));
  }

  removeMemberLocation(groupCode, userId) {
    const locations = this.memberLocations.get(groupCode);
    if (!locations) return false;
    const removed = locations.delete(userId);
    if (locations.size === 0) this.memberLocations.delete(groupCode);
    return removed;
  }

  async setMeetingPoint({ groupCode, userId, latitude, longitude }) {
    if (typeof groupCode !== 'string' || !/^\d{6}$/.test(groupCode)) {
      throw new GroupServiceError('INVALID_GROUP_CODE', 'Enter a valid 6-digit group code');
    }
    const group = this.groups.get(groupCode);
    if (!group) {
      throw new GroupServiceError('GROUP_NOT_FOUND', 'Group not found');
    }
    this.requireUserId(userId);
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new GroupServiceError('INVALID_LATITUDE', 'Latitude must be a number between -90 and 90');
    }
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new GroupServiceError('INVALID_LONGITUDE', 'Longitude must be a number between -180 and 180');
    }
    if (!group.members.some((member) => member.userId === userId)) {
      throw new GroupServiceError('NOT_GROUP_MEMBER', 'User does not belong to this group');
    }
    if (group.creatorId !== userId) {
      throw new GroupServiceError('NOT_GROUP_CREATOR', 'Only the group creator can set the meeting point');
    }

    await this.database.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO meeting_points
          (group_id, latitude, longitude, created_at, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (group_id) DO UPDATE
         SET latitude = EXCLUDED.latitude,
             longitude = EXCLUDED.longitude,
             updated_at = CURRENT_TIMESTAMP`,
        [group.groupId, latitude, longitude],
      );
    });

    group.meetingPoint = { latitude, longitude };
    return { ...group.meetingPoint };
  }

  async fetchUserName(userId, fallbackUserName) {
    try {
      const result = await this.database.withTransaction((client) => client.query(
        'SELECT name FROM users WHERE id = $1',
        [userId],
      ));
      const persistedName = result.rows[0]?.name;
      if (typeof persistedName === 'string' && persistedName.trim().length > 0) {
        return persistedName.trim();
      }
    } catch (_error) {
      // Fall back to the trusted caller-supplied name if the persisted user record cannot be loaded.
    }
    return fallbackUserName;
  }

  requireName(value, code) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new GroupServiceError(code, 'Name cannot be empty');
    }
    return value.trim();
  }

  requireUserId(userId) {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new GroupServiceError('INVALID_USER_ID', 'User ID is required');
    }
  }

  copyGroup(group) {
    return {
      ...group,
      members: group.members.map((member) => ({ ...member })),
      meetingPoint: group.meetingPoint ? { ...group.meetingPoint } : null,
    };
  }
}

GroupService.Error = GroupServiceError;

module.exports = GroupService;