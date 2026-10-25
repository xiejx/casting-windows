'use strict';

const { XMLParser } = require('fast-xml-parser');
const { SERVICE_TYPES, SINK_PROTOCOL_INFO } = require('./descriptions');
const { escapeXml, formatTime, truthy } = require('./util');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

class SoapError extends Error {
  constructor(code, description) {
    super(description || 'UPnP error');
    this.code = code;
    this.description = description || 'UPnP error';
  }
}

function valueOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return valueOf(node[0]);
  if (typeof node === 'object') {
    if (node['#text'] != null) return String(node['#text']).trim();
    return '';
  }
  return '';
}

function parseSoapActionHeader(header) {
  if (!header) return null;
  const cleaned = String(header).trim().replace(/^"|"$/g, '');
  const index = cleaned.indexOf('#');
  if (index < 0) return null;
  const urn = cleaned.slice(0, index).trim();
  const action = cleaned.slice(index + 1).trim();
  const parts = urn.split(':');
  const service = parts.length >= 5 ? parts[4] : '';
  if (!action) return null;
  return { urn, service, action };
}

function parseSoapBody(xml, expectedAction) {
  let parsed;
  try {
    parsed = parser.parse(xml || '');
  } catch {
    return { action: expectedAction || '', args: {} };
  }

  const envelope = parsed.Envelope || {};
  const body = envelope.Body || parsed.Body || {};
  let action = expectedAction || '';
  let node = action ? body[action] : null;

  if (node == null) {
    for (const key of Object.keys(body)) {
      if (key.startsWith('@_') || key === '#text') continue;
      action = key;
      node = body[key];
      break;
    }
  }

  const args = {};
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_') || key === '#text') continue;
      args[key] = valueOf(value);
    }
  }
  return { action, args };
}

const HANDLERS = {
  AVTransport: {
    SetAVTransportURI(device, args) {
      if (!device.setUri(args.CurrentURI || '', args.CurrentURIMetaData || '')) {
        throw new SoapError(402, 'Invalid Args');
      }
      return {};
    },
    SetNextAVTransportURI() {
      return {};
    },
    GetMediaInfo(device) {
      return {
        NrTracks: device.hasMedia ? '1' : '0',
        MediaDuration: formatTime(device.duration),
        CurrentURI: device.uri,
        CurrentURIMetaData: device.metadata,
        NextURI: '',
        NextURIMetaData: '',
        PlayMedium: device.hasMedia ? 'NETWORK' : 'NONE',
        RecordMedium: 'NOT_IMPLEMENTED',
        WriteStatus: 'NOT_IMPLEMENTED',
      };
    },
    GetTransportInfo(device) {
      return {
        CurrentTransportState: device.transportState,
        CurrentTransportStatus: 'OK',
        CurrentSpeed: '1',
      };
    },
    GetPositionInfo(device) {
      const position = formatTime(device.position);
      return {
        Track: '1',
        TrackDuration: formatTime(device.duration),
        TrackMetaData: device.metadata,
        TrackURI: device.uri,
        RelTime: position,
        AbsTime: position,
        RelCount: '2147483647',
        AbsCount: '2147483647',
      };
    },
    GetDeviceCapabilities() {
      return {
        PlayMedia: 'NETWORK',
        RecMedia: 'NOT_IMPLEMENTED',
        RecQualityModes: 'NOT_IMPLEMENTED',
      };
    },
    GetTransportSettings() {
      return {
        PlayMode: 'NORMAL',
        RecQualityMode: 'NOT_IMPLEMENTED',
      };
    },
    GetCurrentTransportActions(device) {
      return { Actions: device.getCurrentTransportActions() };
    },
    Stop(device) {
      device.stop();
      return {};
    },
    Play(device) {
      if (!device.play()) throw new SoapError(701, 'Transition not available');
      return {};
    },
    Pause(device) {
      if (!device.pause()) throw new SoapError(701, 'Transition not available');
      return {};
    },
    Seek(device, args) {
      if (!device.seek(args.Unit || 'REL_TIME', args.Target || '0')) {
        throw new SoapError(701, 'Transition not available');
      }
      return {};
    },
    Next() {
      throw new SoapError(701, 'Transition not available');
    },
    Previous() {
      throw new SoapError(701, 'Transition not available');
    },
  },
  RenderingControl: {
    ListPresets() {
      return { CurrentPresetNameList: 'FactoryDefaults' };
    },
    SelectPreset() {
      return {};
    },
    GetMute(device) {
      return { CurrentMute: device.mute ? '1' : '0' };
    },
    SetMute(device, args) {
      device.setVolume(device.volume, truthy(args.DesiredMute));
      return {};
    },
    GetVolume(device) {
      return { CurrentVolume: String(device.volume) };
    },
    SetVolume(device, args) {
      device.setVolume(args.DesiredVolume);
      return {};
    },
  },
  ConnectionManager: {
    GetProtocolInfo() {
      return { Source: '', Sink: SINK_PROTOCOL_INFO };
    },
    GetCurrentConnectionIDs() {
      return { ConnectionIDs: '0' };
    },
    GetCurrentConnectionInfo() {
      return {
        RcsID: '0',
        AVTransportID: '0',
        ProtocolInfo: '',
        PeerConnectionManager: '',
        PeerConnectionID: '-1',
        Direction: 'Output',
        Status: 'OK',
      };
    },
    PrepareForConnection() {
      return { ConnectionID: '0', AVTransportID: '0', RcsID: '0' };
    },
    ConnectionComplete() {
      return {};
    },
  },
};

function dispatch(device, service, action, args) {
  const handlers = HANDLERS[service];
  if (!handlers) throw new SoapError(401, 'Invalid Action');
  const handler = handlers[action];
  if (!handler) throw new SoapError(401, 'Invalid Action');
  return handler(device, args || {}) || {};
}

function buildResponse(service, action, outArgs) {
  const urn = SERVICE_TYPES[service] || `urn:schemas-upnp-org:service:${service}:1`;
  const body = Object.entries(outArgs || {})
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action}Response xmlns:u="${urn}">${body}</u:${action}Response>
  </s:Body>
</s:Envelope>`;
}

function buildFault(code, description) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>${code}</errorCode>
          <errorDescription>${escapeXml(description)}</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
}

module.exports = {
  SoapError,
  parseSoapActionHeader,
  parseSoapBody,
  dispatch,
  buildResponse,
  buildFault,
};
