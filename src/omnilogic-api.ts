import axios, { AxiosInstance } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from 'homebridge';
import { OMNILOGIC_ENDPOINT, REQUEST_TIMEOUT_MS } from './settings';
import { TokenStore } from './token-store';

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

const SECRET_PARAM_NAMES = new Set(['Password', 'Token']);
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Thin SOAP client for the Hayward OmniLogic Home Automation Service.
 *
 * The service is a non-standard SOAP/XML protocol: each request is an
 * outer SOAP envelope wrapping a <Request> with a <Name> and a list of
 * named, typed <Parameter> entries. Responses often nest the meaningful
 * payload as a string inside a <Parameter dataType="XML"> child, so the
 * parsing in here has to handle both inline-element and string-XML forms.
 */
export class OmniLogicApi {
  private readonly http: AxiosInstance;
  private readonly parser: XMLParser;

  private token: string | null = null;
  private userId: string | null = null;
  private tokenExpiresAt = 0;
  private loginInFlight: Promise<void> | null = null;
  private cacheLoaded = false;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
    private readonly debug = false,
    private readonly tokenStore: TokenStore | null = null,
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
    if (!this.cacheLoaded && this.tokenStore) {
      this.cacheLoaded = true;
      const cached = await this.tokenStore.load(this.username);
      if (cached) {
        this.token = cached.token;
        this.userId = cached.userId;
        this.tokenExpiresAt = cached.expiresAt;
        this.log.info('OmniLogic: restored cached session token.');
      }
    }
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return;
    }
    await this.login();
  }

  async login(): Promise<void> {
    // Coalesce concurrent login attempts so we don't hammer the API on startup.
    if (this.loginInFlight) {
      return this.loginInFlight;
    }
    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const body = this.buildRequest('Login', [
      { name: 'UserName', dataType: 'String', value: this.username },
      { name: 'Password', dataType: 'String', value: this.password },
    ]);
    const xml = await this.post(body, 'Login');
    const params = this.extractParameters(xml);
    const status = this.firstNumber(params, 'Status');
    if (status !== 0 && status !== null) {
      throw new Error(
        `OmniLogic login failed (Status=${status}). Check username/password.`,
      );
    }
    const token = this.firstString(params, 'Token');
    if (!token) {
      throw new Error('OmniLogic login returned no token.');
    }
    this.token = token;
    this.userId =
      this.firstString(params, 'UserID') ??
      this.firstString(params, 'UserId');
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    this.log.info('OmniLogic: authenticated successfully.');

    if (this.tokenStore) {
      await this.tokenStore.save({
        v: 1,
        token: this.token,
        userId: this.userId,
        expiresAt: this.tokenExpiresAt,
        username: this.username,
      });
    }
  }

  async getSiteList(): Promise<{ mspSystemId: number; backyardName: string }> {
    await this.ensureLogin();
    const params: RequestParameter[] = [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'UserID', dataType: 'String', value: this.userId ?? '' },
    ];
    const xml = await this.callWithAuthRetry('GetSiteList', params);
    const parsed = this.parser.parse(xml);
    const siteList =
      this.deepFind(parsed, 'Site') ?? this.deepFind(parsed, 'List');
    const site = Array.isArray(siteList) ? siteList[0] : siteList;
    if (!site) {
      throw new Error('OmniLogic: no sites found on this account.');
    }
    const mspSystemId = Number(
      this.deepFind(site, 'MspSystemID') ?? this.deepFind(site, 'MspSystemId'),
    );
    if (!Number.isFinite(mspSystemId)) {
      throw new Error('OmniLogic: site list response missing MspSystemID.');
    }
    const backyardName = String(
      this.deepFind(site, 'BackyardName') ?? 'OmniLogic',
    );
    return { mspSystemId, backyardName };
  }

  async getMspConfig(mspSystemId: number): Promise<BackyardTopology> {
    await this.ensureLogin();
    const params: RequestParameter[] = [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'Version', dataType: 'String', value: '0' },
    ];
    const xml = await this.callWithAuthRetry('GetMspConfigFile', params);
    const inner = this.extractEmbeddedPayload(xml, ['MSPConfig', 'Backyard']);
    if (!inner) {
      throw new Error('OmniLogic: unable to parse MSP config response.');
    }
    return this.buildTopology(mspSystemId, inner);
  }

  async getTelemetry(mspSystemId: number): Promise<TelemetrySnapshot> {
    await this.ensureLogin();
    const params: RequestParameter[] = [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
    ];
    const xml = await this.callWithAuthRetry('GetTelemetryData', params);
    const inner =
      this.extractEmbeddedPayload(xml, ['STATUS', 'Status', 'Backyard']) ??
      this.parser.parse(xml);
    const byId = new Map<number, any>();
    this.collectTelemetryNodes(inner, byId);
    return { timestamp: Date.now(), byId, raw: inner };
  }

  async setHeaterEnable(
    mspSystemId: number,
    bowId: number,
    heaterId: number,
    enabled: boolean,
  ): Promise<void> {
    const params: RequestParameter[] = [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'HeaterID', dataType: 'int', value: heaterId },
      { name: 'Version', dataType: 'String', value: '0' },
      { name: 'HeaterEnable', dataType: 'bool', value: enabled },
    ];
    await this.callMutation('SetHeaterEnable', params);
  }

  async setHeaterSetpoint(
    mspSystemId: number,
    bowId: number,
    heaterId: number,
    temperature: number,
  ): Promise<void> {
    const params: RequestParameter[] = [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'HeaterID', dataType: 'int', value: heaterId },
      { name: 'Version', dataType: 'String', value: '0' },
      { name: 'Temp', dataType: 'int', value: Math.round(temperature) },
    ];
    await this.callMutation('SetUIHeaterCmd', params);
  }

  async setEquipmentState(
    mspSystemId: number,
    bowId: number,
    equipmentId: number,
    on: boolean,
  ): Promise<void> {
    const params: RequestParameter[] = [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'EquipmentID', dataType: 'int', value: equipmentId },
      { name: 'IsOn', dataType: 'int', value: on ? 100 : 0 },
      { name: 'IsCountDownTimer', dataType: 'bool', value: false },
      { name: 'StartTimeHours', dataType: 'int', value: 0 },
      { name: 'StartTimeMinutes', dataType: 'int', value: 0 },
      { name: 'EndTimeHours', dataType: 'int', value: 0 },
      { name: 'EndTimeMinutes', dataType: 'int', value: 0 },
      { name: 'DaysActive', dataType: 'int', value: 0 },
      { name: 'Recurring', dataType: 'bool', value: false },
    ];
    await this.callMutation('SetUIEquipmentCmd', params);
  }

  async setFilterSpeed(
    mspSystemId: number,
    bowId: number,
    filterId: number,
    speedPercent: number,
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(speedPercent)));
    const params: RequestParameter[] = [
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
    ];
    await this.callMutation('SetUIFilterSpeedCmd', params);
  }

  async setLightShow(
    mspSystemId: number,
    bowId: number,
    lightId: number,
    show: number,
  ): Promise<void> {
    const params: RequestParameter[] = [
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
    ];
    await this.callMutation('SetStandAloneLightShow', params);
  }

  // ----- internals ---------------------------------------------------------

  /**
   * Run a SET-style mutation: re-login on auth failure, validate Status.
   */
  private async callMutation(
    name: string,
    params: RequestParameter[],
  ): Promise<void> {
    const xml = await this.callWithAuthRetry(name, params);
    const status = this.firstNumber(this.extractParameters(xml), 'Status');
    if (status !== null && status !== 0) {
      throw new Error(`OmniLogic ${name} failed (Status=${status}).`);
    }
  }

  /**
   * Make a request; if it appears to be an auth failure, force re-login and
   * retry once. We bound retries to one attempt so a hard credential error
   * surfaces quickly instead of looping.
   */
  private async callWithAuthRetry(
    name: string,
    params: RequestParameter[],
  ): Promise<string> {
    await this.ensureLogin();
    const withFreshToken = (p: RequestParameter[]) =>
      p.map((x) =>
        x.name === 'Token'
          ? { ...x, value: this.token ?? '' }
          : x,
      );

    const tryOnce = async () => this.post(this.buildRequest(name, withFreshToken(params)), name);

    let xml = await tryOnce();
    if (this.isAuthFailure(xml)) {
      this.log.debug(`OmniLogic: ${name} got auth failure, refreshing token.`);
      this.tokenExpiresAt = 0;
      this.token = null;
      if (this.tokenStore) {
        await this.tokenStore.clear();
      }
      await this.login();
      xml = await tryOnce();
    }
    return xml;
  }

  private isAuthFailure(xml: string): boolean {
    // The cloud returns various Status codes for token problems; we don't
    // have a full enumeration, but the text "Token" or "Login" inside a
    // Fault/Error block is a reliable hint.
    if (!/<(Status|StatusCode)>\s*[1-9]/i.test(xml)) {
      return false;
    }
    return /Token|Login|Unauthorized|Authentication/i.test(xml);
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

  private async post(body: string, opName: string): Promise<string> {
    if (this.debug) {
      this.log.debug(`OmniLogic ${opName} request:\n` + this.redact(body));
    }
    try {
      const resp = await this.http.post('', body);
      const text =
        typeof resp.data === 'string' ? resp.data : String(resp.data);
      if (this.debug) {
        this.log.debug(`OmniLogic ${opName} response:\n` + this.redact(text));
      }
      return text;
    } catch (err: any) {
      const detail = err?.response?.data
        ? typeof err.response.data === 'string'
          ? err.response.data.slice(0, 300)
          : JSON.stringify(err.response.data).slice(0, 300)
        : err?.code || err?.message;
      throw new Error(
        `OmniLogic ${opName} request failed: ${this.redact(String(detail))}`,
      );
    }
  }

  /**
   * Mask password/token values in any XML we log or include in errors.
   * Matches the secret-bearing <Parameter> elements regardless of dataType.
   */
  private redact(xml: string): string {
    if (!xml) return xml;
    let out = xml;
    // Match <Parameter ... name="Password" ... >...</Parameter> regardless of
    // attribute order. Restrict the body to non-`<` characters so we can't
    // swallow more than one element if the response is malformed.
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

  private extractParameters(xml: string): any[] {
    const parsed = this.parser.parse(xml);
    const params = this.deepFind(parsed, 'Parameter');
    if (!params) return [];
    return Array.isArray(params) ? params : [params];
  }

  private firstString(params: any[], name: string): string | null {
    const p = params.find((x) => x?.['@_name'] === name);
    if (p == null) return null;
    if (typeof p !== 'object') return String(p);
    const raw = '#text' in p ? p['#text'] : undefined;
    return raw == null ? null : String(raw);
  }

  private firstNumber(params: any[], name: string): number | null {
    const v = this.firstString(params, name);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * The MSP config and telemetry responses both nest the meaningful payload
   * inside a string-typed Parameter. We try both forms: an element child
   * that matches one of `roots`, or the parameter's #text content re-parsed
   * as XML.
   */
  private extractEmbeddedPayload(
    xml: string,
    roots: string[],
  ): any | undefined {
    const parsed = this.parser.parse(xml);
    for (const root of roots) {
      const direct = this.deepFind(parsed, root);
      if (direct !== undefined) return direct;
    }
    // Look for a Parameter whose value is XML text.
    const params = this.deepFind(parsed, 'Parameter');
    const arr = Array.isArray(params) ? params : params ? [params] : [];
    for (const p of arr) {
      const text = typeof p === 'object' ? p?.['#text'] : undefined;
      if (typeof text !== 'string') continue;
      if (!text.trimStart().startsWith('<')) continue;
      try {
        const subParsed = this.parser.parse(text);
        for (const root of roots) {
          const found = this.deepFind(subParsed, root);
          if (found !== undefined) return found;
        }
      } catch {
        // not parseable XML, ignore
      }
    }
    return undefined;
  }

  private buildTopology(mspSystemId: number, mspNode: any): BackyardTopology {
    const backyard = this.deepFind(mspNode, 'Backyard') ?? mspNode;
    const backyardName = String(this.deepFind(backyard, 'Name') ?? 'Backyard');

    const bowNodes = [
      ...this.collectArray(backyard, 'Body-of-water'),
      ...this.collectArray(backyard, 'BodyOfWater'),
    ];

    const bows: BodyOfWater[] = bowNodes.map((bow) => ({
      systemId: this.readSystemId(bow),
      name: String(this.deepFind(bow, 'Name') ?? 'Body of Water'),
      type: String(this.deepFind(bow, 'Type') ?? 'BOW_POOL'),
      heaters: this.collectEquipment(bow, ['Heater']),
      filters: this.collectEquipment(bow, ['Filter']),
      pumps: this.collectEquipment(bow, ['Pump']),
      lights: this.collectEquipment(bow, ['ColorLogic-Light', 'Light']),
      chlorinators: this.collectEquipment(bow, ['Chlorinator']),
      relays: this.collectEquipment(bow, ['Relay']),
    }));

    return { mspSystemId, backyardName, bows, rawMsp: mspNode };
  }

  private collectEquipment(parent: any, tags: string[]): EquipmentRef[] {
    const out: EquipmentRef[] = [];
    for (const tag of tags) {
      for (const n of this.collectArray(parent, tag)) {
        const systemId = this.readSystemId(n);
        if (!Number.isFinite(systemId) || systemId <= 0) continue;
        out.push({
          systemId,
          name: String(this.deepFind(n, 'Name') ?? tag),
          raw: n,
        });
      }
    }
    return out;
  }

  private readSystemId(node: any): number {
    const raw =
      this.deepFind(node, 'System-Id') ??
      this.deepFind(node, 'SystemId') ??
      this.deepFind(node, 'systemId') ??
      0;
    return Number(raw);
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
