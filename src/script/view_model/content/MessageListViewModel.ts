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

import $ from 'jquery';
import {groupBy} from 'underscore';
import {WebAppEvents} from '@wireapp/webapp-events';
import {amplify} from 'amplify';
import ko from 'knockout';

import {getLogger, Logger} from 'Util/Logger';
import {scrollEnd, scrollToBottom, scrollBy} from 'Util/scroll-helpers';
import {t} from 'Util/LocalizerUtil';
import {safeWindowOpen, safeMailOpen} from 'Util/SanitizationUtil';
import {isSameDay, differenceInMinutes} from 'Util/TimeUtil';

import {Config} from '../../Config';
import {Conversation} from '../../entity/Conversation';
import {ModalsViewModel} from '../ModalsViewModel';
import {MessageCategory} from '../../message/MessageCategory';
import {MotionDuration} from '../../motion/MotionDuration';
import {UserError} from '../../error/UserError';
import {MemberMessage} from '../../entity/message/MemberMessage';
import {ContentMessage} from '../../entity/message/ContentMessage';
import {User} from '../../entity/User';
import {DecryptErrorMessage} from '../../entity/message/DecryptErrorMessage';
import {Message} from '../../entity/message/Message';
import {Text} from '../../entity/message/Text';
import {Participant} from '../../calling/Participant';
import {MainViewModel} from '../MainViewModel';
import {ConversationRepository} from '../../conversation/ConversationRepository';
import {IntegrationRepository} from '../../integration/IntegrationRepository';
import {ServerTimeHandler} from '../../time/serverTimeHandler';
import {UserRepository} from '../../user/UserRepository';
import {ActionsViewModel} from '../ActionsViewModel';
import {PanelViewModel} from '../PanelViewModel';
/*
 * Message list rendering view model.
 *
 * @todo Get rid of the participants dependencies whenever bubble implementation has changed
 * @todo Remove all jQuery selectors
 */
export class MessageListViewModel {
  private readonly logger: Logger;
  readonly actionsViewModel: ActionsViewModel;
  readonly selfUser: ko.Observable<User>;
  readonly focusedMessage: ko.Observable<any>;
  readonly conversation: ko.Observable<Conversation>;
  readonly verticallyCenterMessage: ko.PureComputed<boolean>;
  private readonly conversationLoaded: ko.Observable<boolean>;
  conversationLastReadTimestamp: number;
  private readonly readMessagesBuffer: ko.ObservableArray<{conversation: Conversation; message: Message}>;
  private messagesChangeSubscription: ko.Subscription;
  private messagesBeforeChangeSubscription: ko.Subscription;
  private messagesContainer: HTMLElement;
  showInvitePeople: ko.PureComputed<boolean>;

  constructor(
    private readonly mainViewModel: MainViewModel,
    private readonly conversationRepository: ConversationRepository,
    private readonly integrationRepository: IntegrationRepository,
    private readonly serverTimeHandler: ServerTimeHandler,
    private readonly userRepository: UserRepository,
  ) {
    this.mainViewModel = mainViewModel;
    this.logger = getLogger('MessageListViewModel');

    this.actionsViewModel = this.mainViewModel.actions;
    this.selfUser = this.userRepository.self;
    this.focusedMessage = ko.observable(null);

    this.conversation = ko.observable(new Conversation());
    this.verticallyCenterMessage = ko.pureComputed(() => {
      if (this.conversation().messages_visible().length === 1) {
        const [messageEntity] = this.conversation().messages_visible();
        if (messageEntity instanceof MemberMessage) {
          return messageEntity.isMember() && messageEntity.isConnection();
        }
        return false;
      }
      return false;
    });

    amplify.subscribe(WebAppEvents.INPUT.RESIZE, this.handleInputResize);

    this.conversationLoaded = ko.observable(false);
    // Store last read to show until user switches conversation
    this.conversationLastReadTimestamp = undefined;

    // this buffer will collect all the read messages and send a read receipt in batch
    this.readMessagesBuffer = ko.observableArray();

    this.readMessagesBuffer
      .extend({rateLimit: {method: 'notifyWhenChangesStop', timeout: 500}})
      .subscribe(readMessages => {
        if (readMessages.length) {
          const groupedMessages = groupBy(readMessages, ({conversation, message}) => conversation.id + message.from);
          Object.values(groupedMessages).forEach(readMessagesBatch => {
            const {conversation, message: firstMessage} = readMessagesBatch.pop();
            const otherMessages = readMessagesBatch.map(({message}) => message);
            this.conversationRepository.sendReadReceipt(conversation, firstMessage, otherMessages);
          });
          this.readMessagesBuffer.removeAll();
        }
      });

    // Store message subscription id
    this.messagesChangeSubscription = undefined;
    this.messagesBeforeChangeSubscription = undefined;

    this.messagesContainer = undefined;

    this.showInvitePeople = ko.pureComputed(() => {
      return (
        this.conversation().isActiveParticipant() && this.conversation().inTeam() && this.conversation().isGuestRoom()
      );
    });
  }

  onMessageContainerInitiated = (messagesContainer: HTMLElement): void => {
    this.messagesContainer = messagesContainer;
  };

  release_conversation = (conversation_et: Conversation): void => {
    if (conversation_et) {
      conversation_et.release();
    }
    if (this.messagesBeforeChangeSubscription) {
      this.messagesBeforeChangeSubscription.dispose();
    }
    if (this.messagesChangeSubscription) {
      this.messagesChangeSubscription.dispose();
    }
    this.conversationLastReadTimestamp = undefined;
    window.removeEventListener('resize', this.adjustScroll);
  };

  private readonly shouldStickToBottom = (): boolean => {
    const messagesContainer = this.getMessagesContainer();
    const scrollPosition = Math.ceil(messagesContainer.scrollTop);
    const scrollEndValue = Math.ceil(scrollEnd(messagesContainer));
    return scrollPosition > scrollEndValue - Config.getConfig().SCROLL_TO_LAST_MESSAGE_THRESHOLD;
  };

  readonly adjustScroll = (): void => {
    if (this.shouldStickToBottom()) {
      scrollToBottom(this.getMessagesContainer());
    }
  };

  private readonly handleInputResize = (inputSizeDiff: number): void => {
    if (inputSizeDiff) {
      scrollBy(this.getMessagesContainer(), inputSizeDiff);
    } else if (this.shouldStickToBottom()) {
      scrollToBottom(this.getMessagesContainer());
    }
  };

  changeConversation = async (conversationEntity: Conversation, messageEntity: Message): Promise<void> => {
    // Clean up old conversation
    this.conversationLoaded(false);
    if (this.conversation()) {
      this.release_conversation(this.conversation());
    }

    // Update new conversation
    this.logger.info('conversationEntity', conversationEntity);
    this.conversation(conversationEntity);

    // Keep last read timestamp to render unread when entering conversation
    if (this.conversation().unreadState().allEvents.length) {
      this.conversationLastReadTimestamp = this.conversation().last_read_timestamp();
    }

    conversationEntity.is_loaded(false);
    await this.loadConversation(conversationEntity, messageEntity);
    await this.renderConversation(conversationEntity, messageEntity);
    conversationEntity.is_loaded(true);
    this.conversationLoaded(true);
  };

  private readonly loadConversation = async (
    conversationEntity: Conversation,
    messageEntity: Message,
  ): Promise<void> => {
    const _conversationEntity = await this.conversationRepository.updateParticipatingUserEntities(
      conversationEntity,
      false,
      true,
    );

    if (messageEntity) {
      this.conversationRepository.getMessagesWithOffset(_conversationEntity, messageEntity);
    } else {
      this.conversationRepository.getPrecedingMessages(_conversationEntity);
    }
  };

  private readonly isLastReceivedMessage = (messageEntity: Message, conversationEntity: Conversation): boolean => {
    return messageEntity.timestamp() && messageEntity.timestamp() >= conversationEntity.last_event_timestamp();
  };

  getMessagesContainer = () => {
    return this.messagesContainer;
  };

  private readonly renderConversation = (conversationEntity: Conversation, messageEntity: Message): Promise<void> => {
    const messages_container = this.getMessagesContainer();

    const is_current_conversation = conversationEntity === this.conversation();
    if (!is_current_conversation) {
      this.logger.info(`Skipped re-loading current conversation '${conversationEntity.display_name()}'`);
      return Promise.resolve();
    }

    return new Promise(resolve => {
      window.setTimeout(() => {
        // Reset scroll position
        messages_container.scrollTop = 0;

        if (messageEntity) {
          this.focusMessage(messageEntity.id);
        } else {
          const unread_message = $('.message-timestamp-unread');
          if (unread_message.length) {
            const unreadMarkerPosition = unread_message.parents('.message').position();

            scrollBy(messages_container, unreadMarkerPosition.top);
          } else {
            scrollToBottom(messages_container);
          }
        }

        window.addEventListener('resize', this.adjustScroll);

        let shouldStickToBottomOnMessageAdd: boolean;

        this.messagesBeforeChangeSubscription = conversationEntity.messages_visible.subscribe(
          () => {
            // we need to keep track of the scroll position before the message array has changed
            shouldStickToBottomOnMessageAdd = this.shouldStickToBottom();
          },
          null,
          'beforeChange',
        );

        // Subscribe for incoming messages
        this.messagesChangeSubscription = conversationEntity.messages_visible.subscribe(
          changedMessages => {
            this.scrollAddedMessagesIntoView(changedMessages, shouldStickToBottomOnMessageAdd);
            shouldStickToBottomOnMessageAdd = undefined;
          },
          null,
          'arrayChange',
        );
        resolve();
      }, 100);
    });
  };

  private readonly scrollAddedMessagesIntoView = (
    changedMessages: ko.utils.ArrayChanges<ContentMessage | MemberMessage>,
    shouldStickToBottom: boolean,
  ) => {
    const messages_container = this.getMessagesContainer();
    const lastAddedItem = changedMessages
      .slice()
      .reverse()
      .find(changedMessage => changedMessage.status === 'added');

    // We are only interested in items that were added
    if (!lastAddedItem) {
      return;
    }

    const lastMessage = lastAddedItem.value;

    if (lastMessage) {
      // Message was prepended
      if (lastMessage.timestamp() < this.conversation().last_event_timestamp()) {
        return;
      }

      // Scroll to bottom if self user send the message
      if (lastMessage.from === this.selfUser().id) {
        window.requestAnimationFrame(() => scrollToBottom(messages_container));
        return;
      }
    }

    // Scroll to the end of the list if we are under a certain threshold
    if (shouldStickToBottom) {
      window.requestAnimationFrame(() => scrollToBottom(messages_container));
    }
  };

  loadPrecedingMessages = async (): Promise<void> => {
    const shouldPullMessages = !this.conversation().is_pending() && this.conversation().hasAdditionalMessages();
    const messagesContainer = this.getMessagesContainer();

    if (shouldPullMessages && messagesContainer) {
      const initialListHeight = messagesContainer.scrollHeight;

      await this.conversationRepository.getPrecedingMessages(this.conversation());
      if (messagesContainer) {
        const newListHeight = messagesContainer.scrollHeight;
        this.getMessagesContainer().scrollTop = newListHeight - initialListHeight;
      }
      return;
    }
    return Promise.resolve();
  };

  loadFollowingMessages = (): Promise<void> => {
    const lastMessage = this.conversation().getLastMessage();

    if (lastMessage) {
      if (!this.isLastReceivedMessage(lastMessage, this.conversation())) {
        // if the last loaded message is not the last of the conversation, we load the subsequent messages
        return this.conversationRepository.getSubsequentMessages(this.conversation(), lastMessage, false);
      }
      if (document.hasFocus()) {
        // if the message is the last of the conversation and the app is in the foreground, then we update the last read timestamp of the conversation
        this.updateConversationLastRead(this.conversation(), lastMessage);
      }
    }
    return Promise.resolve();
  };

  focusMessage = async (messageId: string): Promise<void> => {
    const messageIsLoaded = !!this.conversation().getMessage(messageId);
    this.focusedMessage(messageId);

    if (!messageIsLoaded) {
      const conversationEntity = this.conversation();
      const messageEntity = await this.conversationRepository.getMessageInConversationById(
        conversationEntity,
        messageId,
      );
      conversationEntity.remove_messages();
      this.conversationRepository.getMessagesWithOffset(conversationEntity, messageEntity);
    }
  };

  onMessageMarked = (messageElement: HTMLElement) => {
    const messagesContainer = this.getMessagesContainer();
    messageElement.classList.remove('message-marked');
    scrollBy(messagesContainer, messageElement.getBoundingClientRect().top - messagesContainer.offsetHeight / 2);
    messageElement.classList.add('message-marked');
    this.focusedMessage(null);
  };

  showUserDetails = (userEntity: User): void => {
    userEntity = ko.unwrap(userEntity);
    const conversationEntity = this.conversationRepository.active_conversation();
    const isSingleModeConversation = conversationEntity.is1to1() || conversationEntity.isRequest();

    if (userEntity.isDeleted || (isSingleModeConversation && !userEntity.isMe)) {
      return this.mainViewModel.panel.togglePanel(PanelViewModel.STATE.CONVERSATION_DETAILS, undefined);
    }

    const params = {entity: userEntity};
    const panelId = userEntity.isService
      ? PanelViewModel.STATE.GROUP_PARTICIPANT_SERVICE
      : PanelViewModel.STATE.GROUP_PARTICIPANT_USER;

    this.mainViewModel.panel.togglePanel(panelId, params);
  };

  on_session_reset_click = async (message_et: DecryptErrorMessage): Promise<void> => {
    const reset_progress = () =>
      window.setTimeout(() => {
        message_et.is_resetting_session(false);
        amplify.publish(WebAppEvents.WARNING.MODAL, ModalsViewModel.TYPE.SESSION_RESET);
      }, MotionDuration.LONG);

    message_et.is_resetting_session(true);
    try {
      await this.conversationRepository.reset_session(message_et.from, message_et.client_id, this.conversation().id);
      reset_progress();
    } catch (error) {
      this.logger.warn('Error while trying to reset_session', error);
      reset_progress();
    }
  };

  show_detail = async (message_et: Message, event: MouseEvent): Promise<void> => {
    if (message_et.is_expired() || $(event.currentTarget).hasClass('image-asset--no-image')) {
      return;
    }

    const items: Message[] = await this.conversationRepository.get_events_for_category(
      this.conversation(),
      MessageCategory.IMAGE,
    );
    const message_ets = items.filter(
      item => item.category & MessageCategory.IMAGE && !(item.category & MessageCategory.GIF),
    );
    const [image_message_et] = message_ets.filter(item => item.id === message_et.id);

    amplify.publish(WebAppEvents.CONVERSATION.DETAIL_VIEW.SHOW, image_message_et || message_et, message_ets);
  };

  get_timestamp_class = (messageEntity: ContentMessage): string => {
    const previousMessage = this.conversation().get_previous_message(messageEntity);
    if (!previousMessage || messageEntity.is_call()) {
      return '';
    }

    const isFirstUnread =
      previousMessage.timestamp() <= this.conversationLastReadTimestamp &&
      messageEntity.timestamp() > this.conversationLastReadTimestamp;

    if (isFirstUnread) {
      return 'message-timestamp-visible message-timestamp-unread';
    }

    const last = previousMessage.timestamp();
    const current = messageEntity.timestamp();

    if (!isSameDay(last, current)) {
      return 'message-timestamp-visible message-timestamp-day';
    }

    if (differenceInMinutes(current, last) > 60) {
      return 'message-timestamp-visible';
    }

    return '';
  };

  should_hide_user_avatar = (message_et: ContentMessage): boolean => {
    // @todo avoid double check
    if (this.get_timestamp_class(message_et)) {
      return false;
    }

    if (message_et.is_content() && message_et.replacing_message_id) {
      return false;
    }

    const last_message = this.conversation().get_previous_message(message_et);
    return last_message && last_message.is_content() && last_message.user().id === message_et.user().id;
  };

  is_last_delivered_message = (message_et: Message): boolean => {
    return this.conversation().getLastDeliveredMessage() === message_et;
  };

  click_on_cancel_request = (messageEntity: MemberMessage): void => {
    const conversationEntity = this.conversationRepository.active_conversation();
    const nextConversationEntity = this.conversationRepository.get_next_conversation(conversationEntity);
    this.actionsViewModel.cancelConnectionRequest(messageEntity.otherUser(), true, nextConversationEntity);
  };

  click_on_like = (message_et: Message): void => {
    this.conversationRepository.toggle_like(this.conversation(), message_et);
  };

  clickOnInvitePeople = (): void => {
    this.mainViewModel.panel.togglePanel(PanelViewModel.STATE.GUEST_OPTIONS, undefined);
  };

  getInViewportCallback = (conversationEntity: Conversation, messageEntity: MemberMessage): Function | null => {
    const messageTimestamp = messageEntity.timestamp();
    const callbacks: Function[] = [];

    if (!messageEntity.is_ephemeral()) {
      const isCreationMessage = messageEntity.isMember() && messageEntity.isCreation();
      if (conversationEntity.is1to1() && isCreationMessage) {
        this.integrationRepository.addProviderNameToParticipant(messageEntity.otherUser());
      }
    }

    const sendReadReceipt = () => {
      // add the message in the buffer of read messages (actual read receipt will be sent in the next batch)
      this.readMessagesBuffer.push({conversation: conversationEntity, message: messageEntity});
    };

    const updateLastRead = () => {
      conversationEntity.setTimestamp(messageEntity.timestamp(), Conversation.TIMESTAMP_TYPE.LAST_READ);
    };

    const startTimer = async () => {
      if (messageEntity.conversation_id === conversationEntity.id) {
        await this.conversationRepository.checkMessageTimer(messageEntity);
      }
    };

    if (messageEntity.is_ephemeral()) {
      callbacks.push(startTimer);
    }

    const isUnreadMessage = messageTimestamp > conversationEntity.last_read_timestamp();
    const isNotOwnMessage = !messageEntity.user().isMe;

    let shouldSendReadReceipt = false;

    if (messageEntity.expectsReadConfirmation) {
      if (conversationEntity.is1to1()) {
        shouldSendReadReceipt = this.conversationRepository.expectReadReceipt(conversationEntity);
      } else if (conversationEntity.isGroup() && (conversationEntity.inTeam() || conversationEntity.isGuestRoom())) {
        shouldSendReadReceipt = true;
      }
    }

    if (this.isLastReceivedMessage(messageEntity, conversationEntity)) {
      callbacks.push(() => this.updateConversationLastRead(conversationEntity, messageEntity));
    }

    if (isUnreadMessage && isNotOwnMessage) {
      callbacks.push(updateLastRead);
      if (shouldSendReadReceipt) {
        callbacks.push(sendReadReceipt);
      }
    }

    if (!callbacks.length) {
      return null;
    }

    return () => {
      const trigger = () => callbacks.forEach(callback => callback());
      return document.hasFocus() ? trigger() : $(window).one('focus', trigger);
    };
  };

  updateConversationLastRead = (conversationEntity: Conversation, messageEntity: Message): void => {
    const conversationLastRead = conversationEntity.last_read_timestamp();
    const lastKnownTimestamp = conversationEntity.get_last_known_timestamp(this.serverTimeHandler.toServerTimestamp());
    const needsUpdate = conversationLastRead < lastKnownTimestamp;
    if (needsUpdate && this.isLastReceivedMessage(messageEntity, conversationEntity)) {
      conversationEntity.setTimestamp(lastKnownTimestamp, Conversation.TIMESTAMP_TYPE.LAST_READ);
      this.conversationRepository.markAsRead(conversationEntity);
    }
  };

  handleClickOnMessage = (messageEntity: ContentMessage | Text, event: MouseEvent) => {
    const emailTarget: HTMLAnchorElement = (event.target as HTMLElement).closest('[data-email-link]');
    if (emailTarget) {
      safeMailOpen(emailTarget.href);
      return false;
    }
    const linkTarget: HTMLAnchorElement = (event.target as HTMLElement).closest('[data-md-link]');
    if (linkTarget) {
      const href = linkTarget.href;
      amplify.publish(WebAppEvents.WARNING.MODAL, ModalsViewModel.TYPE.CONFIRM, {
        primaryAction: {
          action: () => {
            safeWindowOpen(href);
          },
          text: t('modalOpenLinkAction'),
        },
        text: {
          message: t('modalOpenLinkMessage', href),
          title: t('modalOpenLinkTitle'),
        },
      });
      return false;
    }
    const hasMentions = messageEntity instanceof Text && messageEntity.mentions().length;
    const mentionElement = hasMentions && (event.target as HTMLElement).closest('.message-mention');
    const userId = mentionElement && (mentionElement as any).dataset.userId;

    if (userId) {
      (async () => {
        try {
          const userEntity = await this.userRepository.getUserById(userId);
          this.showUserDetails(userEntity);
        } catch (error) {
          if (error.type !== UserError.TYPE.USER_NOT_FOUND) {
            throw error;
          }
        }
      })();
    }

    // need to return `true` because knockout will prevent default if we return anything else (including undefined)
    return true;
  };

  showParticipants = (participants: Participant[]): void => {
    this.mainViewModel.panel.togglePanel(PanelViewModel.STATE.CONVERSATION_PARTICIPANTS, participants);
  };

  showMessageDetails = (view: {message: {id: string}}, showLikes: boolean): void => {
    if (!this.conversation().is1to1()) {
      this.mainViewModel.panel.togglePanel(PanelViewModel.STATE.MESSAGE_DETAILS, {
        entity: {id: view.message.id},
        showLikes,
      });
    }
  };
}
