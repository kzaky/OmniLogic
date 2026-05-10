import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLL_SECONDS } from './settings';
import {
  OmniLogicApi,
  TelemetrySnapshot,
  BackyardTopology,
} from './omnilogic-api';
import { AccessoryContext, OmniLogicPlatformConfig } from './types';
import { TokenStore } from './token-store';
import { HeaterAccessory } from './accessories/heater-accessory';
import { LightAccessory } from './accessories/light-accessory';
import { SwitchAccessory } from './accessories/switch-accessory';
import { FilterPumpAccessory } from './accessories/filter-pump-accessory';
import { TemperatureSensorAccessory } from './accessories/temperature-sensor-accessory';
import { BaseAccessory } from './accessories/base-accessory';

export class OmniLogicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory<AccessoryContext>[] = [];
  private readonly handlers = new Map<string, BaseAccessory>();

  public readonly api: OmniLogicApi;
  public readonly config: OmniLogicPlatformConfig;
  public readonly log: Logger;
  public latestTelemetry: TelemetrySnapshot | null = null;
  public topology: BackyardTopology | null = null;

  private pollTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private mspSystemId: number | null = null;
  private shuttingDown = false;
  private hiddenIds: Set<number>;

  constructor(
    realLog: Logger,
    config: OmniLogicPlatformConfig,
    public readonly hbApi: API,
  ) {
    this.Service = hbApi.hap.Service;
    this.Characteristic = hbApi.hap.Characteristic;
    this.config = config;
    this.log = makeLogger(realLog, !!config?.disableLogs);
    this.hiddenIds = new Set(config?.hideEquipmentIds ?? []);

    if (!config?.username || !config?.password) {
      this.log.error(
        'OmniLogic: username and password are required in config.json. Plugin disabled.',
      );
      this.api = new OmniLogicApi('', '', this.log);
      return;
    }

    const tokenStore = new TokenStore(hbApi.user.persistPath(), this.log);
    this.api = new OmniLogicApi(
      config.username,
      config.password,
      this.log,
      !!config.debug,
      tokenStore,
    );

    hbApi.on('didFinishLaunching', () => {
      this.discoverWithBackoff();
    });

    hbApi.on('shutdown', () => {
      this.shuttingDown = true;
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
    });
  }

  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.accessories.push(accessory);
  }

  scheduleTelemetryRefresh(): void {
    if (this.shuttingDown || this.mspSystemId == null) return;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshTelemetry().catch((err) => {
        this.log.debug('OmniLogic post-set refresh failed:', err.message);
      });
    }, 1500);
  }

  private async refreshTelemetry(): Promise<void> {
    if (this.mspSystemId == null) return;
    const snap = await this.api.getTelemetry(this.mspSystemId);
    this.broadcast(snap);
  }

  private broadcast(snap: TelemetrySnapshot): void {
    this.latestTelemetry = snap;
    for (const handler of this.handlers.values()) {
      try {
        handler.onTelemetry(snap);
      } catch (err: any) {
        this.log.debug('Telemetry handler threw:', err.message);
      }
    }
  }

  /**
   * Run discovery, retrying with exponential backoff on failure. Many
   * Homebridge restarts happen overnight when the Hayward cloud may be
   * briefly down; we don't want a transient failure to permanently
   * disable the plugin until the next restart.
   */
  private discoverWithBackoff(): void {
    let attempt = 0;
    const run = async () => {
      if (this.shuttingDown) return;
      try {
        await this.discover();
      } catch (err: any) {
        if (this.shuttingDown) return;
        const delay = Math.min(5_000 * 2 ** attempt, 300_000);
        attempt += 1;
        this.log.error(
          `OmniLogic discovery failed (${err.message}). Retrying in ${Math.round(
            delay / 1000,
          )}s.`,
        );
        setTimeout(run, delay);
      }
    };
    run();
  }

  private async discover(): Promise<void> {
    await this.api.login();
    const site = await this.api.getSiteList();
    this.mspSystemId = site.mspSystemId;
    this.log.info(
      `OmniLogic: found site "${site.backyardName}" (MspSystemID=${site.mspSystemId}).`,
    );
    const topology = await this.api.getMspConfig(site.mspSystemId);
    this.topology = topology;
    this.logEquipmentInventory(topology);

    try {
      this.latestTelemetry = await this.api.getTelemetry(site.mspSystemId);
    } catch (err: any) {
      this.log.warn('OmniLogic: initial telemetry fetch failed:', err.message);
    }

    const desired = this.buildDesiredAccessories(topology);
    this.syncAccessories(desired);
    this.startPolling();
  }

  /**
   * Print the discovered topology so users can copy IDs into
   * `hideEquipmentIds` if they want to suppress an accessory.
   */
  private logEquipmentInventory(topology: BackyardTopology): void {
    this.log.info(
      `OmniLogic: discovered ${topology.bows.length} body(s) of water:`,
    );
    for (const bow of topology.bows) {
      this.log.info(`  ${bow.name} (BoW id=${bow.systemId}):`);
      for (const [kind, list] of [
        ['Heater', bow.heaters],
        ['Filter', bow.filters],
        ['Pump', bow.pumps],
        ['Light', bow.lights],
        ['Chlorinator', bow.chlorinators],
        ['Relay', bow.relays],
      ] as const) {
        for (const e of list) {
          this.log.info(`    ${kind} "${e.name}" id=${e.systemId}`);
        }
      }
    }
  }

  private buildDesiredAccessories(
    topology: BackyardTopology,
  ): AccessoryContext[] {
    const result: AccessoryContext[] = [];
    const cfg = this.config;
    const hidden = this.hiddenIds;
    const keep = (id: number) => !hidden.has(id);

    for (const bow of topology.bows) {
      if (cfg.exposeHeaters !== false) {
        for (const h of bow.heaters.filter((e) => keep(e.systemId))) {
          result.push({
            kind: 'heater',
            mspSystemId: topology.mspSystemId,
            bowId: bow.systemId,
            equipmentId: h.systemId,
            bowName: bow.name,
            name: `${bow.name} Heater`,
          });
        }
      }
      if (cfg.exposeLights !== false) {
        for (const l of bow.lights.filter((e) => keep(e.systemId))) {
          result.push({
            kind: 'light',
            mspSystemId: topology.mspSystemId,
            bowId: bow.systemId,
            equipmentId: l.systemId,
            bowName: bow.name,
            name: l.name || `${bow.name} Light`,
          });
        }
      }
      if (cfg.exposePumps !== false) {
        for (const f of bow.filters.filter((e) => keep(e.systemId))) {
          result.push({
            kind: 'filter',
            mspSystemId: topology.mspSystemId,
            bowId: bow.systemId,
            equipmentId: f.systemId,
            bowName: bow.name,
            name: f.name || `${bow.name} Pump`,
          });
        }
        for (const p of bow.pumps.filter((e) => keep(e.systemId))) {
          result.push({
            kind: 'pump',
            mspSystemId: topology.mspSystemId,
            bowId: bow.systemId,
            equipmentId: p.systemId,
            bowName: bow.name,
            name: p.name || `${bow.name} Pump`,
          });
        }
      }
      if (cfg.exposeChlorinator !== false) {
        for (const c of bow.chlorinators.filter((e) => keep(e.systemId))) {
          result.push({
            kind: 'chlorinator',
            mspSystemId: topology.mspSystemId,
            bowId: bow.systemId,
            equipmentId: c.systemId,
            bowName: bow.name,
            name: c.name || `${bow.name} Chlorinator`,
          });
        }
      }
      if (keep(bow.systemId)) {
        result.push({
          kind: 'temperature',
          mspSystemId: topology.mspSystemId,
          bowId: bow.systemId,
          equipmentId: bow.systemId,
          bowName: bow.name,
          name: `${bow.name} Water Temperature`,
        });
      }
    }
    return result;
  }

  private syncAccessories(desired: AccessoryContext[]): void {
    const desiredByUuid = new Map<string, AccessoryContext>();
    for (const ctx of desired) {
      desiredByUuid.set(this.uuidFor(ctx), ctx);
    }

    for (const [uuid, ctx] of desiredByUuid) {
      const existing = this.accessories.find((a) => a.UUID === uuid);
      if (existing) {
        existing.context = ctx;
        existing.displayName = ctx.name;
        this.bindHandler(existing);
        this.hbApi.updatePlatformAccessories([existing]);
      } else {
        const accessory = new this.hbApi.platformAccessory<AccessoryContext>(
          ctx.name,
          uuid,
        );
        accessory.context = ctx;
        this.bindHandler(accessory);
        this.hbApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        this.accessories.push(accessory);
      }
    }

    const stale = this.accessories.filter((a) => !desiredByUuid.has(a.UUID));
    if (stale.length) {
      this.hbApi.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        stale,
      );
      for (const s of stale) {
        const idx = this.accessories.indexOf(s);
        if (idx >= 0) this.accessories.splice(idx, 1);
        this.handlers.delete(s.UUID);
      }
    }
  }

  private bindHandler(
    accessory: PlatformAccessory<AccessoryContext>,
  ): void {
    if (this.handlers.has(accessory.UUID)) return;
    const ctx = accessory.context;
    let handler: BaseAccessory | undefined;
    switch (ctx.kind) {
      case 'heater':
        handler = new HeaterAccessory(this, accessory);
        break;
      case 'light':
        handler = new LightAccessory(this, accessory);
        break;
      case 'filter':
        handler = new FilterPumpAccessory(this, accessory);
        break;
      case 'pump':
      case 'chlorinator':
        handler = new SwitchAccessory(this, accessory);
        break;
      case 'temperature':
        handler = new TemperatureSensorAccessory(this, accessory);
        break;
    }
    if (handler) this.handlers.set(accessory.UUID, handler);
  }

  private startPolling(): void {
    const seconds = Math.max(
      15,
      this.config.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS,
    );
    this.pollTimer = setInterval(async () => {
      try {
        await this.refreshTelemetry();
      } catch (err: any) {
        this.log.debug('OmniLogic telemetry poll failed:', err.message);
      }
    }, seconds * 1000);
  }

  private uuidFor(ctx: AccessoryContext): string {
    return this.hbApi.hap.uuid.generate(
      `omnilogic:${ctx.mspSystemId}:${ctx.bowId}:${ctx.equipmentId}:${ctx.kind}`,
    );
  }
}

function makeLogger(realLog: Logger, disable: boolean): Logger {
  if (!disable) return realLog;
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    log: noop,
  } as unknown as Logger;
}
