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

import ko from 'knockout';

import {noop} from 'Util/util';

import {AssetTransferState} from '../../../assets/AssetTransferState';
import {File as FileAsset} from '../../../entity/message/File';
import {AbstractAssetTransferStateTracker} from '../AbstractAssetTransferStateTracker';

import '../assetLoader';

interface MediaButtonComponentParams {
  asset: FileAsset;
  cancel?: () => void;
  large: boolean;
  pause?: () => void;
  play?: () => void;
  src: HTMLMediaElement;
  transferState: ko.PureComputed<AssetTransferState>;
  uploadProgress: ko.PureComputed<number>;
}

class MediaButtonComponent extends AbstractAssetTransferStateTracker {
  readonly asset: FileAsset;
  readonly isPlaying: ko.Observable<boolean>;
  readonly large: boolean;
  readonly mediaElement: HTMLMediaElement;
  readonly onClickCancel: () => void;
  readonly onClickPause: () => void;
  readonly onClickPlay: () => void;

  constructor(params: MediaButtonComponentParams, componentInfo: ko.components.ComponentInfo) {
    super();
    this.mediaElement = params.src;
    this.large = params.large;
    this.asset = params.asset;
    this.uploadProgress = params.uploadProgress;
    this.transferState = params.transferState;

    if (this.large) {
      (componentInfo.element as HTMLElement).classList.add('media-button-lg');
    }

    this.isPlaying = ko.observable(false);

    this.onClickPlay = typeof params.play === 'function' ? () => params.play() : noop;
    this.onClickPause = typeof params.pause === 'function' ? () => params.pause() : noop;
    this.onClickCancel = typeof params.cancel === 'function' ? () => params.cancel() : noop;

    this.mediaElement.addEventListener('playing', this.onPlay);
    this.mediaElement.addEventListener('pause', this.onPause);
  }

  onPlay = () => {
    this.isPlaying(true);
  };

  onPause = () => {
    this.isPlaying(false);
  };

  dispose = () => {
    this.mediaElement.removeEventListener('playing', this.onPlay);
    this.mediaElement.removeEventListener('pause', this.onPause);
  };
}

ko.components.register('media-button', {
  template: `
    <!-- ko if: isUploaded(transferState()) -->
      <div class='media-button media-button-play icon-play' data-bind="click: onClickPlay, visible: !isPlaying()" data-uie-name="do-play-media"></div>
      <div class='media-button media-button-pause icon-pause' data-bind="click: onClickPause, visible: isPlaying()" data-uie-name="do-pause-media"></div>
    <!-- /ko -->
    <!-- ko if: isDownloading(transferState()) -->
      <asset-loader params="large: large, loadProgress: asset.downloadProgress, onCancel: asset.cancel_download"></asset-loader>
    <!-- /ko -->
    <!-- ko if: isUploading(transferState()) -->
      <asset-loader params="large: large, loadProgress: uploadProgress, onCancel: onClickCancel"></asset-loader>
    <!-- /ko -->
`,
  viewModel: {
    createViewModel(params: MediaButtonComponentParams, componentInfo: ko.components.ComponentInfo) {
      return new MediaButtonComponent(params, componentInfo);
    },
  },
});
