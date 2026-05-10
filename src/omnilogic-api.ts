import axios, { AxiosInstance } from 'axios';
import { Logger } from 'homebridge';
import { OMNILOGIC_ENDPOINT, REQUEST_TIMEOUT_MS } from './settings';
import { TokenStore } from './token-store';
import {
  BackyardTopology,
  RequestParameter,
  buildSoapRequest,
  buildTopology,
  collectTelemetryNodes,
  deepFind,
  extractEmbeddedPayload,
  extractParameters,
  firstNumber,
  firstString,
  isAuthFailureXml,
  parseXml,
  redactXml,
} from './xml-utils';

export {
  BackyardTopology,
  BodyOfWater,
  EquipmentRef,
} from './xml-utils';

export interface TelemetrySnapshot {
  timestamp: number;
  byId: Map<number, any>;
  raw: any;
}

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * SOAP client for the Hayward OmniLogic Home Automation Service.
 * Owns the HTTP transport, login state, and token cache. All pure
 * XML / SOAP work lives in xml-utils.
 */
export class OmniLogicApi {
  private readonly http: AxiosInstance;

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
    if (this.loginInFlight) {
      return this.loginInFlight;
    }
    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const body = buildSoapRequest('Login', [
      { name: 'UserName', dataType: 'String', value: this.username },
      { name: 'Password', dataType: 'String', value: this.password },
    ]);
    const xml = await this.post(body, 'Login');
    const params = extractParameters(xml);
    const status = firstNumber(params, 'Status');
    if (status !== 0 && status !== null) {
      throw new Error(
        `OmniLogic login failed (Status=${status}). Check username/password.`,
      );
    }
    const token = firstString(params, 'Token');
    if (!token) {
      throw new Error('OmniLogic login returned no token.');
    }
    this.token = token;
    this.userId =
      firstString(params, 'UserID') ?? firstString(params, 'UserId');
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
    const xml = await this.callWithAuthRetry('GetSiteList', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'UserID', dataType: 'String', value: this.userId ?? '' },
    ]);
    const parsed = parseXml(xml);
    const siteList =
      deepFind(parsed, 'Site') ?? deepFind(parsed, 'List');
    const site = Array.isArray(siteList) ? siteList[0] : siteList;
    if (!site) {
      throw new Error('OmniLogic: no sites found on this account.');
    }
    const mspSystemId = Number(
      deepFind(site, 'MspSystemID') ?? deepFind(site, 'MspSystemId'),
    );
    if (!Number.isFinite(mspSystemId)) {
      throw new Error('OmniLogic: site list response missing MspSystemID.');
    }
    const backyardName = String(deepFind(site, 'BackyardName') ?? 'OmniLogic');
    return { mspSystemId, backyardName };
  }

  async getMspConfig(mspSystemId: number): Promise<BackyardTopology> {
    await this.ensureLogin();
    const xml = await this.callWithAuthRetry('GetMspConfigFile', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'Version', dataType: 'String', value: '0' },
    ]);
    const inner = extractEmbeddedPayload(xml, ['MSPConfig', 'Backyard']);
    if (!inner) {
      throw new Error('OmniLogic: unable to parse MSP config response.');
    }
    return buildTopology(mspSystemId, inner);
  }

  async getTelemetry(mspSystemId: number): Promise<TelemetrySnapshot> {
    await this.ensureLogin();
    const xml = await this.callWithAuthRetry('GetTelemetryData', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
    ]);
    const inner =
      extractEmbeddedPayload(xml, ['STATUS', 'Status', 'Backyard']) ??
      parseXml(xml);
    const byId = collectTelemetryNodes(inner);
    return { timestamp: Date.now(), byId, raw: inner };
  }

  async setHeaterEnable(
    mspSystemId: number,
    bowId: number,
    heaterId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.callMutation('SetHeaterEnable', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'HeaterID', dataType: 'int', value: heaterId },
      { name: 'Version', dataType: 'String', value: '0' },
      { name: 'HeaterEnable', dataType: 'bool', value: enabled },
    ]);
  }

  async setHeaterSetpoint(
    mspSystemId: number,
    bowId: number,
    heaterId: number,
    temperature: number,
  ): Promise<void> {
    await this.callMutation('SetUIHeaterCmd', [
      { name: 'Token', dataType: 'String', value: this.token! },
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'HeaterID', dataType: 'int', value: heaterId },
      { name: 'Version', dataType: 'String', value: '0' },
      { name: 'Temp', dataType: 'int', value: Math.round(temperature) },
    ]);
  }

  async setEquipmentState(
    mspSystemId: number,
    bowId: number,
    equipmentId: number,
    on: boolean,
  ): Promise<void> {
    await this.callMutation('SetUIEquipmentCmd', [
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
    ]);
  }

  async setFilterSpeed(
    mspSystemId: number,
    bowId: number,
    filterId: number,
    speedPercent: number,
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(speedPercent)));
    await this.callMutation('SetUIFilterSpeedCmd', [
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
  }

  async setLightShow(
    mspSystemId: number,
    bowId: number,
    lightId: number,
    show: number,
  ): Promise<void> {
    await this.callMutation('SetStandAloneLightShow', [
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
  }

  // ----- internals ---------------------------------------------------------

  private async callMutation(
    name: string,
    params: RequestParameter[],
  ): Promise<void> {
    const xml = await this.callWithAuthRetry(name, params);
    const status = firstNumber(extractParameters(xml), 'Status');
    if (status !== null && status !== 0) {
      throw new Error(`OmniLogic ${name} failed (Status=${status}).`);
    }
  }

  private async callWithAuthRetry(
    name: string,
    params: RequestParameter[],
  ): Promise<string> {
    await this.ensureLogin();
    const withFreshToken = (p: RequestParameter[]) =>
      p.map((x) =>
        x.name === 'Token' ? { ...x, value: this.token ?? '' } : x,
      );

    const tryOnce = async () =>
      this.post(buildSoapRequest(name, withFreshToken(params)), name);

    let xml = await tryOnce();
    if (isAuthFailureXml(xml)) {
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

  private async post(body: string, opName: string): Promise<string> {
    if (this.debug) {
      this.log.debug(`OmniLogic ${opName} request:\n` + redactXml(body));
    }
    try {
      const resp = await this.http.post('', body);
      const text =
        typeof resp.data === 'string' ? resp.data : String(resp.data);
      if (this.debug) {
        this.log.debug(`OmniLogic ${opName} response:\n` + redactXml(text));
      }
      return text;
    } catch (err: any) {
      const detail = err?.response?.data
        ? typeof err.response.data === 'string'
          ? err.response.data.slice(0, 300)
          : JSON.stringify(err.response.data).slice(0, 300)
        : err?.code || err?.message;
      throw new Error(
        `OmniLogic ${opName} request failed: ${redactXml(String(detail))}`,
      );
    }
  }
}