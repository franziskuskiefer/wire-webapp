/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import {isObject} from 'underscore';
import ko from 'knockout';

import {ACCESS_MODE} from './AccessMode';
import {ACCESS_ROLE} from './AccessRole';
import {ACCESS_STATE} from './AccessState';
import {NOTIFICATION_STATE} from './NotificationSetting';
import {ConversationType} from './ConversationType';
import {ConversationStatus} from './ConversationStatus';
import {Conversation} from '../entity/Conversation';
import {BaseError} from '../error/BaseError';
import {ConversationError} from '../error/ConversationError';

/**
 * @typedef {object} ConversationBackendData
 * @property {string[]=} access
 * @property {string=} access_role
 * @property {string=} creator
 * @property {string=} id
 * @property {string=} last_event
 * @property {string=} last_event_time
 * @property {ConversationMembers=} members
 * @property {number=} message_timer
 * @property {string=} name
 * @property {string=} team
 * @property {number} type
 */

/**
 * @typedef {object} ConversationMembers
 * @property {OtherMember[]} others
 * @property {Member} self
 */

/**
 * @typedef {object} Member
 * @property {string=} hidden_ref
 * @property {boolean=} hidden
 * @property {string=} id
 * @property {string=} otr_archived_ref
 * @property {boolean=} otr_archived
 * @property {string=} otr_muted_ref
 * @property {boolean=} otr_muted
 * @property {ServiceRef=} service
 */

/**
 * @typedef {object} OtherMember
 * @property {string} id
 * @property {number} status
 */

/**
 * @typedef {object} SelfStatusUpdate
 * @property {number=} archived_timestamp
 * @property {number=} cleared_timestamp
 * @property {number=} ephemeral_timer
 * @property {number=} message_timer
 * @property {number=} last_event_timestamp
 * @property {number=} last_read_timestamp
 * @property {number=} last_server_timestamp
 * @property {boolean=} otr_archived
 * @property {string=} otr_archived_ref
 * @property {boolean=} otr_muted
 * @property {string=} otr_muted_ref
 * @property {boolean=} muted_state
 * @property {number=} status
 * @property {number=} verification_state
 */

/**
 * @typedef {object} ServiceRef
 * @property {string} id
 * @property {string} provider
 */

// Conversation Mapper to convert all server side JSON conversation objects into core entities.
export class ConversationMapper {
  /**
   * Converts JSON conversations into conversation entities.
   *
   * @param {Array} conversationsData Conversation data
   * @param {number} [timestamp=1] Initial timestamp for conversation
   * @returns {Array<Conversation>} Mapped conversation entities
   */
  mapConversations(conversationsData, timestamp = 1) {
    if (conversationsData === undefined) {
      throw new ConversationError(BaseError.TYPE.MISSING_PARAMETER, BaseError.MESSAGE.MISSING_PARAMETER);
    }
    if (!Array.isArray(conversationsData) || !conversationsData.length) {
      throw new ConversationError(BaseError.TYPE.INVALID_PARAMETER, BaseError.MESSAGE.INVALID_PARAMETER);
    }
    return conversationsData.map((conversationData, index) => {
      return this._createConversationEntity(conversationData, timestamp + index);
    });
  }

  /**
   * Updates all properties of a conversation specified.
   *
   * @example data: {"name":"ThisIsMyNewConversationName"}
   * @todo make utility?
   *
   * @param {Conversation} conversationEntity Conversation to be updated
   * @param {ConversationBackendData} conversationData Conversation data from backend
   * @returns {Conversation} Updated conversation entity
   */
  updateProperties(conversationEntity, conversationData) {
    Object.entries(conversationData).forEach(([key, value]) => {
      if (key !== 'id') {
        if (value !== undefined && conversationEntity.hasOwnProperty(key)) {
          if (ko.isObservable(conversationEntity[key])) {
            conversationEntity[key](value);
          } else {
            conversationEntity[key] = value;
          }
        }
      }
    });

    return conversationEntity;
  }

  /**
   * Update the membership properties of a conversation.
   *
   * @param {Conversation} conversationEntity Conversation to be updated
   * @param {SelfStatusUpdate} selfState Conversation self data from the database
   * @param {boolean} [disablePersistence=false] Disable persistence of state changes during update
   * @returns {Conversation} Updated conversation entity
   */
  updateSelfStatus(conversationEntity, selfState, disablePersistence = false) {
    if (conversationEntity) {
      if (disablePersistence) {
        conversationEntity.setStateChangePersistence(false);
      }

      // Database states
      const {
        archived_timestamp,
        cleared_timestamp,
        ephemeral_timer,
        message_timer,
        last_event_timestamp,
        last_read_timestamp,
        last_server_timestamp,
        legal_hold_status,
        muted_timestamp,
        receipt_mode,
        status,
        verification_state,
      } = selfState;

      if (archived_timestamp) {
        conversationEntity.setTimestamp(archived_timestamp, Conversation.TIMESTAMP_TYPE.ARCHIVED);
        conversationEntity.archivedState(selfState.archived_state);
      }

      if (cleared_timestamp !== undefined) {
        conversationEntity.setTimestamp(cleared_timestamp, Conversation.TIMESTAMP_TYPE.CLEARED, true);
      }

      if (ephemeral_timer !== undefined) {
        conversationEntity.localMessageTimer(ephemeral_timer);
      }

      if (message_timer !== undefined) {
        conversationEntity.globalMessageTimer(message_timer);
      }

      if (receipt_mode !== undefined) {
        conversationEntity.receiptMode(receipt_mode);
      }

      if (last_event_timestamp) {
        conversationEntity.setTimestamp(last_event_timestamp, Conversation.TIMESTAMP_TYPE.LAST_EVENT);
      }

      if (last_read_timestamp) {
        conversationEntity.setTimestamp(last_read_timestamp, Conversation.TIMESTAMP_TYPE.LAST_READ);
      }

      if (last_server_timestamp) {
        conversationEntity.setTimestamp(last_server_timestamp, Conversation.TIMESTAMP_TYPE.LAST_SERVER);
      }

      if (muted_timestamp) {
        conversationEntity.setTimestamp(muted_timestamp, Conversation.TIMESTAMP_TYPE.MUTED);
        conversationEntity.mutedState(selfState.muted_state);
      }

      if (status !== undefined) {
        conversationEntity.status(status);
      }

      if (verification_state !== undefined) {
        conversationEntity.verification_state(verification_state);
      }

      if (legal_hold_status) {
        conversationEntity.legalHoldStatus(legal_hold_status);
      }

      // Backend states
      const {otr_archived, otr_muted} = selfState;

      if (otr_archived !== undefined) {
        const archivedTimestamp = new Date(selfState.otr_archived_ref).getTime();
        conversationEntity.setTimestamp(archivedTimestamp, Conversation.TIMESTAMP_TYPE.ARCHIVED);
        conversationEntity.archivedState(otr_archived);
      }

      if (otr_muted !== undefined) {
        const mutedTimestamp = new Date(selfState.otr_muted_ref).getTime();
        conversationEntity.setTimestamp(mutedTimestamp, Conversation.TIMESTAMP_TYPE.MUTED);

        const mutedState = this.getMutedState(otr_muted, selfState.otr_muted_status);
        conversationEntity.mutedState(mutedState);
      }

      if (disablePersistence) {
        conversationEntity.setStateChangePersistence(true);
      }

      return conversationEntity;
    }
  }

  /**
   * Creates a conversation entity from backend JSON data.
   *
   * @private
   * @param {Object} conversationData Either locally stored or backend data
   * @param {number} [initialTimestamp] Initial timestamp for conversation in milliseconds
   * @returns {Conversation} Mapped conversation entity
   */
  _createConversationEntity(conversationData, initialTimestamp) {
    if (conversationData === undefined) {
      throw new ConversationError(BaseError.TYPE.MISSING_PARAMETER, BaseError.MESSAGE.MISSING_PARAMETER);
    }
    if (!isObject(conversationData) || !Object.keys(conversationData).length) {
      throw new ConversationError(BaseError.TYPE.INVALID_PARAMETER, BaseError.MESSAGE.INVALID_PARAMETER);
    }

    const {creator, id, members, name, others, type} = conversationData;
    let conversationEntity = new Conversation(id);
    conversationEntity.roles(conversationData.roles || {});

    conversationEntity.creator = creator;
    conversationEntity.type(type);
    conversationEntity.name(name || '');

    const selfState = members ? members.self : conversationData;
    conversationEntity = this.updateSelfStatus(conversationEntity, selfState);

    if (!conversationEntity.last_event_timestamp() && initialTimestamp) {
      conversationEntity.last_event_timestamp(initialTimestamp);
      conversationEntity.last_server_timestamp(initialTimestamp);
    }

    // Active participants from database or backend payload
    const participatingUserIds = others || members.others.map(other => other.id);
    conversationEntity.participating_user_ids(participatingUserIds);

    // Team ID from database or backend payload
    const teamId = conversationData.team_id || conversationData.team;
    if (teamId) {
      conversationEntity.team_id = teamId;
    }

    if (conversationData.is_guest) {
      conversationEntity.isGuest(conversationData.is_guest);
    }

    // Access related data
    const accessModes = conversationData.accessModes || conversationData.access;
    const accessRole = conversationData.accessRole || conversationData.access_role;
    if (accessModes && accessRole) {
      this.mapAccessState(conversationEntity, accessModes, accessRole);
    }

    conversationEntity.receiptMode(conversationData.receipt_mode);

    return conversationEntity;
  }

  /**
   * Get the valid muted state.
   *
   * @param {boolean} mutedState Outdated muted state
   * @param {NOTIFICATION_STATE} [notificationState] Bit mask based notification setting
   * @returns {NOTIFICATION_STATE} validated notification setting
   */
  getMutedState(mutedState, notificationState) {
    const validNotificationStates = Object.values(NOTIFICATION_STATE);
    if (validNotificationStates.includes(notificationState)) {
      // Ensure bit at offset 0 to be 1 for backwards compatibility of deprecated boolean based state is true
      return mutedState ? notificationState | 0b1 : NOTIFICATION_STATE.EVERYTHING;
    }

    return typeof mutedState === 'boolean' ? mutedState : NOTIFICATION_STATE.EVERYTHING;
  }

  /**
   * Merge local database records with remote backend payload.
   *
   * @param {Array<Object>} localConversations Database records
   * @param {Array<Object>} remoteConversations Backend payload
   * @returns {Array<Object>} Merged conversation data
   */
  mergeConversation(localConversations, remoteConversations) {
    localConversations = localConversations.filter(conversationData => conversationData);

    return remoteConversations.map((remoteConversationData, index) => {
      const conversationId = remoteConversationData.id;
      const localConversationData = localConversations.find(({id}) => id === conversationId) || {id: conversationId};

      const {
        access,
        access_role,
        creator,
        members,
        message_timer,
        name,
        receipt_mode,
        team,
        type,
      } = remoteConversationData;
      const {others: othersStates, self: selfState} = members;

      const updates = {
        accessModes: access,
        accessRole: access_role,
        creator,
        message_timer,
        name,
        receipt_mode,
        roles: {},
        status: selfState.status,
        team_id: team,
        type,
      };

      // Add roles for self
      if (selfState.conversation_role && !(selfState.id in updates.roles)) {
        updates.roles[selfState.id] = selfState.conversation_role;
      }

      // Add roles for others
      othersStates.map(other => {
        if (other.conversation_role && !(other.conversation_role in updates.roles)) {
          updates.roles[other.id] = other.conversation_role;
        }
      });

      if (typeof localConversationData.receipt_mode === 'number') {
        updates.receipt_mode = localConversationData.receipt_mode;
      }

      const mergedConversation = {...localConversationData, ...updates};

      const isGroup = type === ConversationType.GROUP;
      const noOthers = !mergedConversation.others || !mergedConversation.others.length;
      if (isGroup || noOthers) {
        mergedConversation.others = othersStates
          .filter(otherState => otherState.status === ConversationStatus.CURRENT_MEMBER)
          .map(otherState => otherState.id);
      }

      // This should ensure a proper order
      if (!mergedConversation.last_event_timestamp) {
        mergedConversation.last_event_timestamp = index + 1;
      }

      // Set initially or correct server timestamp
      const wrongServerTimestamp = mergedConversation.last_server_timestamp < mergedConversation.last_event_timestamp;
      if (!mergedConversation.last_server_timestamp || wrongServerTimestamp) {
        mergedConversation.last_server_timestamp = mergedConversation.last_event_timestamp;
      }

      const isRemoteTimestampNewer = (localTimestamp, remoteTimestamp) => {
        return localTimestamp !== undefined && remoteTimestamp > localTimestamp;
      };

      // Some archived timestamp were not properly stored in the database.
      // To fix this we check if the remote one is newer and update our local timestamp.
      const {archived_state: archivedState, archived_timestamp: archivedTimestamp} = localConversationData;
      const remoteArchivedTimestamp = new Date(selfState.otr_archived_ref).getTime();
      const isRemoteArchivedTimestampNewer = isRemoteTimestampNewer(archivedTimestamp, remoteArchivedTimestamp);

      if (isRemoteArchivedTimestampNewer || archivedState === undefined) {
        mergedConversation.archived_state = selfState.otr_archived;
        mergedConversation.archived_timestamp = remoteArchivedTimestamp;
      }

      const {muted_state: mutedState, muted_timestamp: mutedTimestamp} = localConversationData;
      const remoteMutedTimestamp = new Date(selfState.otr_muted_ref).getTime();
      const isRemoteMutedTimestampNewer = isRemoteTimestampNewer(mutedTimestamp, remoteMutedTimestamp);

      if (isRemoteMutedTimestampNewer || mutedState === undefined) {
        const remoteMutedState = this.getMutedState(selfState.otr_muted, selfState.otr_muted_status);
        mergedConversation.muted_state = remoteMutedState;
        mergedConversation.muted_timestamp = remoteMutedTimestamp;
      }

      return mergedConversation;
    });
  }

  mapAccessCode(conversationEntity, accessCode) {
    const isTeamConversation = conversationEntity && conversationEntity.team_id;

    if (accessCode.uri && isTeamConversation) {
      const accessCodeUrl = `${window.wire.env.APP_BASE}/join/?key=${accessCode.key}&code=${accessCode.code}`;
      conversationEntity.accessCode(accessCodeUrl);
    }
  }

  mapAccessState(conversationEntity, accessModes, accessRole) {
    if (conversationEntity.team_id) {
      if (conversationEntity.is1to1()) {
        return conversationEntity.accessState(ACCESS_STATE.TEAM.ONE2ONE);
      }

      const isTeamRole = accessRole === ACCESS_ROLE.TEAM;

      const includesInviteMode = accessModes.includes(ACCESS_MODE.INVITE);
      const isInviteModeOnly = includesInviteMode && accessModes.length === 1;

      const isTeamOnlyMode = isTeamRole && isInviteModeOnly;
      if (isTeamOnlyMode) {
        return conversationEntity.accessState(ACCESS_STATE.TEAM.TEAM_ONLY);
      }

      const isNonVerifiedRole = accessRole === ACCESS_ROLE.NON_ACTIVATED;

      const includesCodeMode = accessModes.includes(ACCESS_MODE.CODE);
      const isExpectedModes = includesCodeMode && includesInviteMode && accessModes.length === 2;

      const isGuestRoomMode = isNonVerifiedRole && isExpectedModes;
      return isGuestRoomMode
        ? conversationEntity.accessState(ACCESS_STATE.TEAM.GUEST_ROOM)
        : conversationEntity.accessState(ACCESS_STATE.TEAM.LEGACY);
    }

    if (conversationEntity.isSelf()) {
      return conversationEntity.accessState(ACCESS_STATE.SELF);
    }

    const personalAccessState = conversationEntity.isGroup()
      ? ACCESS_STATE.PERSONAL.GROUP
      : ACCESS_STATE.PERSONAL.ONE2ONE;
    return conversationEntity.accessState(personalAccessState);
  }
}
