function registerGroupSocketHandlers(io, groupService) {
  const activeMembers = new Map();
  const socketMemberships = new Map();

  io.on('connection', (socket) => {
    socket.on('create_group', async (payload = {}, acknowledge) => {
      try {
        const group = groupService.createGroup(payload);
        await socket.join(group.groupCode);
        associateSocket(activeMembers, socketMemberships, socket, group.groupCode, payload.userId);
        socket.emit('group_created', group);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: true, group });
        }
      } catch (error) {
        acknowledgeError(acknowledge, error);
      }
    });

    socket.on('join_group', async (payload = {}, acknowledge) => {
      try {
        const result = groupService.joinGroup(payload);
        await socket.join(result.group.groupCode);
        associateSocket(
          activeMembers,
          socketMemberships,
          socket,
          result.group.groupCode,
          result.member.userId,
        );
        if (result.memberJoined) {
          socket.to(result.group.groupCode).emit('member_joined', {
            ...result.member,
            groupCode: result.group.groupCode,
          });
        }
        socket.emit('group_joined', result.group);
        socket.emit('group_locations', {
          groupCode: result.group.groupCode,
          locations: groupService.getMemberLocations(
            result.group.groupCode,
            result.member.userId,
          ),
        });
        if (result.group.meetingPoint) {
          socket.emit('meeting_point', result.group.meetingPoint);
        }
        if (typeof acknowledge === 'function') {
          acknowledge({ success: true, group: result.group });
        }
      } catch (error) {
        acknowledgeError(acknowledge, error);
      }
    });

    socket.on('rejoin_group', async (payload = {}, acknowledge) => {
      try {
        const result = groupService.rejoinGroup(payload);
        await socket.join(result.group.groupCode);
        associateSocket(
          activeMembers,
          socketMemberships,
          socket,
          result.group.groupCode,
          result.member.userId,
        );
        socket.emit('group_rejoined', result.group);
        socket.emit('group_locations', {
          groupCode: result.group.groupCode,
          locations: groupService.getMemberLocations(
            result.group.groupCode,
            result.member.userId,
          ),
        });
        if (result.group.meetingPoint) {
          socket.emit('meeting_point', result.group.meetingPoint);
        }
        socket.to(result.group.groupCode).emit('member_rejoined', {
          ...result.member,
          groupCode: result.group.groupCode,
        });
        if (typeof acknowledge === 'function') {
          acknowledge({ success: true, group: result.group });
        }
      } catch (error) {
        acknowledgeError(acknowledge, error);
      }
    });

    socket.on('location_update', (payload = {}, acknowledge) => {
      try {
        const location = groupService.validateMemberLocation(payload);
        const isAssociated = (socketMemberships.get(socket) || []).some(
          (membership) => membership.groupCode === payload.groupCode
            && membership.userId === payload.userId,
        );
        if (!isAssociated || !socket.rooms.has(payload.groupCode)) {
          const error = new Error('This socket has not joined the group as this user');
          error.code = 'NOT_GROUP_MEMBER';
          throw error;
        }

        groupService.storeMemberLocation(payload.groupCode, location);
        // Room-scoped delivery prevents location data from crossing group boundaries.
        socket.to(payload.groupCode).emit('member_location_updated', location);
        if (typeof acknowledge === 'function') acknowledge({ success: true, location });
      } catch (error) {
        const response = {
          success: false,
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: error.message || 'Unable to process location update',
          },
        };
        socket.emit('location_update_error', response.error);
        if (typeof acknowledge === 'function') acknowledge(response);
      }
    });

    socket.on('set_meeting_point', (payload = {}, acknowledge) => {
      try {
        const isAssociated = (socketMemberships.get(socket) || []).some(
          (membership) => membership.groupCode === payload.groupCode
            && membership.userId === payload.userId,
        );
        if (!isAssociated || !socket.rooms.has(payload.groupCode)) {
          const error = new Error('This socket has not joined the group as this user');
          error.code = 'NOT_GROUP_MEMBER';
          throw error;
        }

        const meetingPoint = groupService.setMeetingPoint(payload);
        io.to(payload.groupCode).emit('meeting_point_updated', meetingPoint);
        if (typeof acknowledge === 'function') acknowledge({ success: true, meetingPoint });
      } catch (error) {
        const response = {
          success: false,
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: error.message || 'Unable to set meeting point',
          },
        };
        socket.emit('set_meeting_point_error', response.error);
        if (typeof acknowledge === 'function') acknowledge(response);
      }
    });

    socket.on('disconnect', () => {
      const memberships = socketMemberships.get(socket) || [];
      socketMemberships.delete(socket);
      for (const { groupCode, userId } of memberships) {
        const groupMembers = activeMembers.get(groupCode);
        const memberSockets = groupMembers?.get(userId);
        if (!memberSockets) continue;
        memberSockets.delete(socket);
        if (memberSockets.size > 0) continue;

        groupMembers.delete(userId);
        if (groupMembers.size === 0) activeMembers.delete(groupCode);
        groupService.removeMemberLocation(groupCode, userId);
        io.to(groupCode).emit('member_location_removed', { userId });
      }
    });
  });
}

function associateSocket(activeMembers, socketMemberships, socket, groupCode, userId) {
  let groupMembers = activeMembers.get(groupCode);
  if (!groupMembers) {
    groupMembers = new Map();
    activeMembers.set(groupCode, groupMembers);
  }
  let memberSockets = groupMembers.get(userId);
  if (!memberSockets) {
    memberSockets = new Set();
    groupMembers.set(userId, memberSockets);
  }
  memberSockets.add(socket);

  const memberships = socketMemberships.get(socket) || [];
  if (!memberships.some((membership) => (
    membership.groupCode === groupCode && membership.userId === userId
  ))) {
    memberships.push({ groupCode, userId });
    socketMemberships.set(socket, memberships);
  }
}

function acknowledgeError(acknowledge, error) {
  if (typeof acknowledge !== 'function') return;
  acknowledge({
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'Unable to process group request',
    },
  });
}

module.exports = registerGroupSocketHandlers;