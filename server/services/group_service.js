const { randomInt, randomUUID } = require('node:crypto');

class GroupServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GroupServiceError';
    this.code = code;
  }
}

class GroupService {
  constructor() {
    this.groups = new Map();
    // Keep only the latest point in memory; history and PostgreSQL are deferred to a later phase.
    this.memberLocations = new Map();
  }

  createGroup({ groupName, maxMembers, userId, userName }) {
    const normalizedGroupName = this.requireName(groupName, 'INVALID_GROUP_NAME');
    const normalizedUserName = this.requireName(userName, 'INVALID_USER_NAME');
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 6) {
      throw new GroupServiceError(
        'INVALID_MEMBER_LIMIT',
        'Maximum members must be a whole number between 2 and 6',
      );
    }
    this.requireUserId(userId);

    let groupCode;
    do {
      groupCode = String(randomInt(100000, 1000000));
    } while (this.groups.has(groupCode));

    const group = {
      groupId: randomUUID(),
      groupCode,
      groupName: normalizedGroupName,
      maxMembers,
      members: [{ userId, userName: normalizedUserName }],
      meetingPoint: null,
    };
    this.groups.set(groupCode, group);
    return this.copyGroup(group);
  }

  joinGroup({ groupCode, userId, userName }) {
    if (typeof groupCode !== 'string' || !/^\d{6}$/.test(groupCode)) {
      throw new GroupServiceError('INVALID_GROUP_CODE', 'Enter a valid 6-digit group code');
    }
    const normalizedUserName = this.requireName(userName, 'INVALID_USER_NAME');
    this.requireUserId(userId);

    const group = this.groups.get(groupCode);
    if (!group) {
      throw new GroupServiceError('GROUP_NOT_FOUND', 'Group not found');
    }

    const existingMember = group.members.find((member) => member.userId === userId);
    if (existingMember) {
      return {
        group: this.copyGroup(group),
        memberJoined: false,
        member: { userId, userName: existingMember.userName },
      };
    }

    if (group.members.length >= group.maxMembers) {
      throw new GroupServiceError('GROUP_FULL', 'Group is full');
    }

    group.members.push({ userId, userName: normalizedUserName });
    return {
      group: this.copyGroup(group),
      memberJoined: true,
      member: { userId, userName: normalizedUserName },
    };
  }

  rejoinGroup({ groupCode, userId }) {
    if (typeof groupCode !== 'string' || !/^\d{6}$/.test(groupCode)) {
      throw new GroupServiceError('INVALID_GROUP_CODE', 'Enter a valid 6-digit group code');
    }
    this.requireUserId(userId);

    const group = this.groups.get(groupCode);
    if (!group) {
      throw new GroupServiceError('GROUP_NOT_FOUND', 'Group not found');
    }
    const member = group.members.find((existing) => existing.userId === userId);
    if (!member) {
      throw new GroupServiceError('NOT_GROUP_MEMBER', 'User does not belong to this group');
    }

    return { group: this.copyGroup(group), member: { ...member } };
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
    const normalizedUserName = this.requireName(userName, 'INVALID_USER_NAME');
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new GroupServiceError('INVALID_LATITUDE', 'Latitude must be a number between -90 and 90');
    }
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new GroupServiceError('INVALID_LONGITUDE', 'Longitude must be a number between -180 and 180');
    }
    if (!group.members.some((member) => member.userId === userId)) {
      throw new GroupServiceError('NOT_GROUP_MEMBER', 'User does not belong to this group');
    }

    return { userId, userName: normalizedUserName, latitude, longitude };
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

  setMeetingPoint({ groupCode, userId, latitude, longitude }) {
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
    if (group.members[0]?.userId !== userId) {
      throw new GroupServiceError('NOT_GROUP_CREATOR', 'Only the group creator can set the meeting point');
    }

    group.meetingPoint = { latitude, longitude };
    return { ...group.meetingPoint };
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