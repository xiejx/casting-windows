'use strict';

const { escapeXml } = require('./util');

const SERVICE_TYPES = {
  AVTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  RenderingControl: 'urn:schemas-upnp-org:service:RenderingControl:1',
  ConnectionManager: 'urn:schemas-upnp-org:service:ConnectionManager:1',
};

const SERVICE_IDS = {
  AVTransport: 'urn:upnp-org:serviceId:AVTransport',
  RenderingControl: 'urn:upnp-org:serviceId:RenderingControl',
  ConnectionManager: 'urn:upnp-org:serviceId:ConnectionManager',
};

const SINK_PROTOCOL_INFO = [
  'http-get:*:video/mp4:*',
  'http-get:*:video/x-m4v:*',
  'http-get:*:video/webm:*',
  'http-get:*:video/mp2t:*',
  'http-get:*:application/vnd.apple.mpegurl:*',
  'http-get:*:application/x-mpegURL:*',
  'http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_BL_CIF15_AAC_520',
  'http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5',
  'http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_HP_HD_AAC',
  'http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_HD_720p_AAC',
  'http-get:*:audio/mpeg:*',
  'http-get:*:audio/mp4:*',
  'http-get:*:audio/aac:*',
  'http-get:*:audio/flac:*',
  'http-get:*:audio/wav:*',
  'http-get:*:image/jpeg:*',
  'http-get:*:image/png:*',
  'http-get:*:image/gif:*',
].join(',');

function buildDescriptionXml({ friendlyName, udn, port }) {
  const serviceBlock = Object.keys(SERVICE_TYPES)
    .map(
      (name) => `    <service>
      <serviceType>${SERVICE_TYPES[name]}</serviceType>
      <serviceId>${SERVICE_IDS[name]}</serviceId>
      <SCPDURL>/scpd/${name}.xml</SCPDURL>
      <controlURL>/control/${name}</controlURL>
      <eventSubURL>/event/${name}</eventSubURL>
    </service>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>${escapeXml(friendlyName)}</friendlyName>
    <manufacturer>CastReceiver</manufacturer>
    <manufacturerURL>https://local.invalid/</manufacturerURL>
    <modelDescription>DLNA 投屏接收器</modelDescription>
    <modelName>CastReceiver</modelName>
    <modelNumber>1.0</modelNumber>
    <serialNumber>${escapeXml(String(udn).split(':').pop().slice(0, 8))}</serialNumber>
    <UDN>${escapeXml(udn)}</UDN>
    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMR-1.50</dlna:X_DLNADOC>
    <serviceList>
${serviceBlock}
    </serviceList>
  </device>
</root>`;
}

function buildAction(action) {
  const args = (action.args || [])
    .map(
      (item) =>
        `<argument><name>${item.name}</name><direction>${item.dir}</direction><relatedStateVariable>${item.var}</relatedStateVariable></argument>`
    )
    .join('');
  return `<action><name>${action.name}</name>${args ? `<argumentList>${args}</argumentList>` : ''}</action>`;
}

function buildVariable(variable) {
  const extras = [];
  if (variable.allowed) {
    extras.push(
      `<allowedValueList>${variable.allowed
        .map((value) => `<allowedValue>${value}</allowedValue>`)
        .join('')}</allowedValueList>`
    );
  }
  if (variable.min != null) {
    extras.push(
      `<allowedValueRange><minimum>${variable.min}</minimum><maximum>${variable.max}</maximum>${
        variable.step != null ? `<step>${variable.step}</step>` : ''
      }</allowedValueRange>`
    );
  }
  return `<stateVariable sendEvents="${variable.events ? 'yes' : 'no'}"><name>${
    variable.name
  }</name><dataType>${variable.type || 'string'}</dataType>${extras.join('')}</stateVariable>`;
}

function buildScpd(definitions) {
  return `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    ${definitions.actions.map(buildAction).join('\n    ')}
  </actionList>
  <serviceStateTable>
    ${definitions.variables.map(buildVariable).join('\n    ')}
  </serviceStateTable>
</scpd>`;
}

const AVT_VARIABLES = [
  { name: 'LastChange', type: 'string', events: true },
  {
    name: 'TransportState',
    allowed: ['STOPPED', 'PLAYING', 'PAUSED_PLAYBACK', 'TRANSITIONING', 'NO_MEDIA_PRESENT'],
  },
  { name: 'TransportStatus', allowed: ['OK', 'ERROR_OCCURRED'] },
  { name: 'TransportPlaySpeed', allowed: ['1'] },
  { name: 'CurrentTransportActions' },
  { name: 'AVTransportURI' },
  { name: 'AVTransportURIMetaData' },
  { name: 'NextAVTransportURI' },
  { name: 'NextAVTransportURIMetaData' },
  { name: 'CurrentMediaDuration' },
  { name: 'CurrentTrack', type: 'ui4', min: 0, max: 1, step: 1 },
  { name: 'CurrentTrackDuration' },
  { name: 'CurrentTrackMetaData' },
  { name: 'CurrentTrackURI' },
  { name: 'CurrentPlayMode', allowed: ['NORMAL'] },
  { name: 'CurrentRecordQualityMode', allowed: ['NOT_IMPLEMENTED'] },
  { name: 'NumberOfTracks', type: 'ui4', min: 0, max: 1, step: 1 },
  { name: 'PlaybackStorageMedium', allowed: ['NETWORK', 'NONE', 'UNKNOWN'] },
  { name: 'RecordStorageMedium', allowed: ['NOT_IMPLEMENTED'] },
  { name: 'PossiblePlaybackStorageMedia' },
  { name: 'PossibleRecordStorageMedia' },
  { name: 'PossibleRecordQualityModes' },
  { name: 'RecordMediumWriteStatus', allowed: ['NOT_IMPLEMENTED'] },
  { name: 'RelativeTimePosition' },
  { name: 'AbsoluteTimePosition' },
  { name: 'RelativeCounterPosition', type: 'i4' },
  { name: 'AbsoluteCounterPosition', type: 'i4' },
  { name: 'A_ARG_TYPE_InstanceID', type: 'ui4' },
  { name: 'A_ARG_TYPE_SeekMode', allowed: ['REL_TIME', 'ABS_TIME', 'TRACK_NR'] },
  { name: 'A_ARG_TYPE_SeekTarget' },
];

const RC_VARIABLES = [
  { name: 'LastChange', type: 'string', events: true },
  { name: 'PresetNameList' },
  { name: 'Mute', type: 'boolean' },
  { name: 'Volume', type: 'ui2', min: 0, max: 100, step: 1 },
  { name: 'A_ARG_TYPE_Channel', allowed: ['Master'] },
  { name: 'A_ARG_TYPE_InstanceID', type: 'ui4' },
  { name: 'A_ARG_TYPE_PresetName', allowed: ['FactoryDefaults'] },
];

const CM_VARIABLES = [
  { name: 'SourceProtocolInfo', events: true },
  { name: 'SinkProtocolInfo', events: true },
  { name: 'CurrentConnectionIDs', events: true },
  {
    name: 'A_ARG_TYPE_ConnectionStatus',
    allowed: ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown'],
  },
  { name: 'A_ARG_TYPE_ConnectionManager' },
  { name: 'A_ARG_TYPE_Direction', allowed: ['Input', 'Output'] },
  { name: 'A_ARG_TYPE_ProtocolInfo' },
  { name: 'A_ARG_TYPE_ConnectionID', type: 'i4' },
  { name: 'A_ARG_TYPE_AVTransportID', type: 'i4' },
  { name: 'A_ARG_TYPE_RcsID', type: 'i4' },
];

const AVT_ACTIONS = [
  {
    name: 'SetAVTransportURI',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'CurrentURI', dir: 'in', var: 'AVTransportURI' },
      { name: 'CurrentURIMetaData', dir: 'in', var: 'AVTransportURIMetaData' },
    ],
  },
  {
    name: 'SetNextAVTransportURI',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'NextURI', dir: 'in', var: 'NextAVTransportURI' },
      { name: 'NextURIMetaData', dir: 'in', var: 'NextAVTransportURIMetaData' },
    ],
  },
  {
    name: 'GetMediaInfo',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'NrTracks', dir: 'out', var: 'NumberOfTracks' },
      { name: 'MediaDuration', dir: 'out', var: 'CurrentMediaDuration' },
      { name: 'CurrentURI', dir: 'out', var: 'AVTransportURI' },
      { name: 'CurrentURIMetaData', dir: 'out', var: 'AVTransportURIMetaData' },
      { name: 'NextURI', dir: 'out', var: 'NextAVTransportURI' },
      { name: 'NextURIMetaData', dir: 'out', var: 'NextAVTransportURIMetaData' },
      { name: 'PlayMedium', dir: 'out', var: 'PlaybackStorageMedium' },
      { name: 'RecordMedium', dir: 'out', var: 'RecordStorageMedium' },
      { name: 'WriteStatus', dir: 'out', var: 'RecordMediumWriteStatus' },
    ],
  },
  {
    name: 'GetTransportInfo',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'CurrentTransportState', dir: 'out', var: 'TransportState' },
      { name: 'CurrentTransportStatus', dir: 'out', var: 'TransportStatus' },
      { name: 'CurrentSpeed', dir: 'out', var: 'TransportPlaySpeed' },
    ],
  },
  {
    name: 'GetPositionInfo',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Track', dir: 'out', var: 'CurrentTrack' },
      { name: 'TrackDuration', dir: 'out', var: 'CurrentTrackDuration' },
      { name: 'TrackMetaData', dir: 'out', var: 'CurrentTrackMetaData' },
      { name: 'TrackURI', dir: 'out', var: 'CurrentTrackURI' },
      { name: 'RelTime', dir: 'out', var: 'RelativeTimePosition' },
      { name: 'AbsTime', dir: 'out', var: 'AbsoluteTimePosition' },
      { name: 'RelCount', dir: 'out', var: 'RelativeCounterPosition' },
      { name: 'AbsCount', dir: 'out', var: 'AbsoluteCounterPosition' },
    ],
  },
  {
    name: 'GetDeviceCapabilities',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'PlayMedia', dir: 'out', var: 'PossiblePlaybackStorageMedia' },
      { name: 'RecMedia', dir: 'out', var: 'PossibleRecordStorageMedia' },
      { name: 'RecQualityModes', dir: 'out', var: 'PossibleRecordQualityModes' },
    ],
  },
  {
    name: 'GetTransportSettings',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'PlayMode', dir: 'out', var: 'CurrentPlayMode' },
      { name: 'RecQualityMode', dir: 'out', var: 'CurrentRecordQualityMode' },
    ],
  },
  {
    name: 'GetCurrentTransportActions',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Actions', dir: 'out', var: 'CurrentTransportActions' },
    ],
  },
  { name: 'Stop', args: [{ name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' }] },
  {
    name: 'Play',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Speed', dir: 'in', var: 'TransportPlaySpeed' },
    ],
  },
  { name: 'Pause', args: [{ name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' }] },
  {
    name: 'Seek',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Unit', dir: 'in', var: 'A_ARG_TYPE_SeekMode' },
      { name: 'Target', dir: 'in', var: 'A_ARG_TYPE_SeekTarget' },
    ],
  },
  { name: 'Next', args: [{ name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' }] },
  { name: 'Previous', args: [{ name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' }] },
];

const RC_ACTIONS = [
  {
    name: 'ListPresets',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'CurrentPresetNameList', dir: 'out', var: 'PresetNameList' },
    ],
  },
  {
    name: 'SelectPreset',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'PresetName', dir: 'in', var: 'A_ARG_TYPE_PresetName' },
    ],
  },
  {
    name: 'GetMute',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Channel', dir: 'in', var: 'A_ARG_TYPE_Channel' },
      { name: 'CurrentMute', dir: 'out', var: 'Mute' },
    ],
  },
  {
    name: 'SetMute',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Channel', dir: 'in', var: 'A_ARG_TYPE_Channel' },
      { name: 'DesiredMute', dir: 'in', var: 'Mute' },
    ],
  },
  {
    name: 'GetVolume',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Channel', dir: 'in', var: 'A_ARG_TYPE_Channel' },
      { name: 'CurrentVolume', dir: 'out', var: 'Volume' },
    ],
  },
  {
    name: 'SetVolume',
    args: [
      { name: 'InstanceID', dir: 'in', var: 'A_ARG_TYPE_InstanceID' },
      { name: 'Channel', dir: 'in', var: 'A_ARG_TYPE_Channel' },
      { name: 'DesiredVolume', dir: 'in', var: 'Volume' },
    ],
  },
];

const CM_ACTIONS = [
  {
    name: 'GetProtocolInfo',
    args: [
      { name: 'Source', dir: 'out', var: 'SourceProtocolInfo' },
      { name: 'Sink', dir: 'out', var: 'SinkProtocolInfo' },
    ],
  },
  {
    name: 'GetCurrentConnectionIDs',
    args: [{ name: 'ConnectionIDs', dir: 'out', var: 'CurrentConnectionIDs' }],
  },
  {
    name: 'GetCurrentConnectionInfo',
    args: [
      { name: 'ConnectionID', dir: 'in', var: 'A_ARG_TYPE_ConnectionID' },
      { name: 'RcsID', dir: 'out', var: 'A_ARG_TYPE_RcsID' },
      { name: 'AVTransportID', dir: 'out', var: 'A_ARG_TYPE_AVTransportID' },
      { name: 'ProtocolInfo', dir: 'out', var: 'A_ARG_TYPE_ProtocolInfo' },
      { name: 'PeerConnectionManager', dir: 'out', var: 'A_ARG_TYPE_ConnectionManager' },
      { name: 'PeerConnectionID', dir: 'out', var: 'A_ARG_TYPE_ConnectionID' },
      { name: 'Direction', dir: 'out', var: 'A_ARG_TYPE_Direction' },
      { name: 'Status', dir: 'out', var: 'A_ARG_TYPE_ConnectionStatus' },
    ],
  },
  {
    name: 'PrepareForConnection',
    args: [
      { name: 'RemoteProtocolInfo', dir: 'in', var: 'A_ARG_TYPE_ProtocolInfo' },
      { name: 'PeerConnectionManager', dir: 'in', var: 'A_ARG_TYPE_ConnectionManager' },
      { name: 'PeerConnectionID', dir: 'in', var: 'A_ARG_TYPE_ConnectionID' },
      { name: 'Direction', dir: 'in', var: 'A_ARG_TYPE_Direction' },
      { name: 'ConnectionID', dir: 'out', var: 'A_ARG_TYPE_ConnectionID' },
      { name: 'AVTransportID', dir: 'out', var: 'A_ARG_TYPE_AVTransportID' },
      { name: 'RcsID', dir: 'out', var: 'A_ARG_TYPE_RcsID' },
    ],
  },
  {
    name: 'ConnectionComplete',
    args: [{ name: 'ConnectionID', dir: 'in', var: 'A_ARG_TYPE_ConnectionID' }],
  },
];

const SCPD = {
  AVTransport: buildScpd({ actions: AVT_ACTIONS, variables: AVT_VARIABLES }),
  RenderingControl: buildScpd({ actions: RC_ACTIONS, variables: RC_VARIABLES }),
  ConnectionManager: buildScpd({ actions: CM_ACTIONS, variables: CM_VARIABLES }),
};

module.exports = {
  SERVICE_TYPES,
  SINK_PROTOCOL_INFO,
  SCPD,
  buildDescriptionXml,
};
