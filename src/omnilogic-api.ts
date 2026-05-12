import axios, { AxiosInstance } from 'axios';
import { Logger } from 'homebridge';
import {
  OMNILOGIC_APP_ID,
  OMNILOGIC_AUTH_URL,
  OMNILOGIC_DATA_URL,
  OMNILOGIC_REFRESH_URL,
  REQUEST_TIMEOUT_MS,
} from './settings';
import { TokenStore } from './token-store';
import {
  BackyardTopology,
  RequestParameter,
  buildRequestXml,
  buildTopology,
  collectTelemetryNodes,
  deepFind,
  extractEmbeddedPayload,
  extractParameters,
  firstNumber,
  firstString,
  namedChildren,
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

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

const NO_SCHEDULE: RequestParameter[] = [
  { name: 'IsCountDownTimer', dataType: 'bool', value: false },
  { name: 'StartTimeHours', dataType: 'int', value: 0 },
  { name: 'StartTimeMinutes', dataType: 'int', value: 0 },
  { name: 'EndTimeHours', dataType: 'int', value: 0 },
  { name: 'EndTimeMinutes', dataType: 'int', value: 0 },
  { name: 'DaysActive', dataType: 'int', value: 0 },
  { name: 'Recurring', dataType: 'bool', value: false },
];

/**
 * Client for the Hayward OmniLogic Home Automation Service.
 *
 * Auth lives at services-gamma.haywardcloud.net (REST/JSON), data lives at
 * www.haywardomnilogic.com/HAAPI/.../API.ashx (XML POST). The `Token` and
 * `SiteID` are sent as HTTP headers; the request body is a plain
 * `<Request>...</Request>` XML doc with no SOAP envelope. See
 * djtimca/omnilogic-api for the reference implementation.
 */
export class OmniLogicApi {
  private readonly data: AxiosInstance;
  private readonly auth: AxiosInstance;

  private token: string | null = null;
  private refreshTokenValue: string | null = null;
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
    this.data = axios.create({
      baseURL: OMNILOGIC_DATA_URL,
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: () => true,
    });
    this.auth = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-HAYWARD-APP-ID': OMNILOGIC_APP_ID,
      },
    });
  }

  async ensureLogin(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) return;
    if (!this.cacheLoaded && this.tokenStore) {
      this.cacheLoaded = true;
      const cached = await this.tokenStore.load(this.username);
      if (cached) {
        this.token = cached.token;
        this.refreshTokenValue = cached.refreshToken;
        this.userId = cached.userId;
        this.tokenExpiresAt = cached.expiresAt;
        this.log.info('OmniLogic: restored cached session token.');
        if (Date.now() < this.tokenExpiresAt) return;
      }
    }
    if (this.refreshTokenValue) {
      try {
        await this.doRefresh();
        return;
      } catch (err: any) {
        this.log.debug(
          `OmniLogic: token refresh failed (${err.message}); falling back to full login.`,
        );
      }
    }
    await this.login();
  }

  private async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const resp = await this.auth.post(OMNILOGIC_AUTH_URL, {
      email: this.username,
      password: this.password,
    });
    this.applyAuthResponse(resp.data, 'login');
  }

  private async doRefresh(): Promise<void> {
    const resp = await this.auth.post(OMNILOGIC_REFRESH_URL, {
      refresh_token: this.refreshTokenValue,
    });
    this.applyAuthResponse(resp.data, 'refresh');
  }

  private applyAuthResponse(data: any, source: 'login' | 'refresh'): void {
    if (this.debug) {
      const keys = data && typeof data === 'object' ? Object.keys(data) : [];
      this.log.info(`OmniLogic ${source} response keys: ${keys.join(', ')}`);
    }
    const token = coerceString(data?.token);
    const refreshToken = coerceString(data?.refreshToken);
    const userId = coerceString(data?.userID ?? data?.userId);
    if (!token) {
      throw new Error(`OmniLogic auth (${source}) returned no token.`);
    }
    this.token = token;
    this.refreshTokenValue = refreshToken ?? this.refreshTokenValue;
    this.userId = userId ?? this.userId;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    this.log.info(
      `OmniLogic: ${source} succeeded (userId=${this.userId ?? '<missing>'}).`,
    );

    if (this.tokenStore) {
      void this.tokenStore.save({
        v: 3,
        token,
        refreshToken: this.refreshTokenValue,
        userId: this.userId,
        expiresAt: this.tokenExpiresAt,
        username: this.username,
      });
    }
  }

  async getSiteList(): Promise<{ mspSystemId: number; backyardName: string }> {
    await this.ensureLogin();
    const xml = await this.callWithAuthRetry('GetSiteList', [
      { name: 'UserID', dataType: 'String', value: this.userId ?? '' },
    ]);
    const parsed = parseXml(xml);
    const items = deepFind(parsed, 'Item');
    const item = Array.isArray(items) ? items[0] : items;
    if (!item) {
      this.log.warn(
        'OmniLogic GetSiteList response (first 1000 chars, redacted):\n' +
          redactXml(xml).slice(0, 1000),
      );
      throw new Error('OmniLogic: no sites found on this account.');
    }
    const fields = namedChildren(item);
    const mspSystemId =
      firstNumber(fields, 'MspSystemID') ?? firstNumber(fields, 'MspSystemId');
    if (mspSystemId == null) {
      this.log.warn(
        'OmniLogic GetSiteList item missing MspSystemID (first 1000 chars):\n' +
          redactXml(xml).slice(0, 1000),
      );
      throw new Error('OmniLogic: site list response missing MspSystemID.');
    }
    const backyardName = firstString(fields, 'BackyardName') ?? 'OmniLogic';
    return { mspSystemId, backyardName };
  }

  async getMspConfig(mspSystemId: number): Promise<BackyardTopology> {
    await this.ensureLogin();
    const xml = await this.callWithAuthRetry('GetMspConfigFile', [
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
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'HeaterID', dataType: 'int', value: heaterId },
      { name: 'Version', dataType: 'String', value: '0' },
      { name: 'Enabled', dataType: 'bool', value: enabled },
    ]);
  }

  async setHeaterSetpoint(
    mspSystemId: number,
    bowId: number,
    heaterId: number,
    temperature: number,
  ): Promise<void> {
    await this.callMutation('SetUIHeaterCmd', [
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
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'EquipmentID', dataType: 'int', value: equipmentId },
      { name: 'IsOn', dataType: 'int', value: on ? 100 : 0 },
      ...NO_SCHEDULE,
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
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'FilterID', dataType: 'int', value: filterId },
      { name: 'Speed', dataType: 'int', value: clamped },
      ...NO_SCHEDULE,
    ]);
  }

  async setLightShow(
    mspSystemId: number,
    bowId: number,
    lightId: number,
    show: number,
  ): Promise<void> {
    await this.callMutation('SetStandAloneLightShow', [
      { name: 'MspSystemID', dataType: 'int', value: mspSystemId },
      { name: 'PoolID', dataType: 'int', value: bowId },
      { name: 'LightID', dataType: 'int', value: lightId },
      { name: 'Show', dataType: 'byte', value: show },
      { name: 'Speed', dataType: 'byte', value: 4 },
      { name: 'Brightness', dataType: 'byte', value: 4 },
      { name: 'Reserved', dataType: 'byte', value: 0 },
      ...NO_SCHEDULE,
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
    const tryOnce = () => this.post(name, params);

    let { status, body } = await tryOnce();
    if (status === 401 || status === 403) {
      this.log.debug(`OmniLogic: ${name} got HTTP ${status}, refreshing token.`);
      await this.invalidateTokenAndReauth();
      ({ status, body } = await tryOnce());
    }
    if (status < 200 || status >= 300) {
      throw new Error(
        `OmniLogic ${name} failed with HTTP ${status}: ${redactXml(body).slice(0, 300)}`,
      );
    }
    return body;
  }

  private async invalidateTokenAndReauth(): Promise<void> {
    this.tokenExpiresAt = 0;
    this.token = null;
    if (this.tokenStore) await this.tokenStore.clear();
    if (this.refreshTokenValue) {
      try {
        await this.doRefresh();
        return;
      } catch {
        this.refreshTokenValue = null;
      }
    }
    await this.login();
  }

  private async post(
    name: string,
    params: RequestParameter[],
  ): Promise<{ status: number; body: string }> {
    const body = buildRequestXml(name, params);
    const headers: Record<string, string> = {
      'Content-Type': 'text/xml',
      'cache-control': 'no-cache',
    };
    if (this.token) headers['Token'] = this.token;
    const siteParam = params.find((p) => p.name === 'MspSystemID');
    if (siteParam !== undefined) headers['SiteID'] = String(siteParam.value);

    if (this.debug) {
      this.log.info(`OmniLogic ${name} request:\n` + redactXml(body));
    }
    try {
      const resp = await this.data.post('', body, { headers });
      const text =
        typeof resp.data === 'string' ? resp.data : String(resp.data);
      if (this.debug) {
        this.log.info(
          `OmniLogic ${name} response (HTTP ${resp.status}):\n` +
            redactXml(text),
        );
      }
      return { status: resp.status, body: text };
    } catch (err: any) {
      const detail = err?.code || err?.message || 'unknown error';
      throw new Error(`OmniLogic ${name} transport error: ${detail}`);
    }
  }
}

function coerceString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
