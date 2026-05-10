import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLL_SECONDS } from './settings';
import { OmniLogicApi, TelemetrySnapshot, BackyardTopology } from './omnilogic-api';
import { AccessoryContext, OmniLogicPlatformConfig } from './types';
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
  public latestTelemetry: TelemetrySnapshot | null = null;
  public topology: BackyardTopology | null = null;

  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly log: Logger,
    config: OmniLogicPlatformConfig,
    public readonly hbApi: API,
  ) {
    this.Service = hbApi.hap.Service;
    this.Characteristic = hbApi.hap.Characteristic;
    this.config = config;

    if (!config?.username || !config?.password) {
      log.error(
        'OmniLogic: username and password are required in config.json. Plugin disabled.',
      );
      // Stub out API so accessor calls don't crash; nothing else will run.
      this.api = new OmniLogicApi('', '', log);
      return;
    }

    this.api = new OmniLogicApi(
      config.username,
      config.password,
      log,
      !!config.debug,
    );

    hbApi.on('didFinishLaunching', () => {
      this.discover().catch((err) => {
        this.log.error('OmniLogic discovery failed:', err.message);
      });
    });

    hbApi.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
    });
  }

  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.accessories.push(accessory);
  }

  private async discover(): Promise<void> {
    await this.api.login();
    const site = await this.api.getSiteList();
    this.log.info(
      `OmniLogic: found site "${site.backyardName}" (MspSystemID=${site.mspSystemId}).`,
    );
    const topology = await this.api.getMspConfig(site.mspSystemId);
    this.topology = topology;
    this.log.info(
      `OmniLogic: discovered ${topology.bows.length} body(s) of water.`,
    );

    // Prime telemetry before binding accessories so initial state is correct.
    try {
      this.latestTelemetry = await this.api.getTelemetry(site.mspSystemId);
    } catch (err: any) {
      this.log.warn('OmniLogic: initial telemetry fetch failed:', err.message);
    }

    const desired = this.buildDesiredAccessories(topology);
    this.syncAccessories(desired);
    this.startPolling(site.mspSystemId);
  }

  private buildDesiredAccessories(
    topology: BackyardTopology,
  ): AccessoryContext[] {
    const result: AccessoryContext[] = [];
    const cfg = this.config;

    for (const bow of topology.bows) {
      if (cfg.exposeHeaters !== false) {
        for (const h of bow.heaters) {
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
        for (const l of bow.lights) {
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
        for (const f of bow.filters) {
          result.push({
            kind: 'filter',
            mspSystemId: topology.mspSystemId,
            bowId: bow.systemId,
            equipmentId: f.systemId,
            bowName: bow.name,
            name: f.name || `${bow.name} Pump`,
          });
        }
        for (const p of bow.pumps) {
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
        for (const c of bow.chlorinators) {
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
      // Water temperature sensor uses BoW systemId itself.
      result.push({
        kind: 'temperature',
        mspSystemId: topology.mspSystemId,
        bowId: bow.systemId,
        equipmentId: bow.systemId,
        bowName: bow.name,
        name: `${bow.name} Water Temperature`,
      });
    }
    return result;
  }

  private syncAccessories(desired: AccessoryContext[]): void {
    const desiredByUuid = new Map<string, AccessoryContext>();
    for (const ctx of desired) {
      const uuid = this.uuidFor(ctx);
      desiredByUuid.set(uuid, ctx);
    }

    // Register / refresh
    for (const [uuid, ctx] of desiredByUuid) {
      const existing = this.accessories.find((a) => a.UUID === uuid);
      if (existing) {
        existing.context = ctx;
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

    // Remove stale
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
      }
    }
  }

  private bindHandler(
    accessory: PlatformAccessory<AccessoryContext>,
  ): void {
    const ctx = accessory.context;
    let handler: BaseAccessory;
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
      default:
        return;
    }
    this.handlers.set(accessory.UUID, handler);
  }

  private startPolling(mspSystemId: number): void {
    const seconds = Math.max(
      10,
      this.config.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS,
    );
    this.pollTimer = setInterval(async () => {
      try {
        const snap = await this.api.getTelemetry(mspSystemId);
        this.latestTelemetry = snap;
        for (const handler of this.handlers.values()) {
          handler.onTelemetry(snap);
        }
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
