import { XMLParser } from 'fast-xml-parser';

/**
 * Pure helpers for talking to the OmniLogic SOAP service. Kept free of
 * I/O and class state so they're cheap to test in isolation.
 */

const SECRET_PARAM_NAMES = ['Password', 'Token'] as const;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  parseTagValue: true,
  trimValues: true,
});

export type ParamValue = string | number | boolean;
export type ParamDataType =
  | 'String'
  | 'int'
  | 'bool'
  | 'double'
  | 'unsignedInt'
  | 'byte';

export interface RequestParameter {
  name: string;
  dataType: ParamDataType;
  value: ParamValue;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function encodeValue(
  value: ParamValue,
  dataType: ParamDataType,
): string {
  if (dataType === 'bool') {
    return value ? 'True' : 'False';
  }
  return escapeXml(String(value));
}

export function buildRequestXml(
  name: string,
  params: RequestParameter[],
): string {
  const paramXml = params
    .map((p) => {
      const value = encodeValue(p.value, p.dataType);
      return `<Parameter name="${p.name}" dataType="${p.dataType}">${value}</Parameter>`;
    })
    .join('');
  return (
    '<Request>' +
    `<Name>${name}</Name>` +
    `<Parameters>${paramXml}</Parameters>` +
    '</Request>'
  );
}

/**
 * Mask `Password` and `Token` parameter values, plus bare
 * `<Token>` / `<UserID>` elements, in any XML before it is logged or
 * included in error messages.
 */
export function redactXml(xml: string): string {
  if (!xml) return xml;
  let out = xml;
  for (const name of SECRET_PARAM_NAMES) {
    const re = new RegExp(
      `(<Parameter\\b(?:(?!>)[\\s\\S])*?\\bname="${name}"(?:(?!>)[\\s\\S])*?>)([^<]*)(</Parameter>)`,
      'gi',
    );
    out = out.replace(re, '$1***REDACTED***$3');
  }
  out = out.replace(
    /<(Token|UserID|UserId)>[^<]*<\/\1>/gi,
    '<$1>***REDACTED***</$1>',
  );
  return out;
}

export function parseXml(xml: string): any {
  return parser.parse(xml);
}

export function extractParameters(xml: string): any[] {
  const parsed = parseXml(xml);
  const params = deepFind(parsed, 'Parameter');
  if (params == null) return [];
  return Array.isArray(params) ? params : [params];
}

export function firstString(params: any[], name: string): string | null {
  const p = params.find((x) => x?.['@_name'] === name);
  if (p == null) return null;
  if (typeof p !== 'object') return String(p);
  const raw = '#text' in p ? p['#text'] : undefined;
  return raw == null ? null : String(raw);
}

export function firstNumber(params: any[], name: string): number | null {
  const v = firstString(params, name);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * MSP config and telemetry responses both wrap the meaningful payload
 * as a string-encoded XML fragment inside a `<Parameter dataType="XML">`
 * child. Try element-walking first, then fall back to re-parsing
 * `#text` content as XML.
 */
export function extractEmbeddedPayload(
  xml: string,
  roots: string[],
): any | undefined {
  const parsed = parseXml(xml);
  for (const root of roots) {
    const direct = deepFind(parsed, root);
    if (direct !== undefined) return direct;
  }
  const params = deepFind(parsed, 'Parameter');
  const arr = Array.isArray(params) ? params : params ? [params] : [];
  for (const p of arr) {
    const text = typeof p === 'object' ? p?.['#text'] : undefined;
    if (typeof text !== 'string') continue;
    if (!text.trimStart().startsWith('<')) continue;
    try {
      const sub = parseXml(text);
      for (const root of roots) {
        const found = deepFind(sub, root);
        if (found !== undefined) return found;
      }
    } catch {
      // not parseable XML, ignore
    }
  }
  return undefined;
}

export interface BodyOfWater {
  systemId: number;
  name: string;
  type: string;
  heaters: EquipmentRef[];
  filters: EquipmentRef[];
  pumps: EquipmentRef[];
  lights: EquipmentRef[];
  chlorinators: EquipmentRef[];
  relays: EquipmentRef[];
}

export interface EquipmentRef {
  systemId: number;
  name: string;
  raw: any;
}

export interface BackyardTopology {
  mspSystemId: number;
  backyardName: string;
  bows: BodyOfWater[];
  rawMsp: any;
}

export function buildTopology(
  mspSystemId: number,
  mspNode: any,
): BackyardTopology {
  const backyard = deepFind(mspNode, 'Backyard') ?? mspNode;
  const backyardName = String(deepFind(backyard, 'Name') ?? 'Backyard');

  const bowNodes = [
    ...collectArray(backyard, 'Body-of-water'),
    ...collectArray(backyard, 'BodyOfWater'),
  ];

  const bows: BodyOfWater[] = bowNodes.map((bow) => ({
    systemId: readSystemId(bow),
    name: String(deepFind(bow, 'Name') ?? 'Body of Water'),
    type: String(deepFind(bow, 'Type') ?? 'BOW_POOL'),
    heaters: collectEquipment(bow, ['Heater']),
    filters: collectEquipment(bow, ['Filter']),
    pumps: collectEquipment(bow, ['Pump']),
    lights: collectEquipment(bow, ['ColorLogic-Light', 'Light']),
    chlorinators: collectEquipment(bow, ['Chlorinator']),
    relays: collectEquipment(bow, ['Relay']),
  }));

  return { mspSystemId, backyardName, bows, rawMsp: mspNode };
}

function collectEquipment(parent: any, tags: string[]): EquipmentRef[] {
  const out: EquipmentRef[] = [];
  for (const tag of tags) {
    for (const n of collectArray(parent, tag)) {
      const systemId = readSystemId(n);
      if (!Number.isFinite(systemId) || systemId <= 0) continue;
      out.push({
        systemId,
        name: String(deepFind(n, 'Name') ?? tag),
        raw: n,
      });
    }
  }
  return out;
}

export function readSystemId(node: any): number {
  const raw =
    deepFind(node, 'System-Id') ??
    deepFind(node, 'SystemId') ??
    deepFind(node, 'systemId') ??
    0;
  return Number(raw);
}

export function collectTelemetryNodes(
  node: any,
  byId: Map<number, any> = new Map(),
): Map<number, any> {
  if (!node || typeof node !== 'object') return byId;
  if (Array.isArray(node)) {
    for (const item of node) collectTelemetryNodes(item, byId);
    return byId;
  }
  const idAttr =
    node['@_systemId'] ??
    node['@_SystemId'] ??
    node['@_systemID'] ??
    node['@_system-Id'];
  if (idAttr !== undefined) {
    const id = Number(idAttr);
    if (Number.isFinite(id)) {
      const merged = byId.get(id);
      byId.set(id, merged ? { ...merged, ...node } : node);
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectTelemetryNodes(v, byId);
  }
  return byId;
}

function collectArray(node: any, key: string): any[] {
  if (!node || typeof node !== 'object') return [];
  const direct = node[key];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct : [direct];
  }
  const out: any[] = [];
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      out.push(...collectArray(v, key));
    }
  }
  return out;
}

export function deepFind(node: any, key: string): any {
  if (!node || typeof node !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(node, key)) {
    return (node as any)[key];
  }
  for (const v of Object.values(node)) {
    const found = deepFind(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}
