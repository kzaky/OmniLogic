import axios, { AxiosInstance } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from 'homebridge';
import { OMNILOGIC_ENDPOINT, REQUEST_TIMEOUT_MS } from './settings';

type ParamValue = string | number | boolean;
type ParamDataType =
  | 'String'
  | 'int'
  | 'bool'
  | 'double'
  | 'unsignedInt'
  | 'byte';

interface RequestParameter {
  name: string;
  dataType: ParamDataType;
  value: ParamValue;
}

export interface BackyardTopology {
  mspSystemId: number;
  backyardName: string;
  bows: BodyOfWater[];
  rawMsp: any;
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

export interface TelemetrySnapshot {
  timestamp: number;
  byId: Map<number, any>;
  raw: any;
}

/**
 * Thin SOAP client for the Hayward OmniLogic Home Automation Service.
 *
 * The service is a non-standard SOAP/XML protocol: each request is an
 * outer SOAP envelope wrapping a <Request> with a <Name> and a list of
 * named, typed <Parameter> entries. We model that explicitly rather than
 * pulling in a heavy soap client.
 */
export class OmniLogicApi {
  private readonly http: AxiosInstance;
  private readonly parser: XMLParser;

  private token: string | null = null;
  private userId: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
    private readonly debug = false,
  ) {
    this.http = axios.create({
      baseURL: OMNILOGIC_ENDPOINT,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '',
      },
      responseType: 'text',
      transformResponse: [(d) => d],
    });

    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: true,
      parseTagValue: true,
      trimValues: true,
    });
  }

  async ensureLogin(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return;
    }
    await this.login();
  }

  async login(): Promise<void> {
    const body = this.buildRequest('Login', [
      { name: 'UserName', dataType: 'String', value: this.username },
      { name: 'Password', dataType: 'String', value: this.password },
    ]);
    const xml = await this.post(body);
    const params = this.extractParameters(xml);
    const status = this.firstNumber(params, 'Status');
    if (status !== 0) {
      throw new Error(
        `OmniLogic login failed (status=${status}). Check username/password.`,
      );
    }
    this.token = this.firstString(params, 'Token');
    this.userId = this.firstString(params, 'UserID') ??
      this.firstString(params, 'UserId');
    // Tokens documented to last ~24h; refresh well before that.
    this.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
    if (!this.token) {
      throw new Error('OmniLogic login returned no token.');
    }
    this.log.info('OmniLogic: authenticated successfully.');
  }

  async getSiteList(): Promise<{ mspSystemId: number; backyardName: string }> {
    await this.ensureLogin();
    const body = this.buildRequest('GetSiteList', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'UserID', dataType: 'String', value: this.userId ?? '' },
    ]);
    const xml = await this.post(body);
    const parsed = this.parser.parse(xml);
    const siteList = this.deepFind(parsed, 'Site') ?? this.deepFind(parsed, 'List');
    const site = Array.isArray(siteList) ? siteList[0] : siteList;
    if (!site) {
      throw new Error('OmniLogic: no sites found on this account.');
    }
    const mspSystemId = Number(
      this.deepFind(site, 'MspSystemID') ?? this.deepFind(site, 'MspSystemId'),
    );
    const backyardName = String(
      this.deepFind(site, 'BackyardName') ?? 'OmniLogic',
    );
    return { mspSystemId, backyardName };
  }

  async getMspConfig(mspSystemId: number): Promise<BackyardTopology> {
    await this.ensureLogin();
    const body = this.buildRequest('GetMspConfigFile', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'Version', dataType: 'String', value: '0' },
    ]);
    const xml = await this.post(body);
    const parsed = this.parser.parse(xml);
    const mspNode = this.deepFind(parsed, 'MSPConfig') ??
      this.deepFind(parsed, 'Response');
    if (!mspNode) {
      throw new Error('OmniLogic: unable to parse MSP config response.');
    }
    return this.buildTopology(mspSystemId, mspNode);
  }

  async getTelemetry(mspSystemId: number): Promise<TelemetrySnapshot> {
    await this.ensureLogin();
    const body = this.buildRequest('GetTelemetryData', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
    ]);
    const xml = await this.post(body);
    const parsed = this.parser.parse(xml);
    const root = this.deepFind(parsed, 'STATUS') ??
      this.deepFind(parsed, 'Status') ?? parsed;
    const byId = new Map<number, any>();
    this.collectTelemetryNodes(root, byId);
    return { timestamp: Date.now(), byId, raw: root };
  }

  async setHeaterEnable(
    mspSystemId: number,
    bowId: number,
    heaterId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.ensureLogin();
    const body = this.buildRequest('SetHeaterEnable', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'HeaterID', dataType: 'int', value: heaterId },
      { name: 'Version', dataType: 'String', value: '0' },
      { name: 'HeaterEnable', dataType: 'bool', value: enabled },
    ]);
    await this.post(body);
  }

  async setHeaterSetpoint(
    mspSystemId: number,
    bowId: number,
    heaterId: number,
    temperature: number,
  ): Promise<void> {
    await this.ensureLogin();
    const body = this.buildRequest('SetUIHeaterCmd', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'HeaterID', dataType: 'int', value: heaterId },
      { name: 'Version', dataType: 'String', value: '0' },
      { name: 'Temp', dataType: 'int', value: Math.round(temperature) },
    ]);
    await this.post(body);
  }

  async setEquipmentState(
    mspSystemId: number,
    bowId: number,
    equipmentId: number,
    on: boolean,
    isCountDownTimer = false,
    startTimeHours = 0,
    startTimeMinutes = 0,
    endTimeHours = 0,
    endTimeMinutes = 0,
    daysActive = 0,
    recurring = false,
  ): Promise<void> {
    await this.ensureLogin();
    const body = this.buildRequest('SetUIEquipmentCmd', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'EquipmentID', dataType: 'int', value: equipmentId },
      { name: 'IsOn', dataType: 'int', value: on ? 100 : 0 },
      { name: 'IsCountDownTimer', dataType: 'bool', value: isCountDownTimer },
      { name: 'StartTimeHours', dataType: 'int', value: startTimeHours },
      { name: 'StartTimeMinutes', dataType: 'int', value: startTimeMinutes },
      { name: 'EndTimeHours', dataType: 'int', value: endTimeHours },
      { name: 'EndTimeMinutes', dataType: 'int', value: endTimeMinutes },
      { name: 'DaysActive', dataType: 'int', value: daysActive },
      { name: 'Recurring', dataType: 'bool', value: recurring },
    ]);
    await this.post(body);
  }

  async setFilterSpeed(
    mspSystemId: number,
    bowId: number,
    filterId: number,
    speedPercent: number,
  ): Promise<void> {
    await this.ensureLogin();
    const clamped = Math.max(0, Math.min(100, Math.round(speedPercent)));
    const body = this.buildRequest('SetUIFilterSpeedCmd', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'FilterID', dataType: 'int', value: filterId },
      { name: 'Speed', dataType: 'int', value: clamped },
      { name: 'IsCountDownTimer', dataType: 'bool', value: false },
      { name: 'StartTimeHours', dataType: 'int', value: 0 },
      { name: 'StartTimeMinutes', dataType: 'int', value: 0 },
      { name: 'EndTimeHours', dataType: 'int', value: 0 },
      { name: 'EndTimeMinutes', dataType: 'int', value: 0 },
      { name: 'DaysActive', dataType: 'int', value: 0 },
      { name: 'Recurring', dataType: 'bool', value: false },
    ]);
    await this.post(body);
  }

  async setLightShow(
    mspSystemId: number,
    bowId: number,
    lightId: number,
    show: number,
  ): Promise<void> {
    await this.ensureLogin();
    const body = this.buildRequest('SetStandAloneLightShow', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'LightID', dataType: 'int', value: lightId },
      { name: 'Show', dataType: 'byte', value: show },
      { name: 'Speed', dataType: 'byte', value: 4 },
      { name: 'Brightness', dataType: 'byte', value: 4 },
      { name: 'Reserved', dataType: 'byte', value: 0 },
      { name: 'IsCountDownTimer', dataType: 'bool', value: false },
      { name: 'StartTimeHours', dataType: 'int', value: 0 },
      { name: 'StartTimeMinutes', dataType: 'int', value: 0 },
      { name: 'EndTimeHours', dataType: 'int', value: 0 },
      { name: 'EndTimeMinutes', dataType: 'int', value: 0 },
      { name: 'DaysActive', dataType: 'int', value: 0 },
      { name: 'Recurring', dataType: 'bool', value: false },
    ]);
    await this.post(body);
  }

  private buildRequest(name: string, params: RequestParameter[]): string {
    const paramXml = params
      .map((p) => {
        const value = this.encodeValue(p.value, p.dataType);
        return `<Parameter name="${p.name}" dataType="${p.dataType}">${value}</Parameter>`;
      })
      .join('');
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"' +
      ' xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Body>' +
      '<Request>' +
      `<Name>${name}</Name>` +
      `<Parameters>${paramXml}</Parameters>` +
      '</Request>' +
      '</soap:Body>' +
      '</soap:Envelope>'
    );
  }

  private encodeValue(value: ParamValue, dataType: ParamDataType): string {
    if (dataType === 'bool') {
      return value ? 'True' : 'False';
    }
    return this.escapeXml(String(value));
  }

  private escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private async post(body: string): Promise<string> {
    if (this.debug) {
      this.log.debug('OmniLogic request:\n' + body);
    }
    try {
      const resp = await this.http.post('', body);
      const text = typeof resp.data === 'string' ? resp.data : String(resp.data);
      if (this.debug) {
        this.log.debug('OmniLogic response:\n' + text);
      }
      return text;
    } catch (err: any) {
      const detail = err?.response?.data
        ? typeof err.response.data === 'string'
          ? err.response.data.slice(0, 300)
          : JSON.stringify(err.response.data).slice(0, 300)
        : err?.message;
      throw new Error(`OmniLogic request failed: ${detail}`);
    }
  }

  private extractParameters(xml: string): any[] {
    const parsed = this.parser.parse(xml);
    const params = this.deepFind(parsed, 'Parameter');
    if (!params) return [];
    return Array.isArray(params) ? params : [params];
  }

  private firstString(params: any[], name: string): string | null {
    const p = params.find((x) => x?.['@_name'] === name);
    if (!p) return null;
    const raw = typeof p === 'object' ? p['#text'] ?? p : p;
    return raw == null ? null : String(raw);
  }

  private firstNumber(params: any[], name: string): number | null {
    const v = this.firstString(params, name);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private buildTopology(mspSystemId: number, mspNode: any): BackyardTopology {
    const backyard = this.deepFind(mspNode, 'Backyard') ?? mspNode;
    const backyardName = String(
      this.deepFind(backyard, 'Name') ?? 'Backyard',
    );

    const bows: BodyOfWater[] = [];
    const bowNodes = this.collectArray(backyard, 'Body-of-water');
    for (const bow of bowNodes) {
      bows.push({
        systemId: Number(this.deepFind(bow, 'System-Id') ?? 0),
        name: String(this.deepFind(bow, 'Name') ?? 'Body of Water'),
        type: String(this.deepFind(bow, 'Type') ?? 'BOW_POOL'),
        heaters: this.collectEquipment(bow, 'Heater'),
        filters: this.collectEquipment(bow, 'Filter'),
        pumps: this.collectEquipment(bow, 'Pump'),
        lights: this.collectEquipment(bow, 'ColorLogic-Light'),
        chlorinators: this.collectEquipment(bow, 'Chlorinator'),
        relays: this.collectEquipment(bow, 'Relay'),
      });
    }

    return { mspSystemId, backyardName, bows, rawMsp: mspNode };
  }

  private collectEquipment(parent: any, tag: string): EquipmentRef[] {
    const nodes = this.collectArray(parent, tag);
    return nodes.map((n) => ({
      systemId: Number(this.deepFind(n, 'System-Id') ?? 0),
      name: String(this.deepFind(n, 'Name') ?? tag),
      raw: n,
    }));
  }

  private collectArray(node: any, key: string): any[] {
    if (!node || typeof node !== 'object') return [];
    const direct = node[key];
    if (direct !== undefined) {
      return Array.isArray(direct) ? direct : [direct];
    }
    const out: any[] = [];
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') {
        out.push(...this.collectArray(v, key));
      }
    }
    return out;
  }

  private collectTelemetryNodes(node: any, byId: Map<number, any>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) this.collectTelemetryNodes(item, byId);
      return;
    }
    const idAttr = node['@_systemId'] ?? node['@_SystemId'] ?? node['@_systemID'];
    if (idAttr !== undefined) {
      const id = Number(idAttr);
      if (Number.isFinite(id)) {
        const merged = byId.get(id);
        byId.set(id, merged ? { ...merged, ...node } : node);
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') this.collectTelemetryNodes(v, byId);
    }
  }

  private deepFind(node: any, key: string): any {
    if (!node || typeof node !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      return (node as any)[key];
    }
    for (const v of Object.values(node)) {
      const found = this.deepFind(v, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}
